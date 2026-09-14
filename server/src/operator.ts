import { Keypair } from "@solana/web3.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { newRecord, transition, type LaunchRecord, type OperatorLaunch, type Quote } from "./record.js";
import { approve } from "./scheduler.js";
import { pinToken, validateToken, type CreateDeps } from "./paid.js";
import { BUY_FEE_RATE, PUMP_FEE_BPS, PUMP_VIRTUAL_SOL, PUMP_VIRTUAL_TOKENS, TOTAL_SUPPLY, grossFromNet, parityDevBuySol, tokensOut } from "./quote.js";

/**
 * Operator launch: the pool bundles a locked allocation (lockPct of supply, bought first on each chain from a
 * lock wallet the maker never trades) and the peg's opening position (bundleSol on pump.fun, ponsEth on Pons) in
 * the same launch, and the coin lands on the site with the exit timer already set to keep. The lock wallets are
 * left alone by every sweep and by the close.
 */
export interface OperatorInput {
  lockPct: number;
  bundleSol: number;
  ponsEth: number;
  cashSol: number;
  cashEth: number;
  maxLossUsd: number | null;
}

export const OPERATOR_LIMITS = { lockPctMax: 40, bundleSolMax: 200, ponsEthMax: 5, cashSolMax: 20, cashEthMax: 1 };
/** Lock wallet extras: rent + fees on Solana, gas on Robinhood. */
export const LOCK_SOL_EXTRA = 0.01;
export const LOCK_ETH_EXTRA = 0.001;

export function validateOperatorInput(raw: unknown): OperatorInput {
  const i = (raw ?? {}) as Record<string, unknown>;
  const num = (k: string, max: number, min = 0) => {
    const v = i[k] == null || i[k] === "" ? 0 : Number(i[k]);
    if (!Number.isFinite(v) || v < min) throw new Error(`${k} must be a number ≥ ${min}`);
    if (v > max) throw new Error(`${k} max ${max}`);
    return v;
  };
  const lockPct = Math.round(num("lockPct", OPERATOR_LIMITS.lockPctMax) * 100) / 100;
  const bundleSol = Math.round(num("bundleSol", OPERATOR_LIMITS.bundleSolMax) * 1e4) / 1e4;
  const ponsEth = Math.round(num("ponsEth", OPERATOR_LIMITS.ponsEthMax) * 1e6) / 1e6;
  const cashSol = Math.round(num("cashSol", OPERATOR_LIMITS.cashSolMax) * 1e4) / 1e4;
  const cashEth = Math.round(num("cashEth", OPERATOR_LIMITS.cashEthMax) * 1e6) / 1e6;
  if (bundleSol <= 0) throw new Error("bundleSol must be above 0");
  if (ponsEth <= 0) throw new Error("ponsEth must be above 0");
  let maxLossUsd: number | null = null;
  if (i.maxLossUsd != null && i.maxLossUsd !== "") {
    const v = Number(i.maxLossUsd);
    if (!Number.isFinite(v) || v <= 0) throw new Error("maxLossUsd must be a positive number");
    maxLossUsd = Math.round(v);
  }
  return { lockPct, bundleSol, ponsEth, cashSol, cashEth, maxLossUsd };
}

export interface ShapeInputs extends OperatorInput {
  fx: { SOL: number; ETH: number };
  pons: { phantomEth: number; supply: number; feeBps: number; creatorTaxBps: number };
  solGasBudget: number;
  evmMakerCash: number;
  /** Pons launch fee + launcher gas the pool fronts the launcher wallet. */
  launcherEth: number;
}

export interface Shape {
  lock: { pct: number; tokens: number; sol: number; solGross: number; eth: number; ethGross: number; fundSol: number; fundEth: number };
  pump: { devBuySol: number; tokens: number; supplyPct: number; fdv: number; makerFrontSol: number };
  pons: { eth: number; tokens: number; supplyPct: number; fdv: number; makerFrontEth: number; parityEth: number };
  pool: { sol: number; eth: number };
  gapPct: number;
  fx: { SOL: number; ETH: number };
}

/** Constant-product buy that takes exactly `tokens` out of the curve: net quote in. */
function netForTokens(Q: number, T: number, tokens: number) {
  return (Q * T) / (T - tokens) - Q;
}

/**
 * Lock first, then the peg's opening buy, on each chain. pump.fun: the lock wallet spends SOL for lockPct of supply;
 * the maker's dev buy follows. Pons: the same tokens are locked from the phantom curve, then the maker buys ponsEth.
 */
