import fs from "node:fs";
import path from "node:path";
import type { SideState } from "./prices.js";

export interface Pair { pumpMint: string; ponsToken: string; ponsCurve: string; launchedAt: number | null; name: string; symbol: string }
export interface Meta { name: string; symbol: string; image: string; twitter: string; website: string; description: string }
export interface SeriesPoint { t: number; pump: number; pons: number }
export interface Trade { t: number; side: "pump" | "pons"; action: "buy" | "sell"; amount: string; reason: string; tx?: string; error?: string }
export interface Inventory { at: number; solana: { sol: number; tokens: number }; evm: { eth: number; tokens: number; escrowEth: number } }
export interface MakerStatus {
  enabled: boolean; running: boolean; halted: boolean; haltReason: string | null; consecutiveErrors: number; lastTick: number; ticks: number; trades: number;
  /** peg: hold the band. selldown: sell clips above entry, never buy (exit policy). */
  mode: "peg" | "selldown";
  /** Fronted value − held value, USD (loss guard). */
  lossUsd: number | null;
  /** Tokens the peg bought on top of the opening position, USD at cost per side; sells release it. Capped by MAKER_MAX_BOUGHT_CLIPS. */
  bought: { pumpUsd: number; ponsUsd: number };
}

/** Pure form of the ceiling test: what the peg already bought on a side (USD at cost) plus this clip must not exceed the ceiling. */
export function underCeiling(boughtUsd: number, clipUsd: number, ceilingUsd: number) {
  return boughtUsd + clipUsd <= ceilingUsd + 1e-9;
}

/** Live state of one coin: both sides, series, trades, maker status. Persists series/trades/bought to DATA_DIR/state/<id>.json. */
export class CoinState {
  pump: SideState | null = null;
  pons: SideState | null = null;
  fx: { SOL: number; ETH: number } = { SOL: 0, ETH: 0 };
  series: SeriesPoint[] = [];
  trades: Trade[] = [];
  inventory: Inventory | null = null;
  maker: MakerStatus = { enabled: false, running: false, halted: false, haltReason: null, consecutiveErrors: 0, lastTick: 0, ticks: 0, trades: 0, mode: "peg", lossUsd: null, bought: { pumpUsd: 0, ponsUsd: 0 } };
  /** What the pool fronted this coin (sol includes the deployer boost), for the loss guard and front recovery. */
  front: { sol: number; eth: number } = { sol: 0, eth: 0 };
  /** Swept back to the pool so far. Harvest stops per side once repaid ≥ fronted. */
  repaid: { sol: number; eth: number } = { sol: 0, eth: 0 };
  /** Set once repaid ≥ fronted on both chains. */
  retiredAt: number | null = null;
  /** Our entry price in USD per token (opening FDV / supply); selldown only sells at or above it. */
  entryPrice = 0;
  /** Operator launches: their own loss cap (null = MAX_LOSS_USD_PER_COIN), cash the recovery sweep leaves on top of the keep level, and the locked allocation. */
  maxLossUsd: number | null = null;
  keepExtra = { sol: 0, eth: 0 };
  locked: { pct: number; pumpTokens: number; ponsTokens: number; solLock: string; evmLock: string } | null = null;
  errors = { pump: 0, pons: 0 };
  lastError: { pump: string | null; pons: string | null } = { pump: null, pons: null };
  private file: string;

