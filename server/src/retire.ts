import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAddress, type Address, type PublicClient } from "viem";
import type { Config } from "./config.js";
import type { Registry } from "./registry.js";
import type { Pool } from "./pool.js";
import { sweepEth, sweepSol } from "./pool.js";
import { newRetire, step, transition, type LaunchRecord } from "./record.js";
import { evmBalances, evmSell, solanaBalances, solanaSell } from "./trade.js";
import { collectCreatorFee } from "./solana/pump.js";
import { escrowAbi, PONS, walletClient } from "./evm/pons.js";
import { measureActivity } from "./activity.js";
import { decide } from "./exit.js";
import { alert } from "./alerts.js";
import type { CoinState } from "./coin.js";
import type { Makers } from "./makers.js";

export interface RetireCtx { cfg: Config; registry: Registry; pool: Pool; conn: Connection; pub: PublicClient }

/**
 * Close a coin: sell what the maker holds back into both curves (or pools), collect creator fees,
 * sweep SOL/ETH from every per-coin wallet to the pool. Every step is idempotent (balances are re-read),
 * so a failed close is retried from where it stopped. Works on live and failed records.
 */
export async function closeCoin(ctx: RetireCtx, rec: LaunchRecord, reason: string): Promise<LaunchRecord> {
  const now = () => Date.now();
  const save = () => ctx.registry.save(rec);
  const log = (m: string) => console.log(`[close ${rec.id}] ${m}`);
  const keys = ctx.registry.keys(rec.id);
  if (!rec.retire) rec.retire = newRetire(rec.launch.launchedAt ?? now(), ctx.cfg.retire);
  const R = rec.retire;
  if (rec.status !== "closing") {
    transition(rec, "closing", now(), { reason });
    R.mode = "full";
    R.reason = reason;
    R.startedAt = now();
    R.error = null;
    save();
  }
  try {
    const o = { slippagePct: ctx.cfg.solana.slippagePct, priorityFeeSol: ctx.cfg.solana.priorityFeeSol };
    const creator = Keypair.fromSecretKey(Uint8Array.from(keys.solCreator));
    const payment = Keypair.fromSecretKey(Uint8Array.from(keys.payment));

    // ---- Solana: sell tokens, collect creator fees, sweep
    if (rec.launch.pumpMint) {
      const mint = new PublicKey(rec.launch.pumpMint);
      const bal = await solanaBalances(ctx.conn, creator.publicKey, mint);
      if (bal.tokens >= 1) {
        const sig = await solanaSell(ctx.conn, creator, mint, "100%", o);
        R.sold.pumpTokens += bal.tokens;
        R.sold.txs.push(sig);
        step(rec, "close_sell_pump", now(), { tokens: bal.tokens, tx: sig });
        save();
        log(`sold ${bal.tokens.toFixed(0)} on pump.fun ${sig}`);
      }
      const fees = await collectCreatorFee(ctx.conn, creator);
      if (fees) {
        step(rec, "close_creator_fee_pump", now(), { sol: fees.sol, tx: fees.sig });
        save();
        log(`collected ${fees.sol} SOL creator fees ${fees.sig}`);
      }
    }
    for (const [name, kp] of [["solCreator", creator], ["payment", payment]] as const) {
      const swept = await sweepSol(ctx.conn, kp, ctx.pool.sol.publicKey);
      if (swept) {
        R.swept.sol += swept.sol;
        R.swept.txs.push(swept.sig);
        rec.front.repaidSol += swept.sol;
        step(rec, "close_sweep_sol", now(), { wallet: name, sol: swept.sol, tx: swept.sig });
        save();
        log(`swept ${swept.sol.toFixed(4)} SOL from ${name} ${swept.sig}`);
      }
    }

    // ---- Robinhood: sell tokens from the maker, claim escrow, sweep maker + launcher + payment
    const maker = walletClient(ctx.cfg.evm.rpcUrl, keys.evmMaker);
    const makerAddr = maker.account!.address;
    if (rec.launch.ponsToken) {
      const token = getAddress(rec.launch.ponsToken) as Address;
      const bal = await evmBalances(ctx.pub, makerAddr, token);
      if (bal.tokens >= 1) {
        const hash = await evmSell(ctx.pub, maker, token, bal.tokens, ctx.cfg.solana.slippagePct);
        R.sold.ponsTokens += bal.tokens;
        R.sold.txs.push(hash);
        step(rec, "close_sell_pons", now(), { tokens: bal.tokens, tx: hash });
        save();
        log(`sold ${bal.tokens.toFixed(0)} on Pons ${hash}`);
      }
      const escrow = await ctx.pub.readContract({ address: PONS.feeEscrow, abi: escrowAbi, functionName: "balanceOf", args: [makerAddr] }).catch(() => 0n);
      if (escrow > 0n) {
        const { encodeFunctionData } = await import("viem");
        const data = encodeFunctionData({ abi: escrowAbi, functionName: "claim" });
        const gas = await ctx.pub.estimateGas({ account: makerAddr, to: PONS.feeEscrow, data });
        const hash = await maker.sendTransaction({ account: maker.account!, chain: maker.chain, to: PONS.feeEscrow, data, gas: (gas * 12n) / 10n });
        const rc = await ctx.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
        if (rc.status !== "success") throw new Error(`escrow claim ${hash} reverted`);
        step(rec, "close_creator_fee_pons", now(), { eth: Number(escrow) / 1e18, tx: hash });
        save();
        log(`claimed ${Number(escrow) / 1e18} ETH creator tax ${hash}`);
      }
    }
    for (const [name, key] of [["evmMaker", keys.evmMaker], ["evmLauncher", keys.evmLauncher], ["evmPayment", keys.evmPayment]] as const) {
      if (!key) continue;
      const swept = await sweepEth(ctx.pub, ctx.cfg.evm.rpcUrl, key, ctx.pool.evmAddress);
      if (swept) {
        R.swept.eth += swept.eth;
        R.swept.txs.push(swept.sig);
        rec.front.repaidEth += swept.eth;
        step(rec, "close_sweep_eth", now(), { wallet: name, eth: swept.eth, tx: swept.sig });
        save();
        log(`swept ${swept.eth.toFixed(5)} ETH from ${name} ${swept.sig}`);
      }
    }

    // ---- deployer boost: its share of everything that came back, to the dev wallet
    if (rec.boostSol > 0 && rec.payment.chain === "sol" && rec.front.sol > 0) {
      const share = Math.round((rec.front.repaidSol * rec.boostSol / rec.front.sol) * 1e6) / 1e6;
      const due = Math.round((share - rec.refund.paid) * 1e6) / 1e6;
      if (due >= 0.001) {
        const sig = await ctx.pool.transferSol(new PublicKey(rec.devWallet), due);
        rec.refund.amount = share;
        rec.refund.paid = Math.round((rec.refund.paid + due) * 1e6) / 1e6;
        rec.refund.txs.push(sig);
        step(rec, "close_boost_refund", now(), { sol: due, boostSol: rec.boostSol, recovered: rec.front.repaidSol, tx: sig });
        save();
        log(`refunded ${due} SOL of the ${rec.boostSol} SOL boost to ${rec.devWallet} ${sig}`);
      }
    }

    R.closedAt = now();
    R.error = null;
    transition(rec, "closed", now(), { sol: R.swept.sol, eth: R.swept.eth, boostRefund: rec.refund.paid });
    save();
    log(`closed: ${R.swept.sol.toFixed(4)} SOL + ${R.swept.eth.toFixed(5)} ETH back in the pool (fronted ${rec.front.sol} SOL + ${rec.front.eth} ETH)`);
    void alert(`[close ${rec.id}] ${reason}: recovered ${rec.front.repaidSol.toFixed(4)} SOL + ${rec.front.repaidEth.toFixed(5)} ETH of ${rec.front.sol} SOL + ${rec.front.eth} ETH fronted${rec.refund.paid ? `, ${rec.refund.paid} SOL boost refunded` : ""}`);
    return rec;
  } catch (e) {
    R.error = (e as Error).message.split("\n")[0].slice(0, 300);
    step(rec, "close_error", now(), { error: R.error });
    save();
    void alert(`[close ${rec.id}] failed: ${R.error} (will retry)`);
    throw e;
  }
}