export function shapeQuote(i: ShapeInputs): Shape {
  const lockTokens = (i.lockPct / 100) * TOTAL_SUPPLY;
  const pumpFee = PUMP_FEE_BPS / 10_000;
  // pump.fun: the curve moves on the net amount; the fee sits on top
  const lockNetSol = lockTokens > 0 ? netForTokens(PUMP_VIRTUAL_SOL, PUMP_VIRTUAL_TOKENS, lockTokens) : 0;
  const lockGrossSol = lockNetSol / (1 - pumpFee);
  const Q1 = PUMP_VIRTUAL_SOL + lockNetSol, T1 = PUMP_VIRTUAL_TOKENS - lockTokens;
  const devNet = i.bundleSol * (1 - pumpFee);
  const pumpTokens = tokensOut(Q1, T1, devNet);
  const Q2 = Q1 + devNet, T2 = T1 - pumpTokens;
  const pumpFdvSol = (Q2 / T2) * TOTAL_SUPPLY;
  const pumpFdv = pumpFdvSol * i.fx.SOL;
  // Pons: the same order on the phantom curve; fee + creator tax on top of the net
  const P = i.pons;
  const lockNetEth = lockTokens > 0 ? netForTokens(P.phantomEth, P.supply, lockTokens) : 0;
  const lockGrossEth = grossFromNet(lockNetEth, P.feeBps, P.creatorTaxBps);
  const E1 = P.phantomEth + lockNetEth, S1 = P.supply - lockTokens;
  const ponsNet = i.ponsEth * (1 - (P.feeBps + P.creatorTaxBps) / 10_000);
  const ponsTokens = tokensOut(E1, S1, ponsNet);
  const E2 = E1 + ponsNet, S2 = S1 - ponsTokens;
  const ponsFdv = (E2 / S2) * P.supply * i.fx.ETH;
  // what the maker buy on Pons would have to be to land on the pump.fun fdv
  const wantNet = Math.max(0, Math.sqrt((pumpFdv / i.fx.ETH / P.supply) * E1 * S1) - E1);
  const parityEth = grossFromNet(wantNet, P.feeBps, P.creatorTaxBps);
  const lockFundSol = lockGrossSol > 0 ? lockGrossSol * (1 + BUY_FEE_RATE) + LOCK_SOL_EXTRA : 0;
  const lockFundEth = lockGrossEth > 0 ? lockGrossEth + LOCK_ETH_EXTRA : 0;
  const makerFrontSol = i.bundleSol * (1 + BUY_FEE_RATE) + i.solGasBudget + i.cashSol;
  const makerFrontEth = i.ponsEth + i.evmMakerCash + i.cashEth;
  const gap = pumpFdv > 0 && ponsFdv > 0 ? Math.abs(pumpFdv - ponsFdv) / Math.min(pumpFdv, ponsFdv) : 0;
  return {
    lock: { pct: i.lockPct, tokens: Math.round(lockTokens), sol: r(lockNetSol, 6), solGross: r(lockGrossSol, 6), eth: r(lockNetEth, 6), ethGross: r(lockGrossEth, 6), fundSol: r(lockFundSol, 6), fundEth: r(lockFundEth, 6) },
    pump: { devBuySol: i.bundleSol, tokens: Math.round(pumpTokens), supplyPct: r((100 * pumpTokens) / TOTAL_SUPPLY, 2), fdv: Math.round(pumpFdv), makerFrontSol: r(makerFrontSol, 6) },
    pons: { eth: i.ponsEth, tokens: Math.round(ponsTokens), supplyPct: r((100 * ponsTokens) / P.supply, 2), fdv: Math.round(ponsFdv), makerFrontEth: r(makerFrontEth, 6), parityEth: r(parityEth, 6) },
    pool: { sol: r(makerFrontSol + lockFundSol, 6), eth: r(makerFrontEth + lockFundEth + i.launcherEth, 6) },
    gapPct: r(gap * 100, 2),
    fx: i.fx,
  };
}

/** The pool-side quote a record stores for an operator launch: front = what the maker gets, dev buy = bundleSol. */
export function operatorQuote(s: Shape, i: ShapeInputs): Quote {
  return {
    depositSol: 0,
    depositEth: 0,
    frontSol: s.pump.makerFrontSol,
    frontEth: s.pons.makerFrontEth,
    devBuySol: s.pump.devBuySol,
    pumpTokens: s.pump.tokens,
    ponsEth: s.pons.eth,
    ponsTokens: s.pons.tokens,
    makerCashEth: r(i.evmMakerCash + i.cashEth, 6),
    boostSol: 0,
    parityDevBuySol: parityDevBuySol(i.pons.phantomEth * i.fx.ETH, i.fx.SOL),
    openingFdv: s.pump.fdv,
    landing: { pump: s.pump.fdv, pons: s.pons.fdv },
    supplyPct: { pump: s.pump.supplyPct, pons: s.pons.supplyPct },
    fx: i.fx,
  };
}

