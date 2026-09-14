import { Connection, Keypair } from "@solana/web3.js";
import { parseEther, type PublicClient, type WalletClient } from "viem";
import type { Config } from "./config.js";
import type { Registry } from "./registry.js";
import type { Pool } from "./pool.js";
import { sendSol } from "./pool.js";
import { step, type LaunchRecord } from "./record.js";
import type { CoinState, Inventory } from "./coin.js";
import { alert } from "./alerts.js";
import { collectCreatorFee, creatorVaultBalance } from "./solana/pump.js";
import { claimEscrow } from "./evm/fees.js";
import { CREATOR_KEEP_SOL } from "./rotate.js";

export interface RecoverCtx { cfg: Config; registry: Registry; pool: Pool; conn: Connection; pub: PublicClient }

/** How often a coin's creator vault / escrow is looked at (every tick would be one more RPC read per chain). */
export const FEE_CHECK_MS = 60_000;

/**
 * A top-up is bounded per coin (MAX_TOPUP_*_PER_COIN) so a coin cannot drain the pool — unless the coin has already
 * repaid more than it was fronted: then the pool is net ahead and lending working capital back is not new exposure.
 */
export function canTopUp(f: { fronted: number; repaid: number; topups: number }, topup: number, maxTopups: number): boolean {
  if (f.topups + topup <= maxTopups + 1e-12) return true;
  return f.repaid - (f.fronted + topup) >= -1e-12;
}

/**
 * Front recovery, run inside the maker's tick (same wallets, so no nonce races):
 * 1. quote above the keep level (MAKER_MIN_* + RECOVER_KEEP_CLIPS clips) goes back to the pool and counts as repaid;
 * 2. when the maker wants to buy on one side but cannot fund a clip there, the pool tops that quote up (bounded per coin);
 * 3. once repaid ≥ fronted on both chains the front is retired: milestone step + alert, sweeps keep going;
 * 4. creator fees are claimed while live, not only at close: the pump.fun creator vault (to the creator wallet, swept
 *    to the pool when the maker has been rotated off it) and the Pons creator-tax escrow (to the maker wallet, where
 *    the surplus sweep or the next buy picks it up).
 */
export class Recovery {
  private feeCheckedAt = new Map<string, number>();
  constructor(private ctx: RecoverCtx) {}

  keep(c: CoinState) {
    const { maker, recover } = this.ctx.cfg;
    return {
      sol: maker.minSol + (recover.keepClips * maker.maxClipUsd) / c.fx.SOL + 0.01,
      eth: maker.minEth + (recover.keepClips * maker.maxClipUsd) / c.fx.ETH + 0.002,
    };
  }

