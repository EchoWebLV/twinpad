import type { Quote } from "./record.js";

/** pump.fun initial virtual reserves (global config, unchanged since 2024). Only used for the pre-launch estimate. */
export const PUMP_VIRTUAL_SOL = 30;
export const PUMP_VIRTUAL_TOKENS = 1_073_000_000;
/** pump.fun protocol + creator fee on curve buys, bps. Estimate only; the launcher reads the real curve after create. */
export const PUMP_FEE_BPS = 125;
/** PumpPortal's fee on trade-local buys, bps, paid on top of the SOL spent. */
export const PUMPPORTAL_FEE_BPS = 50;
/** What a pump.fun buy of X SOL really costs the wallet: X × (1 + fees). Rent, tip and priority come out of SOL_GAS_BUDGET. */
export const BUY_FEE_RATE = (PUMP_FEE_BPS + PUMPPORTAL_FEE_BPS) / 10_000;
export const TOTAL_SUPPLY = 1_000_000_000;

/** Largest dev buy a wallet holding `sol` can pay for, keeping `reserve` for rent, tip and priority fees. */
export function affordableBuySol(sol: number, reserve = 0.01): number {
  return Math.max(0, round((sol - reserve) / (1 + BUY_FEE_RATE), 4));
}

/** Front (SOL) that funds a dev buy of `devBuy` once fees and the gas budget are added back. */
export function frontForDevBuy(devBuy: number, solGasBudget: number): number {
  return round(devBuy * (1 + BUY_FEE_RATE) + solGasBudget, 4);
}

/** Tokens received and resulting fdv (in SOL) when `sol` (gross) buys a fresh pump.fun curve. */
export function pumpLanding(sol: number, feeBps = PUMP_FEE_BPS) {
  const net = sol * (1 - feeBps / 10_000);
  const k = PUMP_VIRTUAL_SOL * PUMP_VIRTUAL_TOKENS;
  const q = PUMP_VIRTUAL_SOL + net;
  const t = k / q;
  const tokens = PUMP_VIRTUAL_TOKENS - t;
  return { tokens, fdvSol: (q / t) * TOTAL_SUPPLY, net };
}

/**
 * Net quote needed so a constant-product curve with reserves (quote Q, tokens T) reaches
 * spot price targetFdv / supply. 0 when the target is at or below spot.
 */
export function quoteNetForFdv(Q: number, T: number, supply: number, targetFdv: number): number {
  const p = targetFdv / supply;
  const need = Math.sqrt(p * Q * T) - Q;
  return need > 0 ? need : 0;
}

export function grossFromNet(net: number, feeBps: number, taxBps: number) {
  return net / (1 - (feeBps + taxBps) / 10_000);
}

/** Tokens out of a constant-product curve for a net quote amount. */
export function tokensOut(Q: number, T: number, net: number) {
  return T - (Q * T) / (Q + net);
}

export interface FrontLimits { sol: number; eth: number }

/**
 * What the pool fronts one launch: an equal share of what is free above the floor for the open
 * maker slots, clamped to [min, max]. Pure; the caller measures `free`.
 */
export function sizeFront(free: { sol: number; eth: number; slots: number }, min: FrontLimits, max: FrontLimits): FrontLimits {
  const slots = Math.max(1, Math.floor(free.slots));
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  return { sol: round(clamp(free.sol / slots, min.sol, max.sol), 4), eth: round(clamp(free.eth / slots, min.eth, max.eth), 6) };
}

/**
 * Gross dev buy (SOL) that lands a fresh pump.fun curve at `fdvUsd`, e.g. the Pons floor
 * (phantom ETH × ETH price). 0 when the curve already opens above it.
 */
export function parityDevBuySol(fdvUsd: number, solUsd: number, feeBps = PUMP_FEE_BPS): number {
  if (!(fdvUsd > 0) || !(solUsd > 0)) return 0;
  const fdvSol = fdvUsd / solUsd;
  const k = PUMP_VIRTUAL_SOL * PUMP_VIRTUAL_TOKENS;
  const q = Math.sqrt((fdvSol * k) / TOTAL_SUPPLY);
  const net = q - PUMP_VIRTUAL_SOL;
  return net > 0 ? round(net / (1 - feeBps / 10_000), 4) : 0;
}

export interface QuoteInputs {
  depositSol: number;
  frontSol: number;
  frontEth: number;
  /** Deployer's extra dev buy, on top of frontSol. */
  boostSol?: number;
  solGasBudget: number;
  evmMakerCash: number;
  fx: { SOL: number; ETH: number };
  pons: { phantomEth: number; supply: number; feeBps: number; creatorTaxBps: number };
}

/** Pre-launch sizing shown to the deployer and stored on the record. */
export function buildQuote(i: QuoteInputs): Quote {
  const boostSol = round(i.boostSol ?? 0, 6);
  // The maker holds front + boost − creator share; the buy costs devBuy × (1 + fees), so size it from what is spendable.
  const devBuySol = Math.max(0, round((i.frontSol + boostSol - i.solGasBudget) / (1 + BUY_FEE_RATE), 4));
  const pump = pumpLanding(devBuySol);
  const targetUsd = pump.fdvSol * i.fx.SOL;
  const targetEth = targetUsd / i.fx.ETH;
  const net = quoteNetForFdv(i.pons.phantomEth, i.pons.supply, i.pons.supply, targetEth);
  const wanted = grossFromNet(net, i.pons.feeBps, i.pons.creatorTaxBps);
  const maxEth = Math.max(0, i.frontEth - i.evmMakerCash);
  const ponsEth = round(Math.min(wanted, maxEth), 6);
  const ponsNet = ponsEth * (1 - (i.pons.feeBps + i.pons.creatorTaxBps) / 10_000);
  const ponsTokens = tokensOut(i.pons.phantomEth, i.pons.supply, ponsNet);
  const ponsFdvEth = ((i.pons.phantomEth + ponsNet) ** 2 / (i.pons.phantomEth * i.pons.supply)) * i.pons.supply;
  return {
    depositSol: i.depositSol,
    depositEth: round((i.depositSol * i.fx.SOL) / i.fx.ETH, 6),
    frontSol: i.frontSol,
    frontEth: i.frontEth,
    devBuySol,
    pumpTokens: Math.round(pump.tokens),
    ponsEth,
    ponsTokens: Math.round(ponsTokens),
    makerCashEth: round(i.frontEth - ponsEth, 6),
    boostSol,
    parityDevBuySol: parityDevBuySol(i.pons.phantomEth * i.fx.ETH, i.fx.SOL),
    openingFdv: Math.round(targetUsd),
    landing: { pump: Math.round(targetUsd), pons: Math.round(ponsFdvEth * i.fx.ETH) },
    supplyPct: { pump: round((100 * pump.tokens) / TOTAL_SUPPLY, 2), pons: round((100 * ponsTokens) / i.pons.supply, 2) },
    fx: i.fx,
  };
}

function round(n: number, d: number) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