export function newOperator(i: OperatorInput, s: Shape): OperatorLaunch {
  return {
    lockPct: i.lockPct, bundleSol: i.bundleSol, ponsEth: i.ponsEth, cashSol: i.cashSol, cashEth: i.cashEth, maxLossUsd: i.maxLossUsd,
    lock: { fundSol: s.lock.fundSol, fundEth: s.lock.fundEth, buySol: s.lock.solGross },
    locked: { lockSol: 0, lockEth: 0, pumpTokens: 0, ponsTokens: 0, txSol: null, txEth: null },
  };
}

export interface OperatorDeps extends Omit<CreateDeps, "quote" | "maxBoostSol" | "deadlineMin"> {
  shape: (i: OperatorInput) => Promise<{ shape: Shape; inputs: ShapeInputs }>;
}

/**
 * Validate, pin, generate the per-coin keys (plus the two lock wallets) and write the record straight into the
 * queue: no deposit, nothing owed, approved by the operator. The scheduler starts it on its next tick.
 */
export async function createOperatorLaunch(d: OperatorDeps, raw: unknown): Promise<{ rec: LaunchRecord; shape: Shape }> {
  const input = validateToken(raw);
  const op = validateOperatorInput(raw);
  const { shape, inputs } = await d.shape(op);
  const id = d.registry.newId(input.symbol);
  const website = d.publicUrl ? `${d.publicUrl}/coin/${id}` : "";
  const cids = await pinToken(d, id, input, website);

  const mint = Keypair.generate();
  const solCreator = Keypair.generate();
  const solMaker = Keypair.generate();
  const solLock = Keypair.generate();
  const payment = Keypair.generate();
  const evmLauncherKey = generatePrivateKey();
  const evmMakerKey = generatePrivateKey();
  const evmLockKey = generatePrivateKey();
  const evmPaymentKey = generatePrivateKey();
  d.registry.saveKeys(id, {
    mint: Array.from(mint.secretKey), solCreator: Array.from(solCreator.secretKey), solMaker: Array.from(solMaker.secretKey), payment: Array.from(payment.secretKey),
    solLock: Array.from(solLock.secretKey),
    evmLauncher: evmLauncherKey, evmMaker: evmMakerKey, evmPayment: evmPaymentKey, evmLock: evmLockKey,
  });

  const now = d.now();
  const rec = newRecord({
    id,
    now,
    deadlineAt: now,
    devWallet: solCreator.publicKey.toBase58(),
    chain: "sol",
    quote: operatorQuote(shape, inputs),
    token: { name: input.name, symbol: input.symbol, description: input.description, twitter: input.twitter, website, telegram: input.telegram, ...cids },
    wallets: {
      pumpMint: mint.publicKey.toBase58(),
      solCreator: solCreator.publicKey.toBase58(),
      solMaker: solMaker.publicKey.toBase58(),
      solLock: solLock.publicKey.toBase58(),
      evmLauncher: privateKeyToAccount(evmLauncherKey).address,
      evmMaker: privateKeyToAccount(evmMakerKey).address,
      evmLock: privateKeyToAccount(evmLockKey).address,
      payment: payment.publicKey.toBase58(),
      evmPayment: privateKeyToAccount(evmPaymentKey).address,
    },
    operator: newOperator(op, shape),
  });
  // Nothing is owed: the pool is the deployer. Straight through paid → approved.
  rec.payment.required = 0;
  rec.payment.paidAt = now;
  rec.payment.toPoolTx = "none";
  transition(rec, "paid", now, { operator: true });
  approve(rec, now, false, "operator launch");
  d.registry.save(rec);
  return { rec, shape };
}

/**
 * What an operator coin adds to the pool-wide loss breaker: only the loss past its own cap. Its own guard halts
 * it at that cap, so a deliberately larger position does not trip every other maker on its own.
 */
export function breakerContribution(lossUsd: number | null, ownCap: number | null): number {
  const loss = Math.max(0, lossUsd ?? 0);
  return ownCap == null ? loss : Math.max(0, loss - ownCap);
}

function r(n: number, d: number) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