  async afterTick(c: CoinState, inv: Inventory, w: { sol: Keypair; solCreator?: Keypair; evm: WalletClient }) {
    const cfg = this.ctx.cfg;
    if (!cfg.recover.enabled || !c.fx.SOL || !c.fx.ETH) return;
    const rec = this.ctx.registry.get(c.id);
    if (!rec || rec.status !== "live") return;
    const now = Date.now();
    const save = () => this.ctx.registry.save(rec);
    const log = (m: string) => console.log(`[recover ${c.id}] ${m}`);
    const keep = this.keep(c);

    // 0. creator fees (rate-limited; errors are the tick's, logged by the maker, never counted against it)
    if (now - (this.feeCheckedAt.get(c.id) ?? 0) >= FEE_CHECK_MS) {
      this.feeCheckedAt.set(c.id, now);
      await this.claimFees(c, rec, w, log);
    }

    // 1. surplus quote → pool
    const surplusSol = round(inv.solana.sol - keep.sol, 6);
    if (surplusSol >= 0.01) {
      const sig = await sendSol(this.ctx.conn, w.sol, this.ctx.pool.sol.publicKey, surplusSol);
      rec.front.repaidSol = round(rec.front.repaidSol + surplusSol, 9);
      c.repaid.sol = rec.front.repaidSol;
      step(rec, "front_repaid_sol", now, { sol: surplusSol, tx: sig, repaid: rec.front.repaidSol, fronted: rec.front.sol });
      save();
      log(`swept ${surplusSol} SOL to the pool (${rec.front.repaidSol.toFixed(4)} of ${rec.front.sol} repaid) ${sig}`);
    }
    const surplusEth = round(inv.evm.eth - keep.eth, 6);
    if (surplusEth >= 0.002) {
      const hash = await w.evm.sendTransaction({ account: w.evm.account!, chain: w.evm.chain, to: this.ctx.pool.evmAddress, value: parseEther(surplusEth.toFixed(18)) });
      const rc = await this.ctx.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (rc.status !== "success") throw new Error(`eth sweep ${hash} reverted`);
      rec.front.repaidEth = round(rec.front.repaidEth + surplusEth, 12);
      c.repaid.eth = rec.front.repaidEth;
      step(rec, "front_repaid_eth", now, { eth: surplusEth, tx: hash, repaid: rec.front.repaidEth, fronted: rec.front.eth });
      save();
      log(`swept ${surplusEth} ETH to the pool (${rec.front.repaidEth.toFixed(5)} of ${rec.front.eth} repaid) ${hash}`);
    }

    // 2. ETH follows Pons demand: the maker wants to buy there (pump expensive) but cannot fund a clip
    const g = c.gap();
    // the maker scales its clip up to 3x outside the band, so starvation is judged against the clip it actually wants
    const clipUsd = cfg.maker.maxClipUsd * (g ? Math.min(3, g.gap / c.band) : 1);
    // a side at its bought-inventory ceiling gets no top-up: the maker will not buy there until sells release it
    const ceilingUsd = cfg.maker.maxBoughtClips * cfg.maker.maxClipUsd;
    const starved = g !== null && g.gap > c.band && g.expensive === "pump" && inv.evm.eth - clipUsd / c.fx.ETH < cfg.maker.minEth && c.underCeiling("pons", cfg.maker.maxClipUsd, ceilingUsd);
    if (starved && canTopUp({ fronted: rec.front.eth, repaid: rec.front.repaidEth, topups: rec.front.topupEth }, cfg.recover.topupEth, cfg.recover.maxTopupEthPerCoin)) {
      const can = await this.ctx.pool.canFront(0, cfg.recover.topupEth);
      if (can.ok) {
        const hash = await this.ctx.pool.transferEth(w.evm.account!.address, cfg.recover.topupEth);
        rec.front.eth = round(rec.front.eth + cfg.recover.topupEth, 12);
        rec.front.topupEth = round(rec.front.topupEth + cfg.recover.topupEth, 12);
        c.front.eth = rec.front.eth;
        step(rec, "front_topup_eth", now, { eth: cfg.recover.topupEth, tx: hash, fronted: rec.front.eth, topups: rec.front.topupEth });
        save();
        log(`topped the maker up with ${cfg.recover.topupEth} ETH (fronted now ${rec.front.eth}) ${hash}`);
      } else log(`maker starved of ETH but the pool is at its floor (${can.balances.eth.toFixed(4)} ETH)`);
    }
    // same on Solana: Pons expensive means buying pump, which needs SOL the pump sells have not raised yet
    const starvedSol = g !== null && g.gap > c.band && g.expensive === "pons" && inv.solana.sol - clipUsd / c.fx.SOL < cfg.maker.minSol && c.underCeiling("pump", cfg.maker.maxClipUsd, ceilingUsd);
    if (starvedSol && canTopUp({ fronted: rec.front.sol, repaid: rec.front.repaidSol, topups: rec.front.topupSol }, cfg.recover.topupSol, cfg.recover.maxTopupSolPerCoin)) {
      const can = await this.ctx.pool.canFront(cfg.recover.topupSol, 0);
      if (can.ok) {
        const sig = await this.ctx.pool.transferSol(w.sol.publicKey, cfg.recover.topupSol);
        rec.front.sol = round(rec.front.sol + cfg.recover.topupSol, 9);
        rec.front.topupSol = round(rec.front.topupSol + cfg.recover.topupSol, 9);
        c.front.sol = rec.front.sol;
        step(rec, "front_topup_sol", now, { sol: cfg.recover.topupSol, tx: sig, fronted: rec.front.sol, topups: rec.front.topupSol });
        save();
        log(`topped the maker up with ${cfg.recover.topupSol} SOL (fronted now ${rec.front.sol}) ${sig}`);
      } else log(`maker starved of SOL but the pool is at its floor (${can.balances.sol.toFixed(4)} SOL)`);
    }

    // 3. milestone
    if (!rec.front.retiredAt && rec.front.repaidSol >= rec.front.sol - 1e-9 && rec.front.repaidEth >= rec.front.eth - 1e-12) {
      rec.front.retiredAt = now;
      c.retiredAt = now;
      step(rec, "front_retired", now, { sol: rec.front.repaidSol, eth: rec.front.repaidEth });
      save();
      void alert(`[recover ${c.id}] front retired: ${rec.front.sol} SOL + ${rec.front.eth} ETH are back in the pool; everything still in the coin is profit`);
    }
  }

