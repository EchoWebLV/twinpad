import { Connection, Keypair } from "@solana/web3.js";
import { parseEther, type PublicClient, type WalletClient } from "viem";
import type { Config } from "./config.js";
import type { Registry } from "./registry.js";
import type { Pool } from "./pool.js";
import { sendSol } from "./pool.js";
import { step, type LaunchRecord } from "./record.js";
import type { CoinState, Inventory } from "./coin.js";
import { alert } from "./alerts.js";

export interface RecoverCtx { cfg: Config; registry: Registry; pool: Pool; conn: Connection; pub: PublicClient }

/**
 * Front recovery, run inside the maker's tick (same wallets, so no nonce races):
 * 1. quote above the keep level (MAKER_MIN_* + RECOVER_KEEP_CLIPS clips) goes back to the pool and counts as repaid;
 * 2. when the maker wants to buy on one side but cannot fund a clip there, the pool tops that quote up (bounded per coin);
 * 3. once repaid ≥ fronted on both chains the front is retired: milestone step + alert, sweeps keep going.
 */
export class Recovery {
  constructor(private ctx: RecoverCtx) {}

  keep(c: CoinState) {
    const { maker, recover } = this.ctx.cfg;
    return {
      sol: maker.minSol + (recover.keepClips * maker.maxClipUsd) / c.fx.SOL + 0.01,
      eth: maker.minEth + (recover.keepClips * maker.maxClipUsd) / c.fx.ETH + 0.002,
    };
  }

  async afterTick(c: CoinState, inv: Inventory, w: { sol: Keypair; evm: WalletClient }) {
    const cfg = this.ctx.cfg;
    if (!cfg.recover.enabled || !c.fx.SOL || !c.fx.ETH) return;
    const rec = this.ctx.registry.get(c.id);
    if (!rec || rec.status !== "live") return;
    const now = Date.now();
    const save = () => this.ctx.registry.save(rec);
    const log = (m: string) => console.log(`[recover ${c.id}] ${m}`);
    const keep = this.keep(c);

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
    const starved = g !== null && g.gap > c.band && g.expensive === "pump" && inv.evm.eth - clipUsd / c.fx.ETH < cfg.maker.minEth;
    if (starved && rec.front.topupEth + cfg.recover.topupEth <= cfg.recover.maxTopupEthPerCoin + 1e-12) {
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
    const starvedSol = g !== null && g.gap > c.band && g.expensive === "pons" && inv.solana.sol - clipUsd / c.fx.SOL < cfg.maker.minSol;
    if (starvedSol && rec.front.topupSol + cfg.recover.topupSol <= cfg.recover.maxTopupSolPerCoin + 1e-9) {
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
}

function round(n: number, d: number) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
