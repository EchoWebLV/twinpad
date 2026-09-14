import { Connection, PublicKey } from "@solana/web3.js";
import { getAddress, type Address, type PublicClient } from "viem";
import { fx } from "./fx.js";
import { pumpSide, ponsSide } from "./prices.js";
import type { CoinState } from "./coin.js";

/** Every `intervalMs`: refresh fx, then both sides of every coin (4 at a time). */
export class Poller {
  private timer: NodeJS.Timeout | null = null;
  constructor(private conn: Connection, private pub: PublicClient, private coins: () => CoinState[], private intervalMs = 3000) {}

  start() {
    const loop = async () => {
      await this.tick().catch((e) => console.error("[poll]", (e as Error).message));
      this.timer = setTimeout(loop, this.intervalMs);
    };
    void loop();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }

  async tick() {
    const coins = this.coins();
    if (!coins.length) return;
    let rates = coins[0].fx;
    try {
      rates = await fx();
    } catch (e) {
      console.error("[fx]", (e as Error).message);
    }
    const queue = [...coins];
    const worker = async () => {
      for (let c = queue.shift(); c; c = queue.shift()) await this.one(c, rates);
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  }

  /** Re-read both sides of one coin now (the maker calls this right after a trade). */
  async refresh(c: CoinState) {
    await this.one(c, c.fx.SOL && c.fx.ETH ? c.fx : await fx());
  }

  private async one(c: CoinState, rates: { SOL: number; ETH: number }) {
    c.fx = rates;
    const mint = new PublicKey(c.pair.pumpMint);
    const token = getAddress(c.pair.ponsToken) as Address;
    const [p, q] = await Promise.allSettled([pumpSide(this.conn, mint, rates.SOL), ponsSide(this.pub, token, rates.ETH)]);
    if (p.status === "fulfilled") c.pump = p.value;
    else { c.errors.pump++; c.lastError.pump = (p.reason as Error)?.message ?? String(p.reason); }
    if (q.status === "fulfilled") c.pons = q.value;
    else { c.errors.pons++; c.lastError.pons = (q.reason as Error)?.message ?? String(q.reason); }
    c.pushPoint();
    if (c.series.length % 15 === 0) c.persist();
  }
}
