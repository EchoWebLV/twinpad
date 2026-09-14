import type { Retire } from "./record.js";

/** What the exit timer sees for one coin: outside holders (not our wallets, not the curves) and the USD value they hold. */
export interface Activity { outsideBuyers: number; outsideUsd: number }

export type Verdict = "wait" | "keep" | "full" | "selldown" | "finish";

/**
 * Pure exit rule.
 * Before decideAt: wait. At decideAt: keep when the bar is met; full close when nobody outside holds anything;
 * otherwise selldown (sell clips above entry) until selldownUntil, then finish (full close of what is left).
 * `keep` from the operator wins at any point.
 */
export function decide(r: Retire, a: Activity | null, now: number): Verdict {
  if (r.keep) return "keep";
  if (r.mode === "full") return "full";
  if (!r.evaluated) {
    if (now < r.decideAt) return "wait";
    if (!a) return "wait"; // measurement failed: never close on missing data
    if (a.outsideBuyers >= r.policy.minBuyers || a.outsideUsd >= r.policy.minUsd) return "keep";
    return a.outsideBuyers === 0 ? "full" : "selldown";
  }
  if (r.evaluated.verdict === "keep") return "keep";
  if (r.evaluated.verdict === "full") return "full";
  return r.selldownUntil !== null && now >= r.selldownUntil ? "finish" : "selldown";
}

/** Fronted value minus what the maker still holds minus what already came back to the pool, in USD. Positive = the pool is down that much on this coin. */
export function lossUsd(
  front: { sol: number; eth: number },
  inv: { solana: { sol: number; tokens: number }; evm: { eth: number; tokens: number; escrowEth: number } },
  price: { pump: number; pons: number },
  fx: { SOL: number; ETH: number },
  repaid: { sol: number; eth: number } = { sol: 0, eth: 0 },
): number {
  const fronted = (front.sol - repaid.sol) * fx.SOL + (front.eth - repaid.eth) * fx.ETH;
  const held = (inv.solana.sol + inv.solana.tokens * price.pump / fx.SOL) * fx.SOL
    + (inv.evm.eth + inv.evm.escrowEth + inv.evm.tokens * price.pons / fx.ETH) * fx.ETH;
  return fronted - held;
}