  constructor(dataDir: string, readonly id: string, readonly band: number, readonly pair: Pair, readonly meta: Meta) {
    const dir = path.join(dataDir, "state");
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${id}.json`);
    try {
      if (fs.existsSync(this.file)) {
        const j = JSON.parse(fs.readFileSync(this.file, "utf8")) as { series?: SeriesPoint[]; trades?: Trade[]; bought?: { pumpUsd: number; ponsUsd: number } };
        this.series = j.series ?? [];
        this.trades = j.trades ?? [];
        if (j.bought) this.maker.bought = { pumpUsd: Number(j.bought.pumpUsd) || 0, ponsUsd: Number(j.bought.ponsUsd) || 0 };
      }
    } catch {
      this.series = [];
    }
  }

  persist() {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    this.series = this.series.filter((p) => p.t >= cutoff);
    this.trades = this.trades.slice(-2000);
    fs.writeFileSync(this.file, JSON.stringify({ series: this.series, trades: this.trades, bought: this.maker.bought }));
  }

  /** A peg buy of `usd` on `side` counts against the ceiling; a sell of `usd` releases it (never below zero). */
  noteBuy(side: "pump" | "pons", usd: number) {
    const k = side === "pump" ? "pumpUsd" : "ponsUsd";
    this.maker.bought[k] = Math.round((this.maker.bought[k] + Math.max(0, usd)) * 100) / 100;
  }
  noteSell(side: "pump" | "pons", usd: number) {
    const k = side === "pump" ? "pumpUsd" : "ponsUsd";
    this.maker.bought[k] = Math.max(0, Math.round((this.maker.bought[k] - Math.max(0, usd)) * 100) / 100);
  }
  /** Whether a buy of `clipUsd` on `side` stays under the bought-inventory ceiling. */
  underCeiling(side: "pump" | "pons", clipUsd: number, ceilingUsd: number) {
    return underCeiling(side === "pump" ? this.maker.bought.pumpUsd : this.maker.bought.ponsUsd, clipUsd, ceilingUsd);
  }

  pushPoint() {
    if (!this.pump || !this.pons) return;
    const last = this.series[this.series.length - 1];
    const t = Date.now();
    if (last && t - last.t < 20_000) return;
    this.series.push({ t, pump: Math.round(this.pump.fdv), pons: Math.round(this.pons.fdv) });
  }

  gap() {
    if (!this.pump || !this.pons || !this.pump.fdv || !this.pons.fdv) return null;
    const hi = Math.max(this.pump.fdv, this.pons.fdv);
    const lo = Math.min(this.pump.fdv, this.pons.fdv);
    return { gap: (hi - lo) / lo, expensive: this.pump.fdv > this.pons.fdv ? "pump" : "pons" } as const;
  }

  /** `/api/coins/:id/state` in the twine.auction schema plus `inventory`, `maker`, `trades`. */
  snapshot(range: "1h" | "6h" | "24h" = "24h") {
    const ms = range === "1h" ? 3600e3 : range === "6h" ? 6 * 3600e3 : 24 * 3600e3;
    const since = Date.now() - ms;
    const series = this.series.filter((p) => p.t >= since);
    let inBand = 0, maxGap = 0, high = 0, low = Infinity;
    for (const p of series) {
      const hi = Math.max(p.pump, p.pons), lo = Math.min(p.pump, p.pons);
      const g = lo > 0 ? (hi - lo) / lo : 0;
      if (g <= this.band) inBand++;
      if (g > maxGap) maxGap = g;
      if (hi > high) high = hi;
      if (lo < low) low = lo;
    }
    const g = this.gap();
    return {
      status: this.pump && this.pons ? "live" : "starting",
      coin: { id: this.id, source: "pair", mode: "pair" },
      pair: this.pair,
      meta: this.meta,
      fx: this.fx,
      band: this.band,
      pump: this.pump,
      pons: this.pons,
      gap: g?.gap ?? null,
      expensive: g?.expensive ?? null,
      inBand: g ? g.gap <= this.band : null,
      stats: { range, points: series.length, inBandPct: series.length ? Math.round((1000 * inBand) / series.length) / 10 : 0, maxGap, high: high || 0, low: low === Infinity ? 0 : low },
      series,
      inventory: this.inventory,
      front: { ...this.front, repaid: this.repaid, retiredAt: this.retiredAt },
      locked: this.locked,
      maker: this.maker,
      trades: this.trades.slice(-50),
      updatedAt: Date.now(),
      errors: this.errors,
      lastError: this.lastError,
    };
  }

  /** Card for `/api/coins`. */
  summary() {
    const g = this.gap();
    return {
      id: this.id, name: this.meta.name, symbol: this.meta.symbol, image: this.meta.image, launchedAt: this.pair.launchedAt,
      pumpMint: this.pair.pumpMint, ponsToken: this.pair.ponsToken,
      pumpFdv: this.pump?.fdv ?? null, ponsFdv: this.pons?.fdv ?? null, gap: g?.gap ?? null, inBand: g ? g.gap <= this.band : null,
      maker: this.maker.halted ? "halted" : this.maker.running ? "running" : "off",
    };
  }
}