/**
 * The exit timer. Every `intervalMs` over live coins: measure outside interest once decideAt has passed,
 * apply the verdict (keep / full close / selldown → finish), enforce the pool-wide loss breaker.
 */
export class Retirer {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private launchBlocks = new Map<string, bigint>();
  constructor(
    private ctx: RetireCtx,
    private coins: () => CoinState[],
    private makers: Makers,
    private close: (rec: LaunchRecord, reason: string) => Promise<void>,
    private breaker: (reason: string) => void,
    private intervalMs = 30_000,
  ) {}

  start() {
    const loop = async () => {
      await this.tick().catch((e) => console.error("[retire]", (e as Error).message));
      this.timer = setTimeout(loop, this.intervalMs);
    };
    void loop();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }

  async tick(now = Date.now()) {
    if (this.running) return;
    this.running = true;
    try {
      const coins = this.coins();
      // pool-wide loss breaker
      const total = coins.reduce((s, c) => s + Math.max(0, c.maker.lossUsd ?? 0), 0);
      if (total > this.ctx.cfg.guard.maxLossUsdPool) this.breaker(`pool down $${total.toFixed(0)} across live coins > $${this.ctx.cfg.guard.maxLossUsdPool}`);
      if (!this.ctx.cfg.retire.enabled) return;
      for (const c of coins) {
        const rec = this.ctx.registry.get(c.id);
        if (!rec || rec.status !== "live") continue;
        await this.one(rec, c, now).catch((e) => console.error(`[retire ${c.id}]`, (e as Error).message));
      }
    } finally {
      this.running = false;
    }
  }