  private async claimFees(c: CoinState, rec: LaunchRecord, w: { sol: Keypair; solCreator?: Keypair; evm: WalletClient }, log: (m: string) => void) {
    const { claimMinSol, claimMinEth } = this.ctx.cfg.recover;
    const save = () => this.ctx.registry.save(rec);
    const creator = w.solCreator ?? w.sol;
    const rotated = !creator.publicKey.equals(w.sol.publicKey);

    // pump.fun: creator vault → creator wallet
    const vault = await creatorVaultBalance(this.ctx.conn, creator.publicKey);
    if (vault >= claimMinSol) {
      const got = await collectCreatorFee(this.ctx.conn, creator, claimMinSol);
      if (got) {
        rec.front.feesSol = round(rec.front.feesSol + got.sol, 9);
        step(rec, "creator_fee_pump", Date.now(), { sol: got.sol, tx: got.sig, total: rec.front.feesSol });
        save();
        log(`collected ${got.sol.toFixed(4)} SOL pump.fun creator fees (${rec.front.feesSol.toFixed(4)} so far) ${got.sig}`);
      }
    }
    // a rotated creator wallet only signs fee collections: anything above its keep goes to the pool as repaid
    if (rotated) {
      const bal = (await this.ctx.conn.getBalance(creator.publicKey, "confirmed")) / 1e9;
      const surplus = round(bal - CREATOR_KEEP_SOL, 6);
      if (surplus >= 0.01) {
        const sig = await sendSol(this.ctx.conn, creator, this.ctx.pool.sol.publicKey, surplus);
        rec.front.repaidSol = round(rec.front.repaidSol + surplus, 9);
        c.repaid.sol = rec.front.repaidSol;
        step(rec, "front_repaid_sol", Date.now(), { wallet: "solCreator", sol: surplus, tx: sig, repaid: rec.front.repaidSol, fronted: rec.front.sol });
        save();
        log(`swept ${surplus} SOL from the creator wallet to the pool (${rec.front.repaidSol.toFixed(4)} of ${rec.front.sol} repaid) ${sig}`);
      }
    }

    // Pons: creator-tax escrow → maker wallet
    const got = await claimEscrow(this.ctx.pub, w.evm, claimMinEth);
    if (got) {
      rec.front.feesEth = round(rec.front.feesEth + got.eth, 12);
      step(rec, "creator_fee_pons", Date.now(), { eth: got.eth, tx: got.hash, total: rec.front.feesEth });
      save();
      log(`claimed ${got.eth.toFixed(5)} ETH Pons creator tax (${rec.front.feesEth.toFixed(5)} so far) ${got.hash}`);
    }
  }
}

function round(n: number, d: number) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
