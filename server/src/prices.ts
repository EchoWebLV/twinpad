import { Connection, PublicKey } from "@solana/web3.js";
import type { Address, PublicClient } from "viem";
import { readBondingCurve } from "./solana/pump.js";
import { readPumpSwapPool } from "./solana/pumpswap.js";
import { readCurve, readLaunch } from "./evm/pons.js";
import { poolKey, readSlot0, readLiquidity, ethDepth } from "./evm/v4.js";

/** One side of the pair, in the shape twine.auction served (spec §7). */
export interface SideState {
  chain: string;
  venue: string;
  kind: "curve" | "pumpswap" | "v4";
  phase: "curve" | "amm";
  phaseLabel: string;
  fdv: number; // USD
  price: number; // USD per token
  quoteSymbol: "SOL" | "ETH";
  quoteDepth: number; // quote units in the curve / pool
  progress: number; // 0..1
  realQuote: number;
  at: number;
  [k: string]: unknown;
}

export async function pumpSide(conn: Connection, mint: PublicKey, solUsd: number): Promise<SideState> {
  const curve = await readBondingCurve(conn, mint);
  if (!curve) throw new Error("pump: bonding curve not found (coin not created?)");
  if (!curve.complete) {
    return {
      chain: "Solana",
      venue: "pump.fun",
      kind: "curve",
      phase: "curve",
      phaseLabel: "bonding curve",
      fdv: curve.fdvSol * solUsd,
      price: curve.price * solUsd,
      quoteSymbol: "SOL",
      quoteDepth: curve.quoteDepthSol,
      progress: curve.progress,
      realQuote: curve.quoteDepthSol,
      mint: mint.toBase58(),
      at: Date.now(),
    };
  }
  const pool = await readPumpSwapPool(conn, mint);
  if (!pool) throw new Error("pump: curve complete but PumpSwap pool not found yet");
  return {
    chain: "Solana",
    venue: "pump.fun",
    kind: "pumpswap",
    phase: "amm",
    phaseLabel: "PumpSwap pool",
    fdv: pool.fdvSol * solUsd,
    price: pool.price * solUsd,
    quoteSymbol: "SOL",
    quoteDepth: pool.quoteSol,
    progress: 1,
    realQuote: 0,
    mint: mint.toBase58(),
    pool: pool.pool.toBase58(),
    at: Date.now(),
  };
}

export async function ponsSide(client: PublicClient, token: Address, ethUsd: number): Promise<SideState> {
  const l = await readLaunch(client, token);
  if (!l.exists) throw new Error("pons: token not launched");
  if (Number(l.phase) < 2) {
    const c = await readCurve(client, token);
    return {
      chain: "Robinhood Chain",
      venue: "PONS",
      kind: "curve",
      phase: "curve",
      phaseLabel: c.readyToGraduate ? "graduating" : "bonding curve",
      fdv: c.fdvEth * ethUsd,
      price: c.price * ethUsd,
      quoteSymbol: "ETH",
      quoteDepth: c.quoteDepthEth,
      progress: c.progress,
      realQuote: c.quoteDepthEth,
      token,
      curve: c.curve,
      taxBps: c.creatorTaxBps,
      at: Date.now(),
    };
  }
  const key = poolKey(token, Number(l.tickSpacing), l.pairToken);
  const [s, liq] = await Promise.all([readSlot0(client, key), readLiquidity(client, key)]);
  const pmEth = ethDepth(liq, s);
  return {
    chain: "Robinhood Chain",
    venue: "PONS",
    kind: "v4",
    phase: "amm",
    phaseLabel: "Uniswap v4 pool",
    fdv: s.fdvEth * ethUsd,
    price: s.price * ethUsd,
    quoteSymbol: "ETH",
    quoteDepth: pmEth,
    progress: 1,
    realQuote: 0,
    token,
    curve: l.curve,
    taxBps: Number(l.creatorTaxBps),
    tick: s.tick,
    at: Date.now(),
  };
}