  private async activity(rec: LaunchRecord, c: CoinState) {
    if (!c.pump || !c.pons) return null;
    let from = this.launchBlocks.get(rec.id);
    if (from === undefined) {
      const hash = rec.launch.txs.ponsLaunch as Address | undefined;
      if (!hash) return null;
      const rc = await this.ctx.pub.getTransactionReceipt({ hash });
      from = rc.blockNumber;
      this.launchBlocks.set(rec.id, from);
    }
    return measureActivity(this.ctx.conn, this.ctx.pub, {
      pumpMint: rec.launch.pumpMint!, ponsToken: rec.launch.ponsToken!, ponsCurve: rec.launch.ponsCurve!,
      ours: { solana: [rec.wallets.solCreator, this.ctx.pool.sol.publicKey.toBase58()], evm: [rec.wallets.evmMaker, rec.wallets.evmLauncher, this.ctx.pool.evmAddress] },
      ponsFromBlock: from, price: { pump: c.pump.price, pons: c.pons.price },
    });
  }

  private async one(rec: LaunchRecord, c: CoinState, now: number) {
    if (!rec.retire) {
      rec.retire = newRetire(rec.launch.launchedAt ?? rec.createdAt, this.ctx.cfg.retire);
      this.ctx.registry.save(rec);
    }
    const R = rec.retire;
    let a: Awaited<ReturnType<Retirer["activity"]>> = null;
    if (!R.keep && !R.evaluated && now >= R.decideAt) {
      try {
        a = await this.activity(rec, c);
      } catch (e) {
        console.error(`[retire ${rec.id}] activity unknown: ${(e as Error).message}`);
      }
    }
    const v = decide(R, a, now);
    if (v === "wait" || v === "keep") return;
    if (!R.evaluated && a) {
      R.evaluated = { at: now, outsideBuyers: a.outsideBuyers, outsideUsd: Math.round(a.outsideUsd * 100) / 100, verdict: v === "finish" ? "selldown" : v };
      step(rec, "exit_evaluated", now, { ...R.evaluated, pump: a.pump, pons: a.pons });
      if (v === "selldown") R.selldownUntil = now + R.policy.selldownMin * 60_000;
      this.ctx.registry.save(rec);
      console.log(`[retire ${rec.id}] ${v}: ${a.outsideBuyers} outside holders, $${a.outsideUsd.toFixed(0)} held (bar ${R.policy.minBuyers} / $${R.policy.minUsd})`);
    }
    if (v === "selldown") {
      if (c.maker.mode !== "selldown") {
        this.makers.setMode(rec.id, "selldown");
        console.log(`[retire ${rec.id}] selldown until ${new Date(R.selldownUntil!).toISOString()}`);
      }
      return;
    }
    const reason = v === "full" ? `exit: no outside holders after ${R.policy.afterMin} min` : `exit: selldown window over`;
    await this.close(rec, reason);
  }
}
