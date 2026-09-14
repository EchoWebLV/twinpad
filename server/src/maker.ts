import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAddress, type Address, type PublicClient, type WalletClient } from "viem";
import type { Config } from "./config.js";
import type { CoinState } from "./coin.js";
import { escrowAbi, PONS } from "./evm/pons.js";
import { evmBalances, evmBuy, evmSell, solanaBalances, solanaBuy, solanaSell } from "./trade.js";
import { lossUsd } from "./exit.js";
import { alert } from "./alerts.js";
import type { Recovery } from "./recover.js";

/**
 * The TWINE-style peg: whenever the two FDVs drift apart by more than `band`,
 * sell a clip on the expensive side and buy a clip on the cheap side.
 * It is a peg, not arbitrage — inventory never crosses chains; only the maker's
 * own quote and token balances on each side move.
 *
 * Safety: balance floors, one clip per side per tick, halts after N consecutive errors.
 */
export class Maker {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private cfg: Config,
    private coin: CoinState,
    private conn: Connection,
    private solWallet: Keypair,
    private pub: PublicClient,
    private evmWallet: WalletClient,
    private recovery?: Recovery,
  ) {}

  start() {
    if (this.timer) return;
    this.coin.maker.enabled = true;
    this.coin.maker.running = true;
    const loop = async () => {
      try {
        await this.tick();
      } catch (e) {
        this.onError(`tick: ${(e as Error).message}`);
      }
      if (!this.coin.maker.halted) this.timer = setTimeout(loop, this.cfg.maker.intervalMs);
      else this.coin.maker.running = false;
    };
    void loop();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.coin.maker.running = false;
  }

  resume() {
    this.coin.maker.halted = false;
    this.coin.maker.haltReason = null;
    this.coin.maker.consecutiveErrors = 0;
    this.start();
  }

  private onError(msg: string) {
    this.coin.maker.consecutiveErrors++;
    console.error(`[maker ${this.coin.id}] ${msg}`);
    if (this.coin.maker.consecutiveErrors >= this.cfg.maker.maxErrors) {
      this.coin.maker.halted = true;
      this.coin.maker.haltReason = msg;
      console.error(`[maker ${this.coin.id}] HALTED after ${this.coin.maker.consecutiveErrors} errors`);
    }
  }

  async refreshInventory() {
    const l = this.coin.pair;
    const mint = new PublicKey(l.pumpMint);
    const token = getAddress(l.ponsToken) as Address;
    const [s, e, escrow] = await Promise.all([
      solanaBalances(this.conn, this.solWallet.publicKey, mint),
      evmBalances(this.pub, this.evmWallet.account!.address, token),
      this.pub
        .readContract({ address: PONS.feeEscrow, abi: escrowAbi, functionName: "balanceOf", args: [this.evmWallet.account!.address] })
        .catch(() => 0n),
    ]);
    this.coin.inventory = { at: Date.now(), solana: s, evm: { ...e, escrowEth: Number(escrow) / 1e18 } };
    return this.coin.inventory;
  }

  /** Exit policy: stop pegging, sell inventory in clips whenever a side trades at or above our entry. */
  setMode(mode: "peg" | "selldown") {
    this.coin.maker.mode = mode;
  }

  /** Halt when the pool is down more than the per-coin budget on this coin. Returns true when halted. */
  private guard(inv: NonNullable<CoinState["inventory"]>): boolean {
    const st = this.coin;
    if (!st.pump || !st.pons || !st.fx.SOL || !st.fx.ETH) return false;
    const loss = lossUsd(st.front, inv, { pump: st.pump.price, pons: st.pons.price }, st.fx, st.repaid);
    st.maker.lossUsd = Math.round(loss * 100) / 100;
    if (loss <= this.cfg.guard.maxLossUsdPerCoin) return false;
    st.maker.halted = true;
    st.maker.haltReason = `loss guard: down $${loss.toFixed(0)} > $${this.cfg.guard.maxLossUsdPerCoin}`;
    void alert(`[maker ${st.id}] HALTED: ${st.maker.haltReason}`);
    return true;
  }

  private async selldownTick(inv: NonNullable<CoinState["inventory"]>) {
    const st = this.coin;
    if (!st.pump || !st.pons) return;
    const mint = new PublicKey(st.pair.pumpMint);
    const token = getAddress(st.pair.ponsToken) as Address;
    const o = { slippagePct: this.cfg.solana.slippagePct, priorityFeeSol: this.cfg.solana.priorityFeeSol };
    const reason = `selldown: entry $${st.entryPrice.toExponential(3)}/token`;
    const clipUsd = this.cfg.maker.maxClipUsd;
    if (inv.solana.tokens > 0) {
      if (st.pump.price >= st.entryPrice) {
        const tokens = Math.min(inv.solana.tokens, clipUsd / st.pump.price);
        await this.run("pump", "sell", `${tokens.toFixed(0)} tokens`, reason, () => solanaSell(this.conn, this.solWallet, mint, tokens, o));
      } else this.skip("pump", "sell", reason, `price $${st.pump.price.toExponential(3)} below entry`);
    }
    if (inv.evm.tokens > 0) {
      if (st.pons.price >= st.entryPrice) {
        const tokens = Math.min(inv.evm.tokens, clipUsd / st.pons.price);
        await this.run("pons", "sell", `${tokens.toFixed(0)} tokens`, reason, () => evmSell(this.pub, this.evmWallet, token, tokens, this.cfg.solana.slippagePct));
      } else this.skip("pons", "sell", reason, `price $${st.pons.price.toExponential(3)} below entry`);
    }
    st.persist();
  }

  /**
   * Front recovery, peg mode, inside the band: while a side's front is not repaid and that side trades
   * at entry × (1 + RECOVER_MARGIN) or better, sell one clip of the dev-buy pile into the demand.
   * The quote it raises is swept to the pool by `Recovery` once it passes the keep level.
   */
  private async harvest(inv: NonNullable<CoinState["inventory"]>) {
    const st = this.coin;
    if (!this.cfg.recover.enabled || !st.pump || !st.pons || !st.entryPrice) return;
    const floor = st.entryPrice * (1 + this.cfg.recover.margin);
    const clipUsd = this.cfg.maker.maxClipUsd;
    const o = { slippagePct: this.cfg.solana.slippagePct, priorityFeeSol: this.cfg.solana.priorityFeeSol };
    if (st.repaid.sol < st.front.sol && inv.solana.tokens >= 1 && st.pump.price >= floor) {
      const tokens = Math.min(inv.solana.tokens, clipUsd / st.pump.price);
      const reason = `harvest: pump +${(100 * (st.pump.price / st.entryPrice - 1)).toFixed(1)}% over entry, ${st.repaid.sol.toFixed(3)} of ${st.front.sol} SOL repaid`;
      await this.run("pump", "sell", `${tokens.toFixed(0)} tokens`, reason, () => solanaSell(this.conn, this.solWallet, new PublicKey(st.pair.pumpMint), tokens, o));
    }
    if (st.repaid.eth < st.front.eth && inv.evm.tokens >= 1 && st.pons.price >= floor) {
      const tokens = Math.min(inv.evm.tokens, clipUsd / st.pons.price);
      const reason = `harvest: pons +${(100 * (st.pons.price / st.entryPrice - 1)).toFixed(1)}% over entry, ${st.repaid.eth.toFixed(4)} of ${st.front.eth} ETH repaid`;
      await this.run("pons", "sell", `${tokens.toFixed(0)} tokens`, reason, () => evmSell(this.pub, this.evmWallet, getAddress(st.pair.ponsToken) as Address, tokens, this.cfg.solana.slippagePct));
    }
  }

  async tick() {
    const st = this.coin;
    st.maker.ticks++;
    st.maker.lastTick = Date.now();
    if (!st.pump || !st.pons) return;
    const g = st.gap();
    if (!g) return;
    const inv = await this.refreshInventory();
    if (this.guard(inv)) return;
    if (st.maker.mode === "selldown") return this.selldownTick(inv);
    const tradesBefore = st.maker.trades;
    if (g.gap <= this.cfg.maker.band) {
      st.maker.consecutiveErrors = 0;
      await this.harvest(inv);
      await this.recover(inv, tradesBefore);
      st.persist();
      return;
    }
    // Clip scales with how far outside the band we are, capped at 3× the base clip.
    const scale = Math.min(3, g.gap / this.cfg.maker.band);
    const clipUsd = this.cfg.maker.maxClipUsd * scale;
    const mint = new PublicKey(st.pair.pumpMint);
    const token = getAddress(st.pair.ponsToken) as Address;
    const o = { slippagePct: this.cfg.solana.slippagePct, priorityFeeSol: this.cfg.solana.priorityFeeSol };
    const reason = `gap ${(g.gap * 100).toFixed(2)}% > band ${(this.cfg.maker.band * 100).toFixed(1)}%, ${g.expensive} expensive`;

    const cheap = g.expensive === "pump" ? "pons" : "pump";
    // 1) sell on the expensive side: the scaled clip, or what is left in inventory (not under a quarter of the base clip)
    if (g.expensive === "pump") {
      const tokens = sizeSell(clipUsd / st.pump.price, inv.solana.tokens, this.cfg.maker.maxClipUsd / st.pump.price);
      if (tokens > 0) await this.run("pump", "sell", `${tokens.toFixed(0)} tokens`, reason, () => solanaSell(this.conn, this.solWallet, mint, tokens, o));
      else this.skip("pump", "sell", reason, `inventory ${inv.solana.tokens.toFixed(0)} tokens`);
    } else {
      const tokens = sizeSell(clipUsd / st.pons.price, inv.evm.tokens, this.cfg.maker.maxClipUsd / st.pons.price);
      if (tokens > 0) await this.run("pons", "sell", `${tokens.toFixed(0)} tokens`, reason, () => evmSell(this.pub, this.evmWallet, token, tokens, this.cfg.solana.slippagePct));
      else this.skip("pons", "sell", reason, `inventory ${inv.evm.tokens.toFixed(0)} tokens`);
    }
    // 2) buy on the cheap side
    // A scaled clip the wallet cannot fund above its floor shrinks to what it can, never below a quarter of the base clip.
    if (cheap === "pump") {
      const sol = sizeBuy(clipUsd / st.fx.SOL, inv.solana.sol, this.cfg.maker.minSol, this.cfg.maker.maxClipUsd / st.fx.SOL);
      if (sol > 0) await this.run("pump", "buy", `${sol.toFixed(4)} SOL`, reason, () => solanaBuy(this.conn, this.solWallet, mint, sol, o));
      else this.skip("pump", "buy", reason, `SOL floor ${this.cfg.maker.minSol}`);
    } else {
      const eth = sizeBuy(clipUsd / st.fx.ETH, inv.evm.eth, this.cfg.maker.minEth, this.cfg.maker.maxClipUsd / st.fx.ETH);
      if (eth > 0) await this.run("pons", "buy", `${eth.toFixed(5)} ETH`, reason, () => evmBuy(this.pub, this.evmWallet, token, eth, this.cfg.solana.slippagePct));
      else this.skip("pons", "buy", reason, `ETH floor ${this.cfg.maker.minEth}`);
    }
    await this.recover(inv, tradesBefore);
    st.persist();
  }

  /**
   * Sweep surplus quote to the pool / top ETH up. Its errors are logged, not counted against the maker.
   * Balances are re-read when this tick traded: the tick-start inventory still shows quote a buy has since spent
   * (and misses what a sell raised), and a sweep sized from it strips the maker below its keep level.
   */
  private async recover(inv: NonNullable<CoinState["inventory"]>, tradesBefore: number) {
    if (!this.recovery) return;
    try {
      const fresh = this.coin.maker.trades !== tradesBefore ? await this.refreshInventory() : inv;
      await this.recovery.afterTick(this.coin, fresh, { sol: this.solWallet, evm: this.evmWallet });
    } catch (e) {
      console.error(`[recover ${this.coin.id}] ${(e as Error).message.split("\n")[0].slice(0, 200)}`);
    }
  }

  private skip(side: "pump" | "pons", action: "buy" | "sell", reason: string, why: string) {
    this.coin.trades.push({ t: Date.now(), side, action, amount: "-", reason, error: `skipped: ${why}` });
  }

  private async run(side: "pump" | "pons", action: "buy" | "sell", amount: string, reason: string, fn: () => Promise<string>) {
    try {
      const tx = await fn();
      this.coin.trades.push({ t: Date.now(), side, action, amount, reason, tx });
      this.coin.maker.trades++;
      this.coin.maker.consecutiveErrors = 0;
      console.log(`[maker ${this.coin.id}] ${side} ${action} ${amount} -> ${tx}`);
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0].slice(0, 200);
      this.coin.trades.push({ t: Date.now(), side, action, amount, reason, error: msg });
      this.onError(`${side} ${action} ${amount}: ${msg}`);
    }
  }
}

/**
 * How much quote a buy may spend: the wanted clip, shrunk to what the wallet holds above its floor.
 * Anything under a quarter of the base clip is not worth the gas and returns 0 (the caller skips).
 */
/** How many tokens a sell may move: the wanted clip, or the whole inventory when that is smaller but still worth the gas. */
export function sizeSell(want: number, inventory: number, baseClip: number): number {
  const can = Math.min(want, inventory);
  return can >= baseClip / 4 ? can : 0;
}

export function sizeBuy(want: number, balance: number, floor: number, baseClip: number): number {
  const can = Math.min(want, balance - floor);
  return can >= baseClip / 4 ? can : 0;
}
