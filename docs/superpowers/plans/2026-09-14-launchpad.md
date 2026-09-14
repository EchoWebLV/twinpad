# Duo Launchpad (phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-coin launcher into a custodial public launchpad that works like TWINE V2: deposit → approve → pool fronts per-coin wallets → create on pump.fun + Pons → live status page + per-coin maker.

**Architecture:** One Node process (`server/`) holds a file-backed registry of launch records, a payment watcher, a scheduler that approves and launches one record at a time, the launcher (today's `launch.ts` as a library), a poller and one maker per live coin, and a JSON API. `web/` (Next.js 15) gets a home page, a launch form, a per-launch page with Phantom payment, the existing status page per coin, and an admin page.

**Tech Stack:** Node 22, TypeScript (NodeNext ESM, `.js` import suffixes), `@solana/web3.js`, `viem`, `node:test` via `tsx`, Next.js 15 / React 19.

Spec: `docs/superpowers/specs/2026-09-14-launchpad-design.md`. Repo: `/Users/yordanlasonov/Documents/GitHub/duo-launcher-pad`. All `server/` commands run inside `server/`; all `web/` commands inside `web/`.

Conventions: never log or return secret keys; every chain call lives behind a small function so tests stay chain-free; commit after every task with the `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer.

---

## File map

Server (`server/src/`):

| File | Responsibility |
|---|---|
| `config.ts` (modify) | env → typed config; new `pool` and `launch` sections; token/creator keys removed |
| `record.ts` (new) | `LaunchRecord`, `LaunchKeys`, `Quote` types, `newRecord()`, `transition()`, `publicRecord()` |
| `registry.ts` (new) | load/save records + keys under `DATA_DIR/launches/<id>/`, atomic writes, id generation |
| `quote.ts` (new) | pure sizing math: pump landing FDV, ETH needed to land Pons at a target FDV, `buildQuote()` |
| `pool.ts` (new) | pool wallets: balances, floors, outstanding, `transferSol`, `transferEth` |
| `paid.ts` (new) | `createLaunch()`: validate input, store image, pin to IPFS, generate keys, write record |
| `payments.ts` (new) | pure `reconcile()` + watcher that reads the payment address and issues refunds |
| `scheduler.ts` (new) | pure `plan()` (expire / auto-approve / pick next launch) + runner loop |
| `launcher.ts` (new, replaces `launch.ts`) | `runLaunch()` with checkpointed steps from per-coin wallets |
| `coin.ts` (new, replaces `state.ts`) | `CoinState`: per-coin sides, series, trades, maker status, `snapshot()` |
| `poller.ts` (new) | fx + both sides for every live coin |
| `maker.ts` (modify) | same peg logic, per-coin state and wallets injected |
| `makers.ts` (new) | one `Maker` per live coin; arm / halt / resume |
| `api.ts` (rewrite) | tiny router, JSON body parsing, rate limit, admin auth, routes |
| `index.ts` (rewrite) | wiring: registry, pool, api, payments, scheduler, poller, makers |
| `*.test.ts` (new) | node:test unit tests next to the module |

Web (`web/`):

| File | Responsibility |
|---|---|
| `lib/api.ts` (new) | API base URL, `getJson`, `postJson`, shared types |
| `app/page.tsx` (rewrite) | home: live coins + open launches |
| `app/launch/page.tsx` (new) | launch form |
| `app/launch/[id]/page.tsx` (new) | payment + step timeline |
| `app/coin/[id]/page.tsx` (new, from old `app/page.tsx`) | status page per coin |
| `app/admin/page.tsx` (new) | approve / reject / retry / maker halt-resume |
| `app/globals.css` (modify) | a few new classes |

---

### Task 1: Config and test harness

**Files:**
- Modify: `server/src/config.ts`
- Modify: `server/package.json`, `server/tsconfig.json`
- Test: `server/src/config.test.ts`

- [ ] **Step 1: Add the test script and exclude tests from the build**

In `server/package.json` replace the `scripts` block with:

```json
"scripts": {
  "bridge": "tsx src/bridge.ts",
  "prices": "tsx src/prices-cli.ts",
  "dev": "tsx src/index.ts",
  "build": "tsc -p tsconfig.json",
  "start": "node dist/index.js",
  "typecheck": "tsc -p tsconfig.json --noEmit",
  "test": "node --import tsx --test \"src/**/*.test.ts\""
}
```

In `server/tsconfig.json` add after `"include": ["src"]`:

```json
"exclude": ["src/**/*.test.ts"]
```

- [ ] **Step 2: Write the failing config test**

`server/src/config.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.POOL_SOL_KEY = "x".repeat(88);
process.env.ADMIN_TOKEN = "secret-token";
process.env.DEPOSIT_SOL = "0.1";
const { config, redactedConfig } = await import("./config.js");

test("launch section reads env with defaults", () => {
  assert.equal(config.launch.depositSol, 0.1);
  assert.equal(config.launch.frontSol, 13.8);
  assert.equal(config.launch.autoApprove, false);
  assert.equal(config.pool.minSol, 5);
});

test("redactedConfig never contains secrets", () => {
  const s = JSON.stringify(redactedConfig());
  assert.ok(!s.includes("x".repeat(88)));
  assert.ok(!s.includes("secret-token"));
  assert.match(s, /set \(88 chars\)/);
});
```

- [ ] **Step 3: Run it, expect failure**

Run: `npm test`
Expected: FAIL (`config.launch` undefined).

- [ ] **Step 4: Rewrite `config.ts`**

Replace the `export const config = {...}` block and `redactedConfig` in `server/src/config.ts` with:

```ts
export const config = {
  solana: {
    rpcUrl: env("SOLANA_RPC_URL", env("RPC_URL", "https://api.mainnet-beta.solana.com")),
    slippagePct: num("SOL_SLIPPAGE_PCT", 10),
    priorityFeeSol: num("SOL_PRIORITY_FEE_SOL", 0.0005),
  },
  evm: {
    rpcUrl: env("EVM_RPC_URL", "https://rpc.ordofi.network"),
    creatorTaxBps: num("EVM_CREATOR_TAX_BPS", 200),
  },
  pool: {
    solKey: env("POOL_SOL_KEY"),
    evmKey: env("POOL_EVM_KEY"),
    minSol: num("POOL_MIN_SOL", 5),
    minEth: num("POOL_MIN_ETH", 0.05),
  },
  launch: {
    depositSol: num("DEPOSIT_SOL", 0.5),
    depositDeadlineMin: num("DEPOSIT_DEADLINE_MIN", 60),
    frontSol: num("FRONT_SOL", 13.8),
    frontEth: num("FRONT_ETH", 0.33),
    solGasBudget: num("SOL_GAS_BUDGET", 0.13),
    evmGasLauncher: num("EVM_GAS_LAUNCHER", 0.012),
    evmMakerCash: num("EVM_MAKER_CASH", 0.01),
    autoApprove: bool("AUTO_APPROVE", false),
    adminToken: env("ADMIN_TOKEN"),
    maxLiveMakers: num("MAX_LIVE_MAKERS", 10),
    maxOpenLaunches: num("MAX_OPEN_LAUNCHES", 20),
  },
  pinataJwt: env("PINATA_JWT"),
  maker: {
    band: num("BAND", 0.05),
    enabled: bool("MAKER_ENABLED", true),
    intervalMs: num("MAKER_INTERVAL_MS", 3000),
    maxClipUsd: num("MAKER_MAX_CLIP_USD", 300),
    minSol: num("MAKER_MIN_SOL", 0.3),
    minEth: num("MAKER_MIN_ETH", 0.01),
    maxErrors: num("MAKER_MAX_ERRORS", 5),
  },
  server: {
    port: num("PORT", 8787),
    corsOrigin: env("CORS_ORIGIN", "*"),
    dataDir: path.resolve(process.cwd(), env("DATA_DIR", "./data")),
  },
};

export type Config = typeof config;

/** Never print secrets. Use this when echoing config. */
export function redactedConfig() {
  const c = JSON.parse(JSON.stringify(config)) as Config;
  const mask = (s: string) => (s ? `set (${s.length} chars)` : "missing");
  c.pool.solKey = mask(c.pool.solKey);
  c.pool.evmKey = mask(c.pool.evmKey);
  c.launch.adminToken = mask(c.launch.adminToken);
  c.pinataJwt = mask(c.pinataJwt);
  c.solana.rpcUrl = safeHost(c.solana.rpcUrl);
  c.evm.rpcUrl = safeHost(c.evm.rpcUrl);
  return c;
}
```

Keep the env loader, `env`/`num`/`bool` helpers and `safeHost` as they are.

- [ ] **Step 5: Run the test**

Run: `npm test`
Expected: 2 passing. (`npm run typecheck` will now fail in `launch.ts`, `index.ts`, `maker.ts` because `config.token` etc. are gone. Those files are replaced in later tasks; do not fix them here.)

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/tsconfig.json server/src/config.ts server/src/config.test.ts
git commit -m "config: pool + launch sections, node:test harness"
```

---

### Task 2: Record types and registry

**Files:**
- Create: `server/src/record.ts`, `server/src/registry.ts`
- Test: `server/src/registry.test.ts`

- [ ] **Step 1: Write the failing test**

`server/src/registry.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Registry } from "./registry.js";
import { newRecord, transition, publicRecord, type Quote } from "./record.js";

const quote: Quote = {
  depositSol: 0.1, frontSol: 1, frontEth: 0.03, devBuySol: 0.87, pumpTokens: 1, ponsEth: 0.01, ponsTokens: 1,
  makerCashEth: 0.01, openingFdv: 100, landing: { pump: 100, pons: 100 }, supplyPct: { pump: 1, pons: 1 }, fx: { SOL: 100, ETH: 2500 },
};

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
}

test("newId is symbol-xxxx", () => {
  const r = new Registry(tmp());
  assert.match(r.newId("DoGgO!"), /^doggo-[a-z0-9]{4}$/);
});

test("save/load round-trips and keys are private", () => {
  const dir = tmp();
  const r = new Registry(dir);
  const rec = newRecord({
    id: "doggo-ab12", token: { name: "Doggo", symbol: "DOGGO", description: "d", twitter: "", website: "", telegram: "", imageCid: "i", metadataCid: "m", metadataUri: "u" },
    devWallet: "H6CS", wallets: { pumpMint: "M", solCreator: "C", evmLauncher: "0xL", evmMaker: "0xK", payment: "P" },
    quote, deadlineAt: 10, now: 5,
  });
  r.save(rec);
  r.saveKeys("doggo-ab12", { mint: [1], solCreator: [2], payment: [3], evmLauncher: "0x01", evmMaker: "0x02" });
  const again = new Registry(dir);
  assert.equal(again.get("doggo-ab12")?.status, "awaiting_deposit");
  assert.deepEqual(again.keys("doggo-ab12").mint, [1]);
  assert.equal((fs.statSync(path.join(dir, "launches", "doggo-ab12", "keys.json")).mode & 0o777), 0o600);
  assert.ok(!JSON.stringify(publicRecord(rec)).includes("keys"));
});

test("transition enforces the state machine", () => {
  const rec = newRecord({
    id: "a-0000", token: { name: "A", symbol: "A", description: "d", twitter: "", website: "", telegram: "", imageCid: "i", metadataCid: "m", metadataUri: "u" },
    devWallet: "D", wallets: { pumpMint: "M", solCreator: "C", evmLauncher: "0xL", evmMaker: "0xK", payment: "P" }, quote, deadlineAt: 10, now: 5,
  });
  transition(rec, "paid", 6);
  assert.throws(() => transition(rec, "live", 7), /paid → live/);
  transition(rec, "approved", 7);
  transition(rec, "launching", 8);
  transition(rec, "failed", 9);
  transition(rec, "approved", 10);
  assert.equal(rec.launch.steps.at(-1)?.name, "status:approved");
});

test("list filters by status, newest first", () => {
  const r = new Registry(tmp());
  for (const [id, t] of [["a-0001", 1], ["b-0002", 2]] as const) {
    r.save(newRecord({ id, token: { name: id, symbol: id, description: "d", twitter: "", website: "", telegram: "", imageCid: "i", metadataCid: "m", metadataUri: "u" },
      devWallet: "D", wallets: { pumpMint: "M", solCreator: "C", evmLauncher: "0xL", evmMaker: "0xK", payment: "P" }, quote, deadlineAt: 10, now: t }));
  }
  assert.deepEqual(r.list().map((x) => x.id), ["b-0002", "a-0001"]);
  assert.equal(r.list({ status: ["paid"] }).length, 0);
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `npm test`
Expected: FAIL, cannot find `./registry.js`.

- [ ] **Step 3: Write `record.ts`**

```ts
/** Launch record: the public state of one launch, same shape as TWINE V2's /api/paid entries. */
export type LaunchStatus =
  | "awaiting_deposit" | "paid" | "approved" | "launching" | "live" | "rejected" | "expired" | "failed";

export interface PaymentTx { tx: string; from: string; sol: number; at: number; late: boolean }
export interface Step { at: number; name: string; [k: string]: unknown }

export interface Quote {
  depositSol: number;
  frontSol: number;
  frontEth: number;
  devBuySol: number;
  pumpTokens: number;
  ponsEth: number;
  ponsTokens: number;
  makerCashEth: number;
  openingFdv: number;
  landing: { pump: number; pons: number };
  supplyPct: { pump: number; pons: number };
  fx: { SOL: number; ETH: number };
}

export interface TokenMeta {
  name: string; symbol: string; description: string; twitter: string; website: string; telegram: string;
  imageCid: string; metadataCid: string; metadataUri: string;
}

export interface LaunchRecord {
  id: string;
  createdAt: number;
  status: LaunchStatus;
  token: TokenMeta;
  devWallet: string;
  devShareBps: number;
  devShareBpsFunded: number;
  wallets: { pumpMint: string; solCreator: string; evmLauncher: string; evmMaker: string; payment: string };
  payment: {
    address: string; requiredSol: number; receivedSol: number; paidAt: number | null; from: string | null;
    expectedFrom: string; overpaidSol: number; deadlineAt: number; toPoolTx: string | null; txs: PaymentTx[]; foreign: PaymentTx[];
  };
  approval: { status: "pending" | "approved" | "rejected"; at: number | null; note: string | null; auto: boolean };
  front: { sol: number; eth: number; at: number | null; txSol: string | null; txRhLauncher: string | null; txRhMaker: string | null; repaidSol: number; writtenOffSol: number };
  seed: { pumpTokens: number; ponsTokens: number; openingFdv: number; at: number } | null;
  launch: {
    startedAt: number | null; steps: Step[]; salt: string | null; pumpMint: string | null; ponsToken: string | null; ponsCurve: string | null;
    launchedAt: number | null; txs: Record<string, string>; error: string | null;
  };
  refund: { sol: number; paidSol: number; txs: string[] };
  reserve: null;
  waterfall: null;
  retire: null;
  quote: Quote;
}

/** Secret keys for one launch. Written 0600, never served. */
export interface LaunchKeys { mint: number[]; solCreator: number[]; payment: number[]; evmLauncher: string; evmMaker: string }

export interface NewRecordInput {
  id: string; token: TokenMeta; devWallet: string; wallets: LaunchRecord["wallets"]; quote: Quote; deadlineAt: number; now: number;
}

export function newRecord(i: NewRecordInput): LaunchRecord {
  return {
    id: i.id,
    createdAt: i.now,
    status: "awaiting_deposit",
    token: i.token,
    devWallet: i.devWallet,
    devShareBps: 0,
    devShareBpsFunded: 5000,
    wallets: i.wallets,
    payment: {
      address: i.wallets.payment, requiredSol: i.quote.depositSol, receivedSol: 0, paidAt: null, from: null,
      expectedFrom: i.devWallet, overpaidSol: 0, deadlineAt: i.deadlineAt, toPoolTx: null, txs: [], foreign: [],
    },
    approval: { status: "pending", at: null, note: null, auto: false },
    front: { sol: i.quote.frontSol, eth: i.quote.frontEth, at: null, txSol: null, txRhLauncher: null, txRhMaker: null, repaidSol: 0, writtenOffSol: 0 },
    seed: null,
    launch: { startedAt: null, steps: [{ at: i.now, name: "created" }], salt: null, pumpMint: null, ponsToken: null, ponsCurve: null, launchedAt: null, txs: {}, error: null },
    refund: { sol: 0, paidSol: 0, txs: [] },
    reserve: null,
    waterfall: null,
    retire: null,
    quote: i.quote,
  };
}

const ALLOWED: Record<LaunchStatus, LaunchStatus[]> = {
  awaiting_deposit: ["paid", "expired", "rejected"],
  paid: ["approved", "rejected"],
  approved: ["launching", "rejected"],
  launching: ["live", "failed"],
  live: [],
  rejected: [],
  expired: [],
  failed: ["approved"],
};

export function transition(rec: LaunchRecord, to: LaunchStatus, now: number, extra: Record<string, unknown> = {}) {
  if (!ALLOWED[rec.status].includes(to)) throw new Error(`illegal transition ${rec.status} → ${to} (${rec.id})`);
  rec.status = to;
  rec.launch.steps.push({ at: now, name: `status:${to}`, ...extra });
}

export function step(rec: LaunchRecord, name: string, now: number, extra: Record<string, unknown> = {}) {
  rec.launch.steps.push({ at: now, name, ...extra });
}

/** What the API serves: the record as stored (it holds public keys only). Exists so the boundary is explicit. */
export function publicRecord(rec: LaunchRecord): LaunchRecord {
  return rec;
}

export const OPEN_STATUSES: LaunchStatus[] = ["awaiting_deposit", "paid", "approved", "launching", "failed"];
```

- [ ] **Step 4: Write `registry.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { LaunchKeys, LaunchRecord, LaunchStatus } from "./record.js";

/** File-backed registry: DATA_DIR/launches/<id>/{record.json,keys.json,image.png}. Records stay in memory. */
export class Registry {
  private records = new Map<string, LaunchRecord>();
  readonly root: string;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, "launches");
    fs.mkdirSync(this.root, { recursive: true });
    for (const id of fs.readdirSync(this.root)) {
      const f = path.join(this.root, id, "record.json");
      if (fs.existsSync(f)) this.records.set(id, JSON.parse(fs.readFileSync(f, "utf8")) as LaunchRecord);
    }
  }

  dir(id: string) {
    return path.join(this.root, id);
  }

  newId(symbol: string): string {
    const base = symbol.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10) || "coin";
    for (;;) {
      const id = `${base}-${crypto.randomBytes(3).toString("hex").slice(0, 4)}`;
      if (!this.records.has(id)) return id;
    }
  }

  get(id: string): LaunchRecord | undefined {
    return this.records.get(id);
  }

  list(filter: { status?: LaunchStatus[] } = {}): LaunchRecord[] {
    return [...this.records.values()]
      .filter((r) => !filter.status || filter.status.includes(r.status))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  save(rec: LaunchRecord) {
    this.records.set(rec.id, rec);
    fs.mkdirSync(this.dir(rec.id), { recursive: true });
    atomicWrite(path.join(this.dir(rec.id), "record.json"), JSON.stringify(rec, null, 2), 0o644);
  }

  saveKeys(id: string, keys: LaunchKeys) {
    fs.mkdirSync(this.dir(id), { recursive: true });
    atomicWrite(path.join(this.dir(id), "keys.json"), JSON.stringify(keys), 0o600);
  }

  keys(id: string): LaunchKeys {
    return JSON.parse(fs.readFileSync(path.join(this.dir(id), "keys.json"), "utf8")) as LaunchKeys;
  }

  imagePath(id: string) {
    return path.join(this.dir(id), "image.png");
  }
}

function atomicWrite(file: string, data: string, mode: number) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, mode);
}
```

- [ ] **Step 5: Run the test**

Run: `npm test`
Expected: all passing.

- [ ] **Step 6: Commit**

```bash
git add server/src/record.ts server/src/registry.ts server/src/registry.test.ts
git commit -m "registry: file-backed launch records with keys and state machine"
```

---

### Task 3: Quote math

**Files:**
- Create: `server/src/quote.ts`
- Test: `server/src/quote.test.ts`

The pump.fun bonding curve starts at 30 virtual SOL / 1,073,000,000 virtual tokens (constant product); a buy of `s` SOL net of fees moves the price to `(vS+s)²/(vS·vT)`. Pons v2 launch config 0 is also constant product with `phantomQuote` ETH against `supply` tokens. For any constant-product curve with reserves `(Q, T)` the quote needed to reach spot price `p` is `sqrt(p·Q·T) − Q`. The pump fee constant is only used for the pre-launch estimate shown in the quote; the launcher re-reads the real curve after the create.

- [ ] **Step 1: Write the failing test**

`server/src/quote.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { pumpLanding, quoteNetForFdv, grossFromNet, buildQuote, PUMP_VIRTUAL_SOL, PUMP_VIRTUAL_TOKENS } from "./quote.js";

test("pumpLanding: 13.687 SOL lands near TWINE's observed opening (≈ 59 SOL fdv, 32.7 % of supply)", () => {
  const l = pumpLanding(13.687, 0);
  assert.ok(Math.abs(l.fdvSol - 59.5) < 1.5, `fdv ${l.fdvSol}`);
  assert.ok(Math.abs(l.tokens / 1e9 - 0.336) < 0.01, `tokens ${l.tokens}`);
});

test("quoteNetForFdv is the inverse of a constant-product buy", () => {
  const Q = PUMP_VIRTUAL_SOL, T = PUMP_VIRTUAL_TOKENS;
  const net = 5;
  const fdvAfter = ((Q + net) ** 2 / (Q * T)) * 1e9;
  assert.ok(Math.abs(quoteNetForFdv(Q, T, 1e9, fdvAfter) - net) < 1e-9);
  assert.equal(quoteNetForFdv(Q, T, 1e9, 1), 0); // target below spot → nothing to buy
});

test("grossFromNet adds fee and tax", () => {
  assert.ok(Math.abs(grossFromNet(0.97, 100, 200) - 1) < 1e-12);
});

test("buildQuote lands both sides at the same fdv when ETH allows, else caps", () => {
  const base = {
    depositSol: 0.5, frontSol: 13.8, frontEth: 0.33, solGasBudget: 0.13, evmMakerCash: 0.01,
    fx: { SOL: 101, ETH: 2521 }, pons: { phantomEth: 2, supply: 1e9, feeBps: 100, creatorTaxBps: 200 },
  };
  const q = buildQuote(base);
  assert.equal(q.devBuySol, 13.67);
  assert.ok(Math.abs(q.landing.pump - q.landing.pons) < 1, JSON.stringify(q.landing));
  assert.ok(q.ponsEth > 0 && q.ponsEth <= 0.32);
  const capped = buildQuote({ ...base, frontEth: 0.02 });
  assert.equal(capped.ponsEth, 0.01);
  assert.ok(capped.landing.pons < capped.landing.pump);
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `npm test`
Expected: FAIL, cannot find `./quote.js`.

- [ ] **Step 3: Write `quote.ts`**

```ts
import type { Quote } from "./record.js";

/** pump.fun initial virtual reserves (global config, unchanged since 2024). Only used for the pre-launch estimate. */
export const PUMP_VIRTUAL_SOL = 30;
export const PUMP_VIRTUAL_TOKENS = 1_073_000_000;
/** pump.fun protocol + creator fee on curve buys, bps. Estimate only; the launcher reads the real curve after create. */
export const PUMP_FEE_BPS = 125;
export const TOTAL_SUPPLY = 1_000_000_000;

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

export interface QuoteInputs {
  depositSol: number;
  frontSol: number;
  frontEth: number;
  solGasBudget: number;
  evmMakerCash: number;
  fx: { SOL: number; ETH: number };
  pons: { phantomEth: number; supply: number; feeBps: number; creatorTaxBps: number };
}

/** Pre-launch sizing shown to the deployer and stored on the record. */
export function buildQuote(i: QuoteInputs): Quote {
  const devBuySol = round(i.frontSol - i.solGasBudget, 4);
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
    frontSol: i.frontSol,
    frontEth: i.frontEth,
    devBuySol,
    pumpTokens: Math.round(pump.tokens),
    ponsEth,
    ponsTokens: Math.round(ponsTokens),
    makerCashEth: round(i.frontEth - ponsEth, 6),
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
```

- [ ] **Step 4: Run the test**

Run: `npm test`
Expected: all passing. If `pumpLanding` bounds fail, print `l` and adjust only the test tolerance, not the constants (they are pump.fun's published initial reserves).

- [ ] **Step 5: Commit**

```bash
git add server/src/quote.ts server/src/quote.test.ts
git commit -m "quote: pre-launch sizing so both curves land at one fdv"
```

---

### Task 4: Pool wallets

**Files:**
- Create: `server/src/pool.ts`

No unit test (every method is a chain call); it is exercised by the first real launch.

- [ ] **Step 1: Write `pool.ts`**

```ts
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { formatEther, parseEther, type Address, type PublicClient, type WalletClient } from "viem";
import type { Config } from "./config.js";
import { keypairFromBase58 } from "./solana/pump.js";
import { addressOf, publicClient, walletClient } from "./evm/pons.js";
import type { Registry } from "./registry.js";

/** The operator's two pool wallets. Fronts per-coin wallets, receives deposits. Never lends below the floors. */
export class Pool {
  readonly sol: Keypair;
  readonly evm: WalletClient;
  readonly evmAddress: Address;
  readonly conn: Connection;
  readonly pub: PublicClient;

  constructor(private cfg: Config, conn: Connection, pub: PublicClient) {
    if (!cfg.pool.solKey || !cfg.pool.evmKey) throw new Error("POOL_SOL_KEY and POOL_EVM_KEY are required");
    this.sol = keypairFromBase58(cfg.pool.solKey);
    this.evm = walletClient(cfg.evm.rpcUrl, cfg.pool.evmKey);
    this.evmAddress = addressOf(cfg.pool.evmKey);
    this.conn = conn;
    this.pub = pub;
  }

  async balances() {
    const [lamports, wei] = await Promise.all([this.conn.getBalance(this.sol.publicKey), this.pub.getBalance({ address: this.evmAddress })]);
    return { sol: lamports / LAMPORTS_PER_SOL, eth: Number(formatEther(wei)) };
  }

  /** Σ fronted − repaid over records that were fronted. */
  outstanding(registry: Registry) {
    let sol = 0, eth = 0;
    for (const r of registry.list()) {
      if (!r.front.at) continue;
      sol += r.front.sol - r.front.repaidSol - r.front.writtenOffSol;
      eth += r.front.eth;
    }
    return { sol, eth };
  }

  async canFront(sol: number, eth: number) {
    const b = await this.balances();
    const okSol = b.sol - sol >= this.cfg.pool.minSol;
    const okEth = b.eth - eth >= this.cfg.pool.minEth;
    return { ok: okSol && okEth, balances: b, okSol, okEth };
  }

  async transferSol(to: PublicKey, sol: number): Promise<string> {
    return sendSol(this.conn, this.sol, to, sol);
  }

  async transferEth(to: Address, eth: number): Promise<string> {
    const hash = await this.evm.sendTransaction({ account: this.evm.account!, chain: this.evm.chain, to, value: parseEther(eth.toFixed(18)) });
    const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`eth transfer ${hash} reverted`);
    return hash;
  }

  summary(registry: Registry) {
    return this.balances().then((b) => ({
      solana: { address: this.sol.publicKey.toBase58(), balance: b.sol, floor: this.cfg.pool.minSol },
      robinhood: { address: this.evmAddress, balance: b.eth, floor: this.cfg.pool.minEth },
      outstanding: this.outstanding(registry),
      counts: {
        live: registry.list({ status: ["live"] }).length,
        launching: registry.list({ status: ["launching"] }).length,
        queued: registry.list({ status: ["paid", "approved"] }).length,
        open: registry.list({ status: ["awaiting_deposit"] }).length,
      },
    }));
  }
}

/** Plain system transfer, confirmed. */
export async function sendSol(conn: Connection, from: Keypair, to: PublicKey, sol: number): Promise<string> {
  const lamports = Math.round(sol * LAMPORTS_PER_SOL);
  if (lamports <= 0) throw new Error(`transfer of ${sol} SOL is not positive`);
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports }));
  return sendAndConfirmTransaction(conn, tx, [from], { commitment: "confirmed" });
}

/** Everything in `from` minus the tx fee, to `to`. Returns null when nothing is left to send. */
export async function sweepSol(conn: Connection, from: Keypair, to: PublicKey): Promise<{ sig: string; sol: number } | null> {
  const bal = await conn.getBalance(from.publicKey);
  const fee = 5000;
  if (bal <= fee) return null;
  const sig = await sendSol(conn, from, to, (bal - fee) / LAMPORTS_PER_SOL);
  return { sig, sol: (bal - fee) / LAMPORTS_PER_SOL };
}

export { publicClient };
```

- [ ] **Step 2: Typecheck this file alone**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep pool.ts`
Expected: no lines (other files still fail; that is expected until Task 10).

- [ ] **Step 3: Commit**

```bash
git add server/src/pool.ts
git commit -m "pool: operator wallets, floors, transfers"
```

---

### Task 5: Create a launch (`paid.ts`)

**Files:**
- Create: `server/src/paid.ts`
- Test: `server/src/paid.test.ts`

- [ ] **Step 1: Write the failing test**

`server/src/paid.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Registry } from "./registry.js";
import { createLaunch, validateInput, type CreateDeps } from "./paid.js";

const png = "data:image/png;base64," + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]).toString("base64");
const good = { name: "Doggo", symbol: "DOGGO", description: "two chains", twitter: "", website: "", telegram: "", devWallet: "H6CSd2BAQ2qzztEMYTFPRMzPU4voZjhr8wswfpneFvLY", imageDataUrl: png };

function deps(): CreateDeps {
  return {
    registry: new Registry(fs.mkdtempSync(path.join(os.tmpdir(), "paid-"))),
    pin: { file: async () => "imgcid", json: async () => "metacid" },
    quote: async () => ({
      depositSol: 0.1, frontSol: 1, frontEth: 0.03, devBuySol: 0.87, pumpTokens: 1, ponsEth: 0.01, ponsTokens: 1, makerCashEth: 0.02,
      openingFdv: 100, landing: { pump: 100, pons: 100 }, supplyPct: { pump: 1, pons: 1 }, fx: { SOL: 100, ETH: 2500 },
    }),
    deadlineMin: 60,
    now: () => 1_000,
  };
}

test("validateInput rejects bad fields", () => {
  assert.throws(() => validateInput({ ...good, symbol: "TOOLONGSYMBOL" }), /symbol/);
  assert.throws(() => validateInput({ ...good, devWallet: "nope" }), /devWallet/);
  assert.throws(() => validateInput({ ...good, imageDataUrl: "data:image/gif;base64,AAAA" }), /image/);
  assert.throws(() => validateInput({ ...good, name: "" }), /name/);
  assert.equal(validateInput(good).symbol, "DOGGO");
});

test("createLaunch writes record, keys and image", async () => {
  const d = deps();
  const rec = await createLaunch(d, good);
  assert.match(rec.id, /^doggo-/);
  assert.equal(rec.status, "awaiting_deposit");
  assert.equal(rec.payment.deadlineAt, 1_000 + 60 * 60_000);
  assert.equal(rec.token.metadataUri, "https://ipfs.io/ipfs/metacid");
  assert.ok(rec.wallets.pumpMint.length >= 32);
  assert.ok(rec.wallets.evmMaker.startsWith("0x"));
  const keys = d.registry.keys(rec.id);
  assert.equal(keys.mint.length, 64);
  assert.ok(fs.existsSync(d.registry.imagePath(rec.id)));
  assert.equal(d.registry.get(rec.id)?.wallets.payment, rec.payment.address);
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `npm test`
Expected: FAIL, cannot find `./paid.js`.

- [ ] **Step 3: Write `paid.ts`**

```ts
import fs from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Registry } from "./registry.js";
import { newRecord, type LaunchRecord, type Quote } from "./record.js";

export interface CreateInput {
  name: string; symbol: string; description: string; twitter?: string; website?: string; telegram?: string;
  devWallet: string; imageDataUrl: string;
}

export interface CreateDeps {
  registry: Registry;
  pin: { file: (path: string, name: string) => Promise<string>; json: (obj: unknown, name: string) => Promise<string> };
  quote: () => Promise<Quote>;
  deadlineMin: number;
  now: () => number;
}

const MAX_IMAGE = 2 * 1024 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPG = Buffer.from([0xff, 0xd8, 0xff]);

export function validateInput(raw: unknown): CreateInput & { image: Buffer } {
  const i = (raw ?? {}) as Record<string, unknown>;
  const str = (k: string, max: number, required = false) => {
    const v = typeof i[k] === "string" ? (i[k] as string).trim() : "";
    if (required && !v) throw new Error(`${k} is required`);
    if (v.length > max) throw new Error(`${k} max ${max} chars`);
    return v;
  };
  const name = str("name", 32, true);
  const symbol = str("symbol", 10, true).toUpperCase();
  if (!/^[A-Z0-9]+$/.test(symbol)) throw new Error("symbol must be letters and digits");
  const description = str("description", 500, true);
  const devWallet = str("devWallet", 64, true);
  try {
    new PublicKey(devWallet);
  } catch {
    throw new Error("devWallet is not a Solana address");
  }
  const url = typeof i.imageDataUrl === "string" ? i.imageDataUrl : "";
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!m) throw new Error("image must be a PNG or JPEG data URL");
  const image = Buffer.from(m[2], "base64");
  if (image.length > MAX_IMAGE) throw new Error("image max 2 MB");
  if (!(image.subarray(0, 4).equals(PNG) || image.subarray(0, 3).equals(JPG))) throw new Error("image bytes are not PNG/JPEG");
  return {
    name, symbol, description, devWallet, imageDataUrl: url, image,
    twitter: str("twitter", 120), website: str("website", 120), telegram: str("telegram", 120),
  };
}

/** Validate, store the image, pin image + metadata, generate keys, write the record. No chain calls. */
export async function createLaunch(d: CreateDeps, raw: unknown): Promise<LaunchRecord> {
  const input = validateInput(raw);
  const id = d.registry.newId(input.symbol);
  fs.mkdirSync(d.registry.dir(id), { recursive: true });
  fs.writeFileSync(d.registry.imagePath(id), input.image);

  const imageCid = await d.pin.file(d.registry.imagePath(id), `${input.symbol}.png`);
  const meta = {
    name: input.name, symbol: input.symbol, description: input.description,
    image: `https://ipfs.io/ipfs/${imageCid}`, showName: true, createdOn: "https://pump.fun",
    twitter: input.twitter || undefined, telegram: input.telegram || undefined, website: input.website || undefined,
  };
  const metadataCid = await d.pin.json(meta, `${input.symbol}-metadata.json`);

  const mint = Keypair.generate();
  const solCreator = Keypair.generate();
  const payment = Keypair.generate();
  const evmLauncherKey = generatePrivateKey();
  const evmMakerKey = generatePrivateKey();
  d.registry.saveKeys(id, {
    mint: Array.from(mint.secretKey), solCreator: Array.from(solCreator.secretKey), payment: Array.from(payment.secretKey),
    evmLauncher: evmLauncherKey, evmMaker: evmMakerKey,
  });

  const now = d.now();
  const rec = newRecord({
    id,
    now,
    deadlineAt: now + d.deadlineMin * 60_000,
    devWallet: input.devWallet,
    quote: await d.quote(),
    token: {
      name: input.name, symbol: input.symbol, description: input.description,
      twitter: input.twitter ?? "", website: input.website ?? "", telegram: input.telegram ?? "",
      imageCid, metadataCid, metadataUri: `https://ipfs.io/ipfs/${metadataCid}`,
    },
    wallets: {
      pumpMint: mint.publicKey.toBase58(),
      solCreator: solCreator.publicKey.toBase58(),
      evmLauncher: privateKeyToAccount(evmLauncherKey).address,
      evmMaker: privateKeyToAccount(evmMakerKey).address,
      payment: payment.publicKey.toBase58(),
    },
  });
  d.registry.save(rec);
  return rec;
}
```

- [ ] **Step 4: Run the test**

Run: `npm test`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add server/src/paid.ts server/src/paid.test.ts
git commit -m "paid: create a launch (validate, pin, keys, record)"
```

---

### Task 6: Payment watcher

**Files:**
- Create: `server/src/payments.ts`
- Test: `server/src/payments.test.ts`

- [ ] **Step 1: Write the failing test**

`server/src/payments.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "./payments.js";
import { newRecord } from "./record.js";

const quote = { depositSol: 0.5, frontSol: 1, frontEth: 0.03, devBuySol: 0.87, pumpTokens: 1, ponsEth: 0.01, ponsTokens: 1, makerCashEth: 0.02, openingFdv: 1, landing: { pump: 1, pons: 1 }, supplyPct: { pump: 1, pons: 1 }, fx: { SOL: 1, ETH: 1 } };
const rec = () => newRecord({
  id: "a-0000", now: 0, deadlineAt: 1000, devWallet: "DEV", quote,
  token: { name: "A", symbol: "A", description: "d", twitter: "", website: "", telegram: "", imageCid: "i", metadataCid: "m", metadataUri: "u" },
  wallets: { pumpMint: "M", solCreator: "C", evmLauncher: "0xL", evmMaker: "0xK", payment: "PAY" },
});

test("exact payment from the dev wallet marks paid", () => {
  const r = rec();
  const out = reconcile(r, [{ sig: "s1", from: "DEV", sol: 0.5, at: 10 }], 20);
  assert.equal(r.status, "paid");
  assert.equal(r.payment.paidAt, 20);
  assert.equal(r.payment.from, "DEV");
  assert.deepEqual(out.refunds, []);
});

test("partial then top-up, overpaid is recorded", () => {
  const r = rec();
  reconcile(r, [{ sig: "s1", from: "DEV", sol: 0.2, at: 10 }], 11);
  assert.equal(r.status, "awaiting_deposit");
  reconcile(r, [{ sig: "s1", from: "DEV", sol: 0.2, at: 10 }, { sig: "s2", from: "DEV", sol: 0.4, at: 12 }], 13);
  assert.equal(r.status, "paid");
  assert.equal(r.payment.txs.length, 2);
  assert.ok(Math.abs(r.payment.overpaidSol - 0.1) < 1e-9);
});

test("foreign payment is refunded and does not count", () => {
  const r = rec();
  const out = reconcile(r, [{ sig: "f1", from: "OTHER", sol: 0.5, at: 10 }], 11);
  assert.equal(r.status, "awaiting_deposit");
  assert.equal(r.payment.foreign.length, 1);
  assert.deepEqual(out.refunds, [{ to: "OTHER", sol: 0.5, sig: "f1", reason: "foreign" }]);
  assert.deepEqual(reconcile(r, [{ sig: "f1", from: "OTHER", sol: 0.5, at: 10 }], 12).refunds, []); // idempotent
});

test("payment after the deadline is late and refunded", () => {
  const r = rec();
  const out = reconcile(r, [{ sig: "l1", from: "DEV", sol: 0.5, at: 2000 }], 2001);
  assert.equal(r.status, "awaiting_deposit");
  assert.equal(r.payment.txs[0].late, true);
  assert.equal(out.refunds[0].reason, "late");
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `npm test`
Expected: FAIL, cannot find `./payments.js`.

- [ ] **Step 3: Write `payments.ts`**

```ts
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import type { Registry } from "./registry.js";
import { transition, step, type LaunchRecord } from "./record.js";
import { sendSol, sweepSol } from "./pool.js";

export interface Observed { sig: string; from: string; sol: number; at: number }
export interface Refund { to: string; sol: number; sig: string; reason: "foreign" | "late" }

/** Pure: fold newly observed transfers into the record. Returns refunds the caller must execute. */
export function reconcile(rec: LaunchRecord, observed: Observed[], now: number): { refunds: Refund[] } {
  const p = rec.payment;
  const seen = new Set([...p.txs, ...p.foreign].map((t) => t.tx));
  const refunds: Refund[] = [];
  for (const o of observed) {
    if (seen.has(o.sig)) continue;
    seen.add(o.sig);
    const late = o.at > p.deadlineAt;
    if (o.from !== p.expectedFrom) {
      p.foreign.push({ tx: o.sig, from: o.from, sol: o.sol, at: o.at, late });
      refunds.push({ to: o.from, sol: o.sol, sig: o.sig, reason: "foreign" });
      continue;
    }
    p.txs.push({ tx: o.sig, from: o.from, sol: o.sol, at: o.at, late });
    if (late) {
      refunds.push({ to: o.from, sol: o.sol, sig: o.sig, reason: "late" });
      continue;
    }
    p.receivedSol = round(p.receivedSol + o.sol);
  }
  if (rec.status === "awaiting_deposit" && p.receivedSol >= p.requiredSol) {
    p.paidAt = now;
    p.from = p.expectedFrom;
    p.overpaidSol = round(p.receivedSol - p.requiredSol);
    transition(rec, "paid", now);
  }
  return { refunds };
}

const round = (n: number) => Math.round(n * 1e9) / 1e9;

/** Incoming SOL transfers to `address`: fee payer of each tx and the address's balance delta. */
export async function observeTransfers(conn: Connection, address: PublicKey, known: Set<string>): Promise<Observed[]> {
  const sigs = await conn.getSignaturesForAddress(address, { limit: 25 }, "confirmed");
  const out: Observed[] = [];
  for (const s of sigs) {
    if (known.has(s.signature) || s.err) continue;
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx || !tx.meta) continue;
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined });
    const idx = keys.staticAccountKeys.findIndex((k) => k.equals(address));
    if (idx < 0) continue;
    const delta = (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / LAMPORTS_PER_SOL;
    if (delta <= 0) continue;
    out.push({ sig: s.signature, from: keys.staticAccountKeys[0].toBase58(), sol: delta, at: (tx.blockTime ?? 0) * 1000 || Date.now() });
  }
  return out;
}

/** Runs every `intervalMs`: reconcile open records, refund foreign/late, expire past deadline. */
export class PaymentWatcher {
  private timer: NodeJS.Timeout | null = null;
  constructor(private conn: Connection, private registry: Registry, private intervalMs = 5000) {}

  start() {
    const loop = async () => {
      try {
        await this.tick();
      } catch (e) {
        console.error("[payments]", (e as Error).message);
      }
      this.timer = setTimeout(loop, this.intervalMs);
    };
    void loop();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }

  async tick(now = Date.now()) {
    for (const rec of this.registry.list({ status: ["awaiting_deposit"] })) {
      const keys = this.registry.keys(rec.id);
      const payKp = Keypair.fromSecretKey(Uint8Array.from(keys.payment));
      const known = new Set([...rec.payment.txs, ...rec.payment.foreign].map((t) => t.tx));
      const observed = await observeTransfers(this.conn, payKp.publicKey, known);
      const { refunds } = reconcile(rec, observed, now);
      for (const r of refunds) {
        try {
          const sig = await sendSol(this.conn, payKp, new PublicKey(r.to), r.sol - 0.000005);
          step(rec, "refund", now, { reason: r.reason, to: r.to, sol: r.sol, tx: sig });
        } catch (e) {
          step(rec, "refund_failed", now, { reason: r.reason, to: r.to, sol: r.sol, error: (e as Error).message });
        }
      }
      if (rec.status === "awaiting_deposit" && now > rec.payment.deadlineAt && rec.payment.receivedSol < rec.payment.requiredSol) {
        transition(rec, "expired", now);
        await refundDeposit(this.conn, this.registry, rec, now);
      }
      if (observed.length || refunds.length || rec.status !== "awaiting_deposit") this.registry.save(rec);
    }
  }
}

/** Sweep whatever sits on the payment address back to the dev wallet (reject / expire). */
export async function refundDeposit(conn: Connection, registry: Registry, rec: LaunchRecord, now: number) {
  const payKp = Keypair.fromSecretKey(Uint8Array.from(registry.keys(rec.id).payment));
  try {
    const r = await sweepSol(conn, payKp, new PublicKey(rec.devWallet));
    if (r) {
      rec.refund.sol = round(rec.refund.sol + r.sol);
      rec.refund.paidSol = rec.payment.receivedSol;
      rec.refund.txs.push(r.sig);
      step(rec, "deposit_refunded", now, { sol: r.sol, tx: r.sig });
    }
  } catch (e) {
    step(rec, "refund_failed", now, { error: (e as Error).message });
  }
  registry.save(rec);
}
```

- [ ] **Step 4: Run the test**

Run: `npm test`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add server/src/payments.ts server/src/payments.test.ts
git commit -m "payments: watch deposit addresses, refund foreign/late, expire"
```

---

### Task 7: Scheduler (approval + queue)

**Files:**
- Create: `server/src/scheduler.ts`
- Test: `server/src/scheduler.test.ts`

- [ ] **Step 1: Write the failing test**

`server/src/scheduler.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { plan } from "./scheduler.js";
import { newRecord, transition, type LaunchRecord } from "./record.js";

const quote = { depositSol: 0.5, frontSol: 1, frontEth: 0.03, devBuySol: 0.87, pumpTokens: 1, ponsEth: 0.01, ponsTokens: 1, makerCashEth: 0.02, openingFdv: 1, landing: { pump: 1, pons: 1 }, supplyPct: { pump: 1, pons: 1 }, fx: { SOL: 1, ETH: 1 } };
const mk = (id: string, status: LaunchRecord["status"], createdAt = 0) => {
  const r = newRecord({ id, now: createdAt, deadlineAt: 1000, devWallet: "D", quote,
    token: { name: "A", symbol: "A", description: "d", twitter: "", website: "", telegram: "", imageCid: "i", metadataCid: "m", metadataUri: "u" },
    wallets: { pumpMint: "M", solCreator: "C", evmLauncher: "0xL", evmMaker: "0xK", payment: "P" } });
  const path: Record<string, LaunchRecord["status"][]> = { paid: ["paid"], approved: ["paid", "approved"], launching: ["paid", "approved", "launching"], live: ["paid", "approved", "launching", "live"] };
  for (const s of path[status] ?? []) transition(r, s, createdAt);
  return r;
};

test("auto-approve when enabled and below the maker cap", () => {
  const acts = plan([mk("a", "paid")], { autoApprove: true, maxLiveMakers: 1 });
  assert.deepEqual(acts, [{ type: "approve", id: "a" }, { type: "launch", id: "a" }]);
});

test("no auto-approve when disabled or cap reached", () => {
  assert.deepEqual(plan([mk("a", "paid")], { autoApprove: false, maxLiveMakers: 5 }), []);
  assert.deepEqual(plan([mk("a", "paid"), mk("b", "live")], { autoApprove: true, maxLiveMakers: 1 }), []);
});

test("launch oldest approved, one at a time", () => {
  const acts = plan([mk("new", "approved", 5), mk("old", "approved", 1)], { autoApprove: false, maxLiveMakers: 5 });
  assert.deepEqual(acts, [{ type: "launch", id: "old" }]);
  assert.deepEqual(plan([mk("a", "approved"), mk("b", "launching")], { autoApprove: false, maxLiveMakers: 5 }), []);
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `npm test`
Expected: FAIL, cannot find `./scheduler.js`.

- [ ] **Step 3: Write `scheduler.ts`**

```ts
import type { Registry } from "./registry.js";
import { transition, type LaunchRecord } from "./record.js";

export type Action = { type: "approve"; id: string } | { type: "launch"; id: string };
export interface PlanConfig { autoApprove: boolean; maxLiveMakers: number }

/** Pure: given all records, what to do now. Approves paid records (auto mode) and picks one launch. */
export function plan(records: LaunchRecord[], cfg: PlanConfig): Action[] {
  const acts: Action[] = [];
  const busy = records.filter((r) => ["live", "launching", "approved"].includes(r.status)).length;
  let slots = cfg.maxLiveMakers - busy;
  const approved = records.filter((r) => r.status === "approved").sort((a, b) => a.createdAt - b.createdAt);
  if (cfg.autoApprove) {
    for (const r of records.filter((r) => r.status === "paid").sort((a, b) => a.createdAt - b.createdAt)) {
      if (slots <= 0) break;
      acts.push({ type: "approve", id: r.id });
      approved.push(r);
      slots--;
    }
  }
  const launching = records.some((r) => r.status === "launching");
  if (!launching && approved.length) acts.push({ type: "launch", id: approved.sort((a, b) => a.createdAt - b.createdAt)[0].id });
  return acts;
}

export function approve(rec: LaunchRecord, now: number, auto: boolean, note: string | null = null) {
  rec.approval = { status: "approved", at: now, note, auto };
  transition(rec, "approved", now);
}

export function reject(rec: LaunchRecord, now: number, note: string | null) {
  rec.approval = { status: "rejected", at: now, note, auto: false };
  transition(rec, "rejected", now);
}

/** Every `intervalMs`: plan, apply approvals, start at most one launch (awaited, so launches are serial). */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  constructor(
    private registry: Registry,
    private cfg: PlanConfig,
    private launch: (rec: LaunchRecord) => Promise<void>,
    private intervalMs = 30_000,
  ) {}

  start() {
    const loop = async () => {
      await this.tick().catch((e) => console.error("[scheduler]", (e as Error).message));
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
      for (const a of plan(this.registry.list(), this.cfg)) {
        const rec = this.registry.get(a.id)!;
        if (a.type === "approve") {
          approve(rec, now, true);
          this.registry.save(rec);
        } else {
          await this.launch(rec);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npm test`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add server/src/scheduler.ts server/src/scheduler.test.ts
git commit -m "scheduler: auto-approve within the maker cap, serial launches"
```

---

### Task 8: Launcher library

**Files:**
- Create: `server/src/launcher.ts`
- Delete: `server/src/launch.ts`, `server/scripts/make_image.py`, `server/assets/BRAID.png`, `server/keys/mint.json`

No unit test; chain-only. Every step checks its checkpoint in `rec.launch.txs` first so a crash resumes.

- [ ] **Step 1: Write `launcher.ts`**

```ts
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { formatEther, getAddress, toHex, type Address, type Hex, type PublicClient } from "viem";
import type { Config } from "./config.js";
import type { Registry } from "./registry.js";
import { step, transition, type LaunchRecord } from "./record.js";
import type { Pool } from "./pool.js";
import { sweepSol } from "./pool.js";
import { coinExists, readBondingCurve, sendSigned, tradeLocal } from "./solana/pump.js";
import { buildLaunchCalldata, launchPreflight, parseTokenLaunched, readCurve, walletClient, PONS, TOKEN_SUPPLY } from "./evm/pons.js";
import { evmBuy, evmBalances, solanaBalances } from "./trade.js";
import { grossFromNet, quoteNetForFdv } from "./quote.js";

export interface LaunchCtx {
  cfg: Config;
  registry: Registry;
  pool: Pool;
  conn: Connection;
  pub: PublicClient;
  fx: () => Promise<{ SOL: number; ETH: number }>;
  log?: (msg: string) => void;
}

/**
 * Run one launch from its per-coin wallets. Copies TWINE V2 (spec §10.5): fronting → deposit to pool →
 * pump.fun create + dev buy (creator = maker on Solana) → Pons launchToken from the launcher with the
 * maker as creatorFeeRecipient and exemptions [launcher, maker] → maker curve buy sized to land at the
 * pump.fun fdv → live. Sets status failed with `launch.error` on any throw; retry re-enters here.
 */
export async function runLaunch(ctx: LaunchCtx, rec: LaunchRecord): Promise<void> {
  const log = ctx.log ?? ((m: string) => console.log(`[launch ${rec.id}] ${m}`));
  const save = () => ctx.registry.save(rec);
  const now = () => Date.now();
  const keys = ctx.registry.keys(rec.id);
  const mintKp = Keypair.fromSecretKey(Uint8Array.from(keys.mint));
  const creator = Keypair.fromSecretKey(Uint8Array.from(keys.solCreator));
  const payKp = Keypair.fromSecretKey(Uint8Array.from(keys.payment));
  const launcherW = walletClient(ctx.cfg.evm.rpcUrl, keys.evmLauncher);
  const makerW = walletClient(ctx.cfg.evm.rpcUrl, keys.evmMaker);
  const launcher = getAddress(rec.wallets.evmLauncher) as Address;
  const maker = getAddress(rec.wallets.evmMaker) as Address;
  const MINT = mintKp.publicKey;
  const L = rec.launch;
  const T = rec.token;

  if (rec.status === "approved") transition(rec, "launching", now());
  if (rec.status !== "launching") throw new Error(`runLaunch on status ${rec.status}`);
  L.startedAt ??= now();
  L.error = null;
  save();

  try {
    // ---- preflight
    const pf = await launchPreflight(ctx.pub, launcher);
    if (!pf.canLaunch || !pf.launchEnabled || !pf.config.enabled) throw new Error("Pons factory refuses launches right now");
    const launchFee = Number(formatEther(pf.launchFee));
    const needEth = launchFee + ctx.cfg.launch.evmGasLauncher + rec.front.eth;
    if (!L.txs.frontSol || !L.txs.frontRhMaker) {
      const can = await ctx.pool.canFront(rec.front.sol, needEth);
      if (!can.ok) throw new Error(`pool below floor: ${JSON.stringify(can.balances)} needs ${rec.front.sol} SOL + ${needEth.toFixed(4)} ETH`);
    }
    if (!L.salt) L.salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
    step(rec, "preflight", now(), { launchFee, canLaunch: pf.canLaunch });
    save();

    // ---- fronting: pool → creator (SOL), pool → launcher (fee + gas), pool → maker (front.eth)
    if (!L.txs.frontSol) {
      L.txs.frontSol = await ctx.pool.transferSol(creator.publicKey, rec.front.sol);
      save();
    }
    if (!L.txs.frontRhLauncher) {
      L.txs.frontRhLauncher = await ctx.pool.transferEth(launcher, launchFee + ctx.cfg.launch.evmGasLauncher);
      save();
    }
    if (!L.txs.frontRhMaker) {
      L.txs.frontRhMaker = await ctx.pool.transferEth(maker, rec.front.eth);
      save();
    }
    if (!rec.front.at) {
      rec.front = { ...rec.front, at: now(), txSol: L.txs.frontSol, txRhLauncher: L.txs.frontRhLauncher, txRhMaker: L.txs.frontRhMaker };
      step(rec, "fronting", now(), { sol: rec.front.sol, eth: rec.front.eth, txSol: L.txs.frontSol, txRh: L.txs.frontRhMaker });
      save();
    }

    // ---- deposit → pool
    if (!rec.payment.toPoolTx) {
      const swept = await sweepSol(ctx.conn, payKp, ctx.pool.sol.publicKey);
      rec.payment.toPoolTx = swept?.sig ?? "none";
      step(rec, "deposit_to_pool", now(), { sol: swept?.sol ?? 0, tx: swept?.sig ?? null });
      save();
    }
    step(rec, "funded", now(), { makerSol: rec.front.sol, makerEth: rec.front.eth });
    log("funded");

    // ---- pump.fun create + dev buy, creator == maker
    if (!L.txs.pumpCreate) {
      const exists = await coinExists(ctx.conn, MINT);
      if (exists.onChain) throw new Error("mint already has on-chain history");
      const tx = await tradeLocal({
        publicKey: creator.publicKey.toBase58(),
        action: "create",
        tokenMetadata: { name: T.name, symbol: T.symbol, uri: T.metadataUri },
        mint: MINT.toBase58(),
        denominatedInSol: "true",
        amount: rec.quote.devBuySol,
        slippage: ctx.cfg.solana.slippagePct,
        priorityFee: ctx.cfg.solana.priorityFeeSol,
        pool: "pump",
      });
      tx.sign([mintKp, creator]);
      L.txs.pumpCreate = await sendSigned(ctx.conn, tx);
      L.pumpMint = MINT.toBase58();
      L.launchedAt = now();
      save();
    }
    log(`pump create ${L.txs.pumpCreate}`);
    const curve = await readBondingCurve(ctx.conn, MINT);
    if (!curve) throw new Error("bonding curve not found after create");
    const fx = await ctx.fx();
    const targetUsd = curve.fdvSol * fx.SOL;

    // ---- Pons launchToken from the launcher wallet
    if (!L.txs.ponsLaunch) {
      const data = buildLaunchCalldata(
        {
          name: T.name, symbol: T.symbol, logo: `ipfs://${T.imageCid}`, description: T.description,
          twitter: T.twitter, telegram: T.telegram, website: T.website,
          creatorFeeRecipient: maker, creatorTaxBps: ctx.cfg.evm.creatorTaxBps, salt: L.salt as Hex, exemptions: [launcher, maker],
        },
        pf.expectedEconomics,
      );
      const gas = await ctx.pub.estimateGas({ account: launcher, to: PONS.factory, data, value: pf.launchFee });
      const hash = await launcherW.sendTransaction({ account: launcherW.account!, chain: launcherW.chain, to: PONS.factory, data, value: pf.launchFee, gas: (gas * 12n) / 10n });
      L.txs.ponsLaunch = hash;
      save();
    }
    if (!L.ponsToken) {
      const receipt = await ctx.pub.waitForTransactionReceipt({ hash: L.txs.ponsLaunch as Hex, timeout: 180_000 });
      if (receipt.status !== "success") throw new Error(`launchToken reverted: ${L.txs.ponsLaunch}`);
      const launched = parseTokenLaunched(receipt.logs as any);
      if (!launched) throw new Error("TokenLaunched event not found");
      L.ponsToken = launched.token;
      L.ponsCurve = launched.curve;
      save();
    }
    log(`pons token ${L.ponsToken}`);

    // ---- maker buy on Pons sized to land at the pump.fun fdv
    if (!L.txs.evmMakerBuy) {
      const c = await readCurve(ctx.pub, L.ponsToken as Address);
      const Q = Number(c.quoteReserve) / 1e18, Tk = Number(c.tokenReserve) / 1e18;
      const net = quoteNetForFdv(Q, Tk, TOKEN_SUPPLY, targetUsd / fx.ETH);
      const wanted = grossFromNet(net, Number(c.feeBps), c.creatorTaxBps);
      const eth = Math.max(0, Math.min(wanted, rec.front.eth - ctx.cfg.launch.evmMakerCash));
      step(rec, "pons_sizing", now(), { targetUsd: Math.round(targetUsd), wantedEth: wanted, eth });
      L.txs.evmMakerBuy = eth > 0 ? await evmBuy(ctx.pub, makerW, L.ponsToken as Address, eth, ctx.cfg.solana.slippagePct) : "skipped";
      save();
    }

    // ---- live
    const [s, e] = await Promise.all([solanaBalances(ctx.conn, creator.publicKey, MINT), evmBalances(ctx.pub, maker, L.ponsToken as Address)]);
    rec.seed = { pumpTokens: Math.round(s.tokens), ponsTokens: Math.round(e.tokens), openingFdv: Math.round(targetUsd), at: now() };
    step(rec, "launched", now(), { pumpMint: L.pumpMint, ponsToken: L.ponsToken, pilePump: rec.seed.pumpTokens, pilePons: rec.seed.ponsTokens });
    transition(rec, "live", now(), { coinId: rec.id });
    save();
    log("live");
  } catch (e) {
    L.error = (e as Error).message.split("\n")[0].slice(0, 300);
    transition(rec, "failed", now(), { error: L.error });
    save();
    log(`FAILED: ${L.error}`);
  }
}

export function pairOf(rec: LaunchRecord) {
  return { pumpMint: new PublicKey(rec.launch.pumpMint!), ponsToken: getAddress(rec.launch.ponsToken!) as Address };
}
```

- [ ] **Step 2: Delete the single-coin launcher and its artifacts**

```bash
git rm -q server/src/launch.ts
rm -f server/scripts/make_image.py server/assets/BRAID.png server/keys/mint.json
rmdir server/assets server/keys 2>/dev/null; true
```

- [ ] **Step 3: Typecheck this file alone**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep launcher.ts`
Expected: no lines.

- [ ] **Step 4: Commit**

```bash
git add -A server/src/launcher.ts server/src/launch.ts server/scripts
git commit -m "launcher: run one launch from per-coin wallets with checkpoints"
```

---

### Task 9: Per-coin state, poller, makers

**Files:**
- Create: `server/src/coin.ts`, `server/src/poller.ts`, `server/src/makers.ts`
- Modify: `server/src/maker.ts`
- Delete: `server/src/state.ts`
- Test: `server/src/coin.test.ts`

- [ ] **Step 1: Write the failing test**

`server/src/coin.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CoinState } from "./coin.js";

const side = (fdv: number) => ({ chain: "", venue: "", kind: "curve" as const, phase: "curve" as const, phaseLabel: "", fdv, price: 1, quoteSymbol: "SOL" as const, quoteDepth: 0, progress: 0, realQuote: 0, at: 0 });

test("gap, snapshot and persistence per coin", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coin-"));
  const c = new CoinState(dir, "doggo-ab12", 0.05, { pumpMint: "M", ponsToken: "0xT", ponsCurve: "0xC", launchedAt: 1, name: "Doggo", symbol: "DOGGO" }, { name: "Doggo", symbol: "DOGGO", image: "i", twitter: "", website: "", description: "d" });
  c.pump = side(100);
  c.pons = side(110);
  assert.deepEqual(c.gap(), { gap: 0.1, expensive: "pons" });
  c.pushPoint();
  c.persist();
  const s = c.snapshot("1h");
  assert.equal(s.status, "live");
  assert.equal(s.coin.id, "doggo-ab12");
  assert.equal(s.inBand, false);
  assert.ok(fs.existsSync(path.join(dir, "state", "doggo-ab12.json")));
  const again = new CoinState(dir, "doggo-ab12", 0.05, s.pair!, s.meta!);
  assert.equal(again.series.length, 1);
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `npm test`
Expected: FAIL, cannot find `./coin.js`.

- [ ] **Step 3: Write `coin.ts`** (today's `state.ts` without launch-file loading; `LaunchRecord` type removed)

```ts
import fs from "node:fs";
import path from "node:path";
import type { SideState } from "./prices.js";

export interface Pair { pumpMint: string; ponsToken: string; ponsCurve: string; launchedAt: number | null; name: string; symbol: string }
export interface Meta { name: string; symbol: string; image: string; twitter: string; website: string; description: string }
export interface SeriesPoint { t: number; pump: number; pons: number }
export interface Trade { t: number; side: "pump" | "pons"; action: "buy" | "sell"; amount: string; reason: string; tx?: string; error?: string }
export interface Inventory { at: number; solana: { sol: number; tokens: number }; evm: { eth: number; tokens: number; escrowEth: number } }
export interface MakerStatus { enabled: boolean; running: boolean; halted: boolean; haltReason: string | null; consecutiveErrors: number; lastTick: number; ticks: number; trades: number }

/** Live state of one coin: both sides, series, trades, maker status. Persists series/trades to DATA_DIR/state/<id>.json. */
export class CoinState {
  pump: SideState | null = null;
  pons: SideState | null = null;
  fx: { SOL: number; ETH: number } = { SOL: 0, ETH: 0 };
  series: SeriesPoint[] = [];
  trades: Trade[] = [];
  inventory: Inventory | null = null;
  maker: MakerStatus = { enabled: false, running: false, halted: false, haltReason: null, consecutiveErrors: 0, lastTick: 0, ticks: 0, trades: 0 };
  errors = { pump: 0, pons: 0 };
  lastError: { pump: string | null; pons: string | null } = { pump: null, pons: null };
  private file: string;

  constructor(dataDir: string, readonly id: string, readonly band: number, readonly pair: Pair, readonly meta: Meta) {
    const dir = path.join(dataDir, "state");
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${id}.json`);
    try {
      if (fs.existsSync(this.file)) {
        const j = JSON.parse(fs.readFileSync(this.file, "utf8")) as { series?: SeriesPoint[]; trades?: Trade[] };
        this.series = j.series ?? [];
        this.trades = j.trades ?? [];
      }
    } catch {
      this.series = [];
    }
  }

  persist() {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    this.series = this.series.filter((p) => p.t >= cutoff);
    this.trades = this.trades.slice(-2000);
    fs.writeFileSync(this.file, JSON.stringify({ series: this.series, trades: this.trades }));
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
    return { gap: (hi - lo) / lo, expensive: this.pump.fdv > this.pons.fdv ? "pump" : "pons" };
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
    return { id: this.id, name: this.meta.name, symbol: this.meta.symbol, image: this.meta.image, launchedAt: this.pair.launchedAt,
      pumpFdv: this.pump?.fdv ?? null, ponsFdv: this.pons?.fdv ?? null, gap: g?.gap ?? null, inBand: g ? g.gap <= this.band : null, maker: this.maker.halted ? "halted" : this.maker.running ? "running" : "off" };
  }
}
```

- [ ] **Step 4: Write `poller.ts`**

```ts
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

  private async one(c: CoinState, rates: { SOL: number; ETH: number }) {
    c.fx = rates;
    const mint = new PublicKey(c.pair.pumpMint);
    const token = getAddress(c.pair.ponsToken) as Address;
    const [p, q] = await Promise.allSettled([pumpSide(this.conn, mint, rates.SOL), ponsSide(this.pub, token, rates.ETH)]);
    if (p.status === "fulfilled") c.pump = p.value;
    else { c.errors.pump++; c.lastError.pump = p.reason?.message ?? String(p.reason); }
    if (q.status === "fulfilled") c.pons = q.value;
    else { c.errors.pons++; c.lastError.pons = q.reason?.message ?? String(q.reason); }
    c.pushPoint();
    if (c.series.length % 15 === 0) c.persist();
  }
}
```

- [ ] **Step 5: Modify `maker.ts`**

Replace the imports and constructor, and every `this.state` / `st.launch` use, so the class reads:

```ts
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAddress, type Address, type PublicClient, type WalletClient } from "viem";
import type { Config } from "./config.js";
import type { CoinState } from "./coin.js";
import { escrowAbi, PONS } from "./evm/pons.js";
import { evmBalances, evmBuy, evmSell, solanaBalances, solanaBuy, solanaSell } from "./trade.js";

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
  ) {}
```

then in the body: `this.state` → `this.coin`, `const st = this.state` → `const st = this.coin`, `st.launch.pumpMint` → `st.pair.pumpMint`, `st.launch.ponsToken` → `st.pair.ponsToken`, `const l = this.state.launch!` → `const l = this.coin.pair`, `if (!st.launch || !st.pump || !st.pons) return;` → `if (!st.pump || !st.pons) return;`. Add after `stop()`:

```ts
  resume() {
    this.coin.maker.halted = false;
    this.coin.maker.haltReason = null;
    this.coin.maker.consecutiveErrors = 0;
    this.start();
  }
```

and in `stop()` set `this.coin.maker.enabled = false` is NOT desired (halt keeps `enabled`); leave `stop()` as is.

- [ ] **Step 6: Write `makers.ts`**

```ts
import { Connection, Keypair } from "@solana/web3.js";
import type { PublicClient } from "viem";
import type { Config } from "./config.js";
import type { Registry } from "./registry.js";
import type { CoinState } from "./coin.js";
import { Maker } from "./maker.js";
import { walletClient } from "./evm/pons.js";

/** One Maker per live coin, armed when the coin appears (`engine_armed`). */
export class Makers {
  private makers = new Map<string, Maker>();
  constructor(private cfg: Config, private registry: Registry, private conn: Connection, private pub: PublicClient) {}

  arm(coin: CoinState) {
    if (this.makers.has(coin.id) || !this.cfg.maker.enabled) return;
    const keys = this.registry.keys(coin.id);
    const m = new Maker(this.cfg, coin, this.conn, Keypair.fromSecretKey(Uint8Array.from(keys.solCreator)), this.pub, walletClient(this.cfg.evm.rpcUrl, keys.evmMaker));
    this.makers.set(coin.id, m);
    m.start();
    console.log(`[maker ${coin.id}] armed`);
  }

  halt(id: string, reason = "admin") {
    const m = this.makers.get(id);
    if (!m) return false;
    m.stop();
    const c = this.coinOf(id);
    if (c) { c.maker.halted = true; c.maker.haltReason = reason; }
    return true;
  }

  resume(id: string) {
    const m = this.makers.get(id);
    if (!m) return false;
    m.resume();
    return true;
  }

  private coins = new Map<string, CoinState>();
  register(coin: CoinState) { this.coins.set(coin.id, coin); }
  private coinOf(id: string) { return this.coins.get(id); }
}
```

- [ ] **Step 7: Delete `state.ts`, run tests**

```bash
git rm -q server/src/state.ts
npm test
```

Expected: all passing (the maker/prices modules have no tests; `index.ts`/`api.ts` still fail typecheck until Task 10).

- [ ] **Step 8: Commit**

```bash
git add -A server/src/coin.ts server/src/coin.test.ts server/src/poller.ts server/src/maker.ts server/src/makers.ts server/src/state.ts
git commit -m "coin state, poller and makers per live coin"
```

---

### Task 10: API and wiring

**Files:**
- Rewrite: `server/src/api.ts`, `server/src/index.ts`
- Modify: `server/src/ipfs.ts` (no change needed; used as-is)
- Test: `server/src/api.test.ts`

- [ ] **Step 1: Write the failing test** (router + auth + rate limit, no chain)

`server/src/api.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Router, RateLimit } from "./api.js";

test("router matches method + params and returns 404 otherwise", async () => {
  const r = new Router();
  r.get("/api/paid/:id", (p) => ({ id: p.id }));
  assert.deepEqual(await r.dispatch("GET", "/api/paid/doggo-ab12", null, {}), { status: 200, body: { id: "doggo-ab12" } });
  assert.equal((await r.dispatch("POST", "/api/paid/x", null, {})).status, 404);
});

test("admin routes need the token", async () => {
  const r = new Router("tok");
  r.post("/api/admin/ping", () => ({ ok: true }), { admin: true });
  assert.equal((await r.dispatch("POST", "/api/admin/ping", null, {})).status, 401);
  assert.equal((await r.dispatch("POST", "/api/admin/ping", null, { "x-admin-token": "tok" })).status, 200);
});

test("rate limit: one per window per key", () => {
  const rl = new RateLimit(1000);
  assert.equal(rl.allow("ip", 0), true);
  assert.equal(rl.allow("ip", 500), false);
  assert.equal(rl.allow("ip", 1001), true);
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `npm test`
Expected: FAIL (`Router` not exported).

- [ ] **Step 3: Rewrite `api.ts`**

```ts
import http from "node:http";

type Params = Record<string, string>;
type Handler = (params: Params, body: unknown, headers: Record<string, string | string[] | undefined>, ip: string) => unknown | Promise<unknown>;
interface Route { method: string; re: RegExp; keys: string[]; handler: Handler; admin: boolean }

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Minimal router: `:param` segments, admin gate via x-admin-token. */
export class Router {
  private routes: Route[] = [];
  constructor(private adminToken = "") {}

  private add(method: string, pattern: string, handler: Handler, opts: { admin?: boolean } = {}) {
    const keys: string[] = [];
    const re = new RegExp("^" + pattern.replace(/:([a-zA-Z]+)/g, (_m, k) => { keys.push(k); return "([^/]+)"; }) + "$");
    this.routes.push({ method, re, keys, handler, admin: !!opts.admin });
  }
  get(p: string, h: Handler, o?: { admin?: boolean }) { this.add("GET", p, h, o); }
  post(p: string, h: Handler, o?: { admin?: boolean }) { this.add("POST", p, h, o); }

  async dispatch(method: string, pathname: string, body: unknown, headers: Record<string, string | string[] | undefined>, ip = ""): Promise<{ status: number; body: unknown }> {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      if (r.admin && (!this.adminToken || headers["x-admin-token"] !== this.adminToken)) return { status: 401, body: { error: "unauthorized" } };
      const params: Params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      try {
        return { status: 200, body: await r.handler(params, body, headers, ip) };
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 400;
        return { status, body: { error: (e as Error).message } };
      }
    }
    return { status: 404, body: { error: "not found" } };
  }
}

export class RateLimit {
  private last = new Map<string, number>();
  constructor(private windowMs: number) {}
  allow(key: string, now = Date.now()) {
    const t = this.last.get(key) ?? -Infinity;
    if (now - t < this.windowMs) return false;
    this.last.set(key, now);
    return true;
  }
}

export function serve(router: Router, port: number, corsOrigin: string, maxBody = 3 * 1024 * 1024) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "access-control-allow-origin": corsOrigin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-admin-token",
      "cache-control": "no-store",
    };
    if (req.method === "OPTIONS") { res.writeHead(204, headers); res.end(); return; }
    let body: unknown = null;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > maxBody) { res.writeHead(413, headers); res.end(JSON.stringify({ error: "body too large" })); return; }
        chunks.push(c as Buffer);
      }
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null; } catch { res.writeHead(400, headers); res.end(JSON.stringify({ error: "bad json" })); return; }
    }
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0].trim() || req.socket.remoteAddress || "";
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (query[k] = v));
    const out = await router.dispatch(req.method ?? "GET", url.pathname, body, { ...req.headers, __query: JSON.stringify(query) } as any, ip);
    res.writeHead(out.status, headers);
    res.end(JSON.stringify(out.body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  });
  server.listen(port, () => console.log(`[api] listening on :${port}`));
  return server;
}

/** Query string helper for handlers (serialized into headers.__query by `serve`). */
export function query(headers: Record<string, unknown>): Record<string, string> {
  try { return JSON.parse((headers.__query as string) ?? "{}"); } catch { return {}; }
}
```

- [ ] **Step 4: Rewrite `index.ts`**

```ts
import { PublicKey } from "@solana/web3.js";
import { config, redactedConfig } from "./config.js";
import { Registry } from "./registry.js";
import { Pool } from "./pool.js";
import { connection } from "./solana/pump.js";
import { publicClient, launchPreflight, PONS } from "./evm/pons.js";
import { fx } from "./fx.js";
import { pinFile, pinJson } from "./ipfs.js";
import { createLaunch } from "./paid.js";
import { buildQuote } from "./quote.js";
import { PaymentWatcher, refundDeposit } from "./payments.js";
import { Scheduler, approve, reject } from "./scheduler.js";
import { runLaunch } from "./launcher.js";
import { CoinState } from "./coin.js";
import { Poller } from "./poller.js";
import { Makers } from "./makers.js";
import { Router, RateLimit, HttpError, serve, query } from "./api.js";
import { OPEN_STATUSES, transition, type LaunchRecord } from "./record.js";
import { formatEther } from "viem";

async function main() {
  console.log("[boot] config", JSON.stringify(redactedConfig()));
  const conn = connection(config.solana.rpcUrl);
  const pub = publicClient(config.evm.rpcUrl);
  const registry = new Registry(config.server.dataDir);
  const pool = new Pool(config, conn, pub);
  console.log(`[boot] pool solana ${pool.sol.publicKey.toBase58()} robinhood ${pool.evmAddress}`);

  // ---- live coins
  const coins = new Map<string, CoinState>();
  const makers = new Makers(config, registry, conn, pub);
  const mount = (rec: LaunchRecord) => {
    if (coins.has(rec.id)) return coins.get(rec.id)!;
    const c = new CoinState(config.server.dataDir, rec.id, config.maker.band,
      { pumpMint: rec.launch.pumpMint!, ponsToken: rec.launch.ponsToken!, ponsCurve: rec.launch.ponsCurve!, launchedAt: rec.launch.launchedAt, name: rec.token.name, symbol: rec.token.symbol },
      { name: rec.token.name, symbol: rec.token.symbol, image: `https://ipfs.io/ipfs/${rec.token.imageCid}`, twitter: rec.token.twitter, website: rec.token.website, description: rec.token.description });
    coins.set(rec.id, c);
    makers.register(c);
    makers.arm(c);
    return c;
  };
  for (const rec of registry.list({ status: ["live"] })) mount(rec);
  new Poller(conn, pub, () => [...coins.values()]).start();

  // ---- quote from live chain params
  const quoteNow = async () => {
    const [rates, pf] = await Promise.all([fx(), launchPreflight(pub, PONS.ZERO)]);
    return buildQuote({
      depositSol: config.launch.depositSol, frontSol: config.launch.frontSol, frontEth: config.launch.frontEth,
      solGasBudget: config.launch.solGasBudget, evmMakerCash: config.launch.evmMakerCash, fx: rates,
      pons: { phantomEth: Number(formatEther(pf.config.phantomQuote)), supply: Number(formatEther(pf.config.supply)), feeBps: Number(pf.config.curveFeeBps), creatorTaxBps: config.evm.creatorTaxBps },
    });
  };

  // ---- launches
  const launch = async (rec: LaunchRecord) => {
    await runLaunch({ cfg: config, registry, pool, conn, pub, fx }, rec);
    if (rec.status === "live") mount(rec);
  };
  for (const rec of registry.list({ status: ["launching"] })) await launch(rec); // resume after a crash
  new PaymentWatcher(conn, registry).start();
  const scheduler = new Scheduler(registry, { autoApprove: config.launch.autoApprove, maxLiveMakers: config.launch.maxLiveMakers }, launch);
  scheduler.start();

  // ---- api
  const router = new Router(config.launch.adminToken);
  const limiter = new RateLimit(60_000);
  const rec = (id: string) => { const r = registry.get(id); if (!r) throw new HttpError(404, "no such launch"); return r; };

  router.get("/api/health", () => ({ ok: true, coins: coins.size, updatedAt: Date.now() }));
  router.get("/api/coins", () => [...coins.values()].map((c) => c.summary()));
  router.get("/api/coins/:id/state", (p, _b, h) => {
    const c = coins.get(p.id); if (!c) throw new HttpError(404, "no such coin");
    const r = query(h).range; return c.snapshot(r === "1h" || r === "6h" ? r : "24h");
  });
  router.get("/api/paid", () => registry.list().map(stripQuoteFx));
  router.get("/api/paid/quote", () => quoteNow());
  router.get("/api/paid/:id", (p) => rec(p.id));
  router.post("/api/paid", async (_p, body, _h, ip) => {
    if (!limiter.allow(ip)) throw new HttpError(429, "one launch per minute per address");
    if (registry.list({ status: OPEN_STATUSES }).length >= config.launch.maxOpenLaunches) throw new HttpError(503, "launches are full right now");
    if (!config.pinataJwt) throw new HttpError(503, "PINATA_JWT not configured");
    return createLaunch({
      registry, deadlineMin: config.launch.depositDeadlineMin, now: Date.now, quote: quoteNow,
      pin: { file: (f, n) => pinFile(config.pinataJwt, f, n), json: (o, n) => pinJson(config.pinataJwt, o, n) },
    }, body);
  });
  router.get("/api/pool", () => pool.summary(registry));
  router.get("/api/chain/blockhash", async () => ({ blockhash: (await conn.getLatestBlockhash("confirmed")).blockhash }));

  router.post("/api/admin/paid/:id/approve", (p) => { const r = rec(p.id); if (r.status !== "paid") throw new HttpError(409, `status is ${r.status}`); approve(r, Date.now(), false); registry.save(r); void scheduler.tick(); return r; }, { admin: true });
  router.post("/api/admin/paid/:id/reject", async (p, body) => {
    const r = rec(p.id); const note = typeof (body as any)?.note === "string" ? (body as any).note : null;
    if (!["awaiting_deposit", "paid", "approved"].includes(r.status)) throw new HttpError(409, `status is ${r.status}`);
    reject(r, Date.now(), note); registry.save(r); await refundDeposit(conn, registry, r, Date.now()); return r;
  }, { admin: true });
  router.post("/api/admin/paid/:id/retry", (p) => { const r = rec(p.id); if (r.status !== "failed") throw new HttpError(409, `status is ${r.status}`); transition(r, "approved", Date.now()); registry.save(r); void scheduler.tick(); return r; }, { admin: true });
  router.post("/api/admin/coins/:id/maker/halt", (p) => ({ ok: makers.halt(p.id) }), { admin: true });
  router.post("/api/admin/coins/:id/maker/resume", (p) => ({ ok: makers.resume(p.id) }), { admin: true });

  serve(router, config.server.port, config.server.corsOrigin);
}

function stripQuoteFx(r: LaunchRecord) {
  return r;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export { PublicKey };
```

Remove the last line `export { PublicKey };` and the unused `PublicKey` import if `tsc` complains about unused imports (it does not by default; keep the file clean anyway: delete both).

- [ ] **Step 5: Typecheck and test**

Run: `npm run typecheck && npm test`
Expected: clean typecheck, all tests passing. Fix any import path or type mismatch here (the whole server must compile before moving on).

- [ ] **Step 6: Boot smoke test without keys**

Run: `POOL_SOL_KEY= POOL_EVM_KEY= npm run dev`
Expected: exits with `POOL_SOL_KEY and POOL_EVM_KEY are required`. Then with throwaway keys:

```bash
node -e 'const {Keypair}=require("@solana/web3.js");console.log(require("bs58").default.encode(Keypair.generate().secretKey))'
```

Run: `POOL_SOL_KEY=<printed> POOL_EVM_KEY=0x$(openssl rand -hex 32) DATA_DIR=/tmp/duo-test npm run dev`
Expected: `[api] listening on :8787`; `curl -s localhost:8787/api/paid/quote` returns a quote JSON with `openingFdv` > 0; `curl -s localhost:8787/api/pool` returns balances 0. Stop the server.

- [ ] **Step 7: Commit**

```bash
git add server/src/api.ts server/src/api.test.ts server/src/index.ts
git commit -m "api + wiring: launchpad routes, admin, resume on boot"
```

---

### Task 11: Web

**Files:**
- Create: `web/lib/api.ts`, `web/app/launch/page.tsx`, `web/app/launch/[id]/page.tsx`, `web/app/coin/[id]/page.tsx`, `web/app/admin/page.tsx`
- Rewrite: `web/app/page.tsx`
- Modify: `web/app/globals.css`, `web/app/layout.tsx`, `web/package.json`

- [ ] **Step 1: Add the Solana dependency**

Run in `web/`: `npm install @solana/web3.js@^1.98.4`

- [ ] **Step 2: Write `web/lib/api.ts`**

```ts
export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { cache: "no-store" });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j as T;
}

export async function postJson<T>(path: string, body: unknown, admin?: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(admin ? { "x-admin-token": admin } : {}) }, body: JSON.stringify(body ?? {}) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j as T;
}

export interface Quote { depositSol: number; frontSol: number; frontEth: number; devBuySol: number; ponsEth: number; openingFdv: number; landing: { pump: number; pons: number }; supplyPct: { pump: number; pons: number }; fx: { SOL: number; ETH: number } }
export interface Step { at: number; name: string; [k: string]: unknown }
export interface Launch {
  id: string; createdAt: number; status: string;
  token: { name: string; symbol: string; description: string; imageCid: string; twitter: string; website: string; telegram: string };
  devWallet: string;
  wallets: { pumpMint: string; solCreator: string; evmLauncher: string; evmMaker: string; payment: string };
  payment: { address: string; requiredSol: number; receivedSol: number; paidAt: number | null; deadlineAt: number; txs: { tx: string; sol: number; late: boolean }[]; foreign: { tx: string; sol: number }[] };
  approval: { status: string; at: number | null; note: string | null; auto: boolean };
  front: { sol: number; eth: number; at: number | null };
  launch: { steps: Step[]; pumpMint: string | null; ponsToken: string | null; error: string | null };
  refund: { sol: number; txs: string[] };
  quote: Quote;
}
export interface CoinSummary { id: string; name: string; symbol: string; image: string; launchedAt: number | null; pumpFdv: number | null; ponsFdv: number | null; gap: number | null; inBand: boolean | null; maker: string }

export const usd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toFixed(0)}`);
export const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
export const img = (cid: string) => `https://ipfs.io/ipfs/${cid}`;
```

- [ ] **Step 3: Move the status page to `app/coin/[id]/page.tsx`**

```bash
mkdir -p web/app/coin/\[id\] web/app/launch/\[id\] web/app/admin
git mv web/app/page.tsx "web/app/coin/[id]/page.tsx"
```

Then edit `web/app/coin/[id]/page.tsx`:
- replace `const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";` with `import { API } from "../../../lib/api";` and add `import { useParams } from "next/navigation";`
- inside `Page()` add `const { id } = useParams<{ id: string }>();` as the first line and change the fetch URL to `` `${API}/api/coins/${id}/state?range=${range}` `` and the effect deps to `[range, id]`.
- in the header add a back link before the image: `<a href="/" className="back">← all coins</a>`.

- [ ] **Step 4: Write the home page `web/app/page.tsx`**

```tsx
"use client";
import { useEffect, useState } from "react";
import { getJson, img, pct, usd, type CoinSummary, type Launch } from "../lib/api";

export default function Home() {
  const [coins, setCoins] = useState<CoinSummary[]>([]);
  const [launches, setLaunches] = useState<Launch[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const tick = async () => {
      try {
        const [c, l] = await Promise.all([getJson<CoinSummary[]>("/api/coins"), getJson<Launch[]>("/api/paid")]);
        setCoins(c); setLaunches(l); setErr(null);
      } catch (e) { setErr((e as Error).message); }
    };
    void tick();
    const id = setInterval(tick, 10_000);
    return () => clearInterval(id);
  }, []);
  const open = launches.filter((l) => !["live", "rejected", "expired"].includes(l.status));
  return (
    <main>
      <header>
        <div><h1>Duo Launchpad</h1><div className="sub">One coin, two chains. pump.fun on Solana and Pons on Robinhood Chain, held within a band by a market maker.</div></div>
        <a className="btn" href="/launch">Launch a coin</a>
      </header>
      {err && <p className="err">API unreachable: {err}</p>}
      <h2>Live</h2>
      {coins.length === 0 && <p className="sub">No live coins yet.</p>}
      <div className="cards">
        {coins.map((c) => (
          <a key={c.id} className="card coin" href={`/coin/${c.id}`}>
            <img src={c.image} alt="" />
            <div><b>{c.name}</b> <span className="sub">${c.symbol}</span>
              <div className="row"><span>pump.fun</span><b>{c.pumpFdv ? usd(c.pumpFdv) : "—"}</b></div>
              <div className="row"><span>Pons</span><b>{c.ponsFdv ? usd(c.ponsFdv) : "—"}</b></div>
              <div className="row"><span>gap</span><b className={c.inBand ? "ok" : "bad"}>{c.gap == null ? "—" : pct(c.gap)}</b></div>
            </div>
          </a>
        ))}
      </div>
      <h2>Launches</h2>
      {open.length === 0 && <p className="sub">Nothing in the queue.</p>}
      <table><thead><tr><th>coin</th><th>status</th><th>dev</th><th>created</th></tr></thead>
        <tbody>{open.map((l) => (
          <tr key={l.id}><td><a href={`/launch/${l.id}`}>{l.token.name} · ${l.token.symbol}</a></td><td>{l.status}</td><td className="ca">{l.devWallet.slice(0, 6)}…</td><td>{new Date(l.createdAt).toLocaleString()}</td></tr>
        ))}</tbody></table>
    </main>
  );
}
```

- [ ] **Step 5: Write the launch form `web/app/launch/page.tsx`**

```tsx
"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getJson, postJson, usd, type Launch, type Quote } from "../../lib/api";

export default function LaunchForm() {
  const router = useRouter();
  const [q, setQ] = useState<Quote | null>(null);
  const [f, setF] = useState({ name: "", symbol: "", description: "", twitter: "", website: "", telegram: "", devWallet: "" });
  const [image, setImage] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { getJson<Quote>("/api/paid/quote").then(setQ).catch((e) => setErr((e as Error).message)); }, []);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setErr("image max 2 MB"); return; }
    const r = new FileReader(); r.onload = () => setImage(String(r.result)); r.readAsDataURL(file);
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const rec = await postJson<Launch>("/api/paid", { ...f, imageDataUrl: image }); router.push(`/launch/${rec.id}`); }
    catch (er) { setErr((er as Error).message); setBusy(false); }
  };
  return (
    <main>
      <header><a href="/" className="back">← all coins</a><div><h1>Launch a coin</h1><div className="sub">Pay the deposit, the pool fronts the maker on both chains, your coin goes live on pump.fun and Pons in the same minute.</div></div></header>
      {q && (
        <div className="card quote">
          <div className="row"><span>deposit</span><b>{q.depositSol} SOL</b></div>
          <div className="row"><span>pool fronts</span><b>{q.frontSol} SOL + {q.frontEth} ETH</b></div>
          <div className="row"><span>opening fdv</span><b>{usd(q.openingFdv)} (pump {usd(q.landing.pump)} / pons {usd(q.landing.pons)})</b></div>
          <div className="row"><span>maker inventory</span><b>{q.supplyPct.pump}% on pump.fun · {q.supplyPct.pons}% on Pons</b></div>
        </div>
      )}
      <form className="card form" onSubmit={submit}>
        <label>Name<input required maxLength={32} value={f.name} onChange={set("name")} /></label>
        <label>Symbol<input required maxLength={10} value={f.symbol} onChange={set("symbol")} /></label>
        <label>Description<textarea required maxLength={500} value={f.description} onChange={set("description")} /></label>
        <label>Image (PNG/JPEG, ≤ 2 MB)<input required type="file" accept="image/png,image/jpeg" onChange={onFile} /></label>
        {image && <img className="preview" src={image} alt="" />}
        <label>Twitter<input value={f.twitter} onChange={set("twitter")} /></label>
        <label>Website<input value={f.website} onChange={set("website")} /></label>
        <label>Telegram<input value={f.telegram} onChange={set("telegram")} /></label>
        <label>Your Solana wallet (pays the deposit, receives refunds)<input required value={f.devWallet} onChange={set("devWallet")} /></label>
        {err && <p className="err">{err}</p>}
        <button className="btn" disabled={busy || !image}>{busy ? "creating…" : "Create launch"}</button>
      </form>
    </main>
  );
}
```

- [ ] **Step 6: Write the launch page `web/app/launch/[id]/page.tsx`**

```tsx
"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Connection, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getJson, img, usd, type Launch } from "../../../lib/api";

declare global { interface Window { solana?: { isPhantom?: boolean; connect(): Promise<{ publicKey: PublicKey }>; signAndSendTransaction(tx: Transaction): Promise<{ signature: string }> } } }

const ORDER = ["created", "status:paid", "status:approved", "status:launching", "fronting", "deposit_to_pool", "funded", "launched", "status:live"];

export default function LaunchPage() {
  const { id } = useParams<{ id: string }>();
  const [l, setL] = useState<Launch | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [payErr, setPayErr] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  useEffect(() => {
    const tick = () => getJson<Launch>(`/api/paid/${id}`).then((x) => { setL(x); setErr(null); }).catch((e) => setErr((e as Error).message));
    tick(); const t = setInterval(tick, 3000); return () => clearInterval(t);
  }, [id]);
  const pay = async () => {
    if (!l) return; setPaying(true); setPayErr(null);
    try {
      if (!window.solana?.isPhantom) throw new Error("Phantom not found; send the SOL manually to the address below");
      const { publicKey } = await window.solana.connect();
      if (publicKey.toBase58() !== l.devWallet) throw new Error(`connect the wallet you entered (${l.devWallet.slice(0, 6)}…)`);
      const { blockhash } = await getJson<{ blockhash: string }>("/api/chain/blockhash");
      const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash }).add(
        SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: new PublicKey(l.payment.address), lamports: Math.round(l.payment.requiredSol * LAMPORTS_PER_SOL) }),
      );
      await window.solana.signAndSendTransaction(tx);
    } catch (e) { setPayErr((e as Error).message); }
    setPaying(false);
  };
  if (err) return <main><p className="err">{err}</p></main>;
  if (!l) return <main><p className="sub">loading…</p></main>;
  const done = new Set(l.launch.steps.map((s) => s.name));
  const remaining = Math.max(0, l.payment.deadlineAt - Date.now());
  return (
    <main>
      <header><a href="/" className="back">← all coins</a><img src={img(l.token.imageCid)} alt="" /><div><h1>{l.token.name} · ${l.token.symbol}</h1><div className="sub">{l.token.description}</div></div><span className={`status ${l.status === "live" ? "live" : ""}`}>{l.status}</span></header>
      <div className="card">
        <div className="row"><span>pump.fun CA</span><b className="ca">{l.wallets.pumpMint}</b></div>
        {l.launch.ponsToken && <div className="row"><span>Pons token</span><b className="ca">{l.launch.ponsToken}</b></div>}
        <div className="row"><span>opening fdv (quote)</span><b>{usd(l.quote.openingFdv)}</b></div>
        <div className="row"><span>pool fronts</span><b>{l.quote.frontSol} SOL + {l.quote.frontEth} ETH</b></div>
      </div>
      {l.status === "awaiting_deposit" && (
        <div className="card pay">
          <h2>Pay the deposit</h2>
          <div className="row"><span>amount</span><b>{l.payment.requiredSol} SOL</b></div>
          <div className="row"><span>from</span><b className="ca">{l.devWallet}</b></div>
          <div className="row"><span>to</span><b className="ca">{l.payment.address}</b></div>
          <div className="row"><span>received</span><b>{l.payment.receivedSol} SOL</b></div>
          <div className="row"><span>deadline</span><b>{Math.floor(remaining / 60000)} min left</b></div>
          <button className="btn" onClick={pay} disabled={paying}>{paying ? "waiting for Phantom…" : "Pay with Phantom"}</button>
          <button className="btn ghost" onClick={() => navigator.clipboard.writeText(l.payment.address)}>Copy address</button>
          {payErr && <p className="err">{payErr}</p>}
          <p className="sub">Payments from any other wallet are refunded automatically. The deposit is refunded if the launch is rejected or expires.</p>
        </div>
      )}
      {l.status === "live" && <p><a className="btn" href={`/coin/${l.id}`}>Open the status page</a></p>}
      {l.launch.error && <p className="err">launch error: {l.launch.error}</p>}
      {l.approval.note && <p className="sub">note: {l.approval.note}</p>}
      {l.refund.txs.length > 0 && <p className="sub">refunded {l.refund.sol} SOL · {l.refund.txs.map((t) => <a key={t} href={`https://solscan.io/tx/${t}`} target="_blank">tx </a>)}</p>}
      <div className="card">
        <h2>Timeline</h2>
        <ol className="steps">{ORDER.map((n) => <li key={n} className={done.has(n) ? "done" : ""}>{n.replace("status:", "")}</li>)}</ol>
        <table><tbody>{[...l.launch.steps].reverse().map((s, i) => <tr key={i}><td>{new Date(s.at).toLocaleTimeString()}</td><td>{s.name}</td><td className="ca">{Object.entries(s).filter(([k]) => k !== "at" && k !== "name").map(([k, v]) => `${k}=${String(v)}`).join("  ")}</td></tr>)}</tbody></table>
      </div>
    </main>
  );
}
```

- [ ] **Step 7: Write the admin page `web/app/admin/page.tsx`**

```tsx
"use client";
import { useEffect, useState } from "react";
import { getJson, postJson, type CoinSummary, type Launch } from "../../lib/api";

export default function Admin() {
  const [token, setToken] = useState("");
  const [launches, setLaunches] = useState<Launch[]>([]);
  const [coins, setCoins] = useState<CoinSummary[]>([]);
  const [pool, setPool] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { try { setToken(localStorage.getItem("adminToken") ?? ""); } catch {} }, []);
  const refresh = async () => {
    try { const [l, c, p] = await Promise.all([getJson<Launch[]>("/api/paid"), getJson<CoinSummary[]>("/api/coins"), getJson("/api/pool")]); setLaunches(l); setCoins(c); setPool(p); } catch (e) { setMsg((e as Error).message); }
  };
  useEffect(() => { refresh(); const t = setInterval(refresh, 10_000); return () => clearInterval(t); }, []);
  const act = (path: string, body: unknown = {}) => async () => {
    try { await postJson(path, body, token); setMsg(`ok ${path}`); await refresh(); } catch (e) { setMsg((e as Error).message); }
  };
  const saveToken = (t: string) => { setToken(t); try { localStorage.setItem("adminToken", t); } catch {} };
  return (
    <main>
      <header><a href="/" className="back">← all coins</a><div><h1>Admin</h1></div></header>
      <div className="card form"><label>Admin token<input type="password" value={token} onChange={(e) => saveToken(e.target.value)} /></label>{msg && <p className="sub">{msg}</p>}</div>
      {pool && <div className="card"><h2>Pool</h2>
        <div className="row"><span>Solana {pool.solana.address}</span><b>{pool.solana.balance.toFixed(3)} SOL (floor {pool.solana.floor})</b></div>
        <div className="row"><span>Robinhood {pool.robinhood.address}</span><b>{pool.robinhood.balance.toFixed(4)} ETH (floor {pool.robinhood.floor})</b></div>
        <div className="row"><span>outstanding</span><b>{pool.outstanding.sol.toFixed(3)} SOL · {pool.outstanding.eth.toFixed(4)} ETH</b></div>
        <div className="row"><span>live / launching / queued / open</span><b>{pool.counts.live} / {pool.counts.launching} / {pool.counts.queued} / {pool.counts.open}</b></div></div>}
      <div className="card"><h2>Launches</h2>
        <table><thead><tr><th>id</th><th>status</th><th>paid</th><th>error</th><th>actions</th></tr></thead><tbody>
          {launches.map((l) => <tr key={l.id}>
            <td><a href={`/launch/${l.id}`}>{l.id}</a></td><td>{l.status}</td><td>{l.payment.receivedSol}/{l.payment.requiredSol}</td><td className="err">{l.launch.error ?? ""}</td>
            <td>
              {l.status === "paid" && <button onClick={act(`/api/admin/paid/${l.id}/approve`)}>approve</button>}
              {["awaiting_deposit", "paid", "approved"].includes(l.status) && <button onClick={act(`/api/admin/paid/${l.id}/reject`, { note: prompt("note") ?? null })}>reject</button>}
              {l.status === "failed" && <button onClick={act(`/api/admin/paid/${l.id}/retry`)}>retry</button>}
            </td></tr>)}
        </tbody></table></div>
      <div className="card"><h2>Makers</h2>
        <table><thead><tr><th>coin</th><th>maker</th><th>actions</th></tr></thead><tbody>
          {coins.map((c) => <tr key={c.id}><td><a href={`/coin/${c.id}`}>{c.id}</a></td><td>{c.maker}</td>
            <td><button onClick={act(`/api/admin/coins/${c.id}/maker/halt`)}>halt</button><button onClick={act(`/api/admin/coins/${c.id}/maker/resume`)}>resume</button></td></tr>)}
        </tbody></table></div>
    </main>
  );
}
```

Note: the reject button evaluates `prompt()` at click time only because `act(...)` is called inside the `onClick` arrow. Wrap it: `onClick={() => act(`/api/admin/paid/${l.id}/reject`, { note: prompt("note") ?? null })()}`. Apply that form.

- [ ] **Step 8: CSS and layout**

Append to `web/app/globals.css`:

```css
.btn { display: inline-block; background: var(--text); color: var(--bg); border: 0; border-radius: 10px; padding: 10px 16px; font-weight: 600; cursor: pointer; text-decoration: none; margin-right: 8px; }
.btn.ghost { background: var(--panel); color: var(--text); border: 1px solid var(--line); }
.btn:disabled { opacity: .5; cursor: default; }
.back { color: var(--muted); text-decoration: none; margin-right: 8px; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; margin-bottom: 28px; }
.card.coin { display: flex; gap: 12px; text-decoration: none; }
.card.coin img { width: 64px; height: 64px; border-radius: 10px; object-fit: cover; }
.card.coin > div { flex: 1; }
.form label { display: block; margin: 10px 0; color: var(--muted); font-size: 12px; }
.form input, .form textarea { display: block; width: 100%; margin-top: 4px; background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font: inherit; }
.form textarea { min-height: 80px; }
.preview { width: 96px; height: 96px; border-radius: 12px; object-fit: cover; }
.quote { margin-bottom: 16px; }
.pay { margin-top: 16px; }
.steps { display: flex; flex-wrap: wrap; gap: 8px; list-style: none; padding: 0; margin: 8px 0 12px; }
.steps li { padding: 4px 10px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: 12px; }
.steps li.done { border-color: var(--ok); color: var(--ok); }
.ok { color: var(--ok); } .bad { color: var(--bad); }
h2 { font-size: 16px; margin: 20px 0 8px; }
td button { margin-right: 6px; }
```

In `web/app/layout.tsx` change the title to `"Duo Launchpad"`.

- [ ] **Step 9: Build**

Run in `web/`: `npm run build`
Expected: `✓ Compiled successfully`, routes `/`, `/launch`, `/launch/[id]`, `/coin/[id]`, `/admin`. Fix type errors inline.

- [ ] **Step 10: Commit**

```bash
git add -A web/app web/lib web/package.json web/package-lock.json
git commit -m "web: home, launch form, launch page with Phantom pay, coin page, admin"
```

---

### Task 12: Docs, env example, Docker, final verification

**Files:**
- Rewrite: `server/.env.example`, `README.md`
- Modify: `server/Dockerfile` (comment only), `server/.env` (local: add the new keys, keep values you already have)

- [ ] **Step 1: New `server/.env.example`**

```
# ---- RPC ----
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com      # falls back to RPC_URL
EVM_RPC_URL=https://rpc.ordofi.network

# ---- Pool wallets (the operator's capital; never lent below the floors) ----
POOL_SOL_KEY=                                           # base58 secret key
POOL_EVM_KEY=                                           # 0x-prefixed private key on Robinhood Chain (4663)
POOL_MIN_SOL=5
POOL_MIN_ETH=0.05

# ---- Launch economics (TWINE V2 defaults; test profile in README) ----
DEPOSIT_SOL=0.5                                         # deployer deposit, refundable in phase 2
DEPOSIT_DEADLINE_MIN=60
FRONT_SOL=13.8                                          # pool → per-coin creator/maker wallet
FRONT_ETH=0.33                                          # pool → per-coin Pons maker wallet
SOL_GAS_BUDGET=0.13                                     # kept back from FRONT_SOL for gas + maker cash
EVM_GAS_LAUNCHER=0.012                                  # pool → per-coin launcher, on top of the 0.0005 ETH launch fee
EVM_MAKER_CASH=0.01                                     # kept back from FRONT_ETH as maker cash
EVM_CREATOR_TAX_BPS=200
SOL_SLIPPAGE_PCT=10
SOL_PRIORITY_FEE_SOL=0.0005

# ---- Approval / limits ----
AUTO_APPROVE=false
ADMIN_TOKEN=                                            # required for /api/admin/* and the /admin page
MAX_LIVE_MAKERS=10
MAX_OPEN_LAUNCHES=20

# ---- IPFS ----
PINATA_JWT=

# ---- Maker ----
BAND=0.05
MAKER_ENABLED=true
MAKER_INTERVAL_MS=3000
MAKER_MAX_CLIP_USD=300
MAKER_MIN_SOL=0.3
MAKER_MIN_ETH=0.01
MAKER_MAX_ERRORS=5

# ---- Server ----
PORT=8787
CORS_ORIGIN=*
DATA_DIR=./data
```

- [ ] **Step 2: Rewrite `README.md`**

```markdown
# duo-launcher-pad

A public, custodial launchpad copied from TWINE V2: a deployer pays a SOL deposit, the operator's pool
fronts fresh per-coin wallets, the server creates the coin natively on **pump.fun (Solana)** and on
**Pons v2 (Robinhood Chain)** in the same minute, then a market maker holds the two prices within a band.
Reverse-engineered from the TWINE launch; the research is in [DUO-LAUNCH-SPEC.md](DUO-LAUNCH-SPEC.md),
the design in [docs/superpowers/specs/2026-09-14-launchpad-design.md](docs/superpowers/specs/2026-09-14-launchpad-design.md).

```
server/   node 22 + TypeScript: registry, payment watcher, scheduler, launcher, poller, makers, JSON API → Railway
web/      Next.js 15: home, launch form, launch page (Phantom pay), coin status page, admin       → Railway
```

## Flow (per coin)

1. `POST /api/paid` — the form. Image + metadata are pinned, keys are generated, the pump.fun CA is known.
2. The dev wallet sends `DEPOSIT_SOL` to the per-launch payment address (`/launch/<id>`, "Pay with Phantom").
   Foreign or late payments are refunded automatically; unpaid launches expire after `DEPOSIT_DEADLINE_MIN`.
3. Approval: `AUTO_APPROVE=true`, or an admin on `/admin`. Rejects refund the deposit.
4. Launch (one at a time): pool → per-coin wallets (`FRONT_SOL`, launch fee + `EVM_GAS_LAUNCHER`, `FRONT_ETH`);
   deposit → pool; pump.fun `create` + dev buy from the creator wallet (creator = maker, no fee-share program);
   Pons `launchToken` from the launcher with the maker as `creatorFeeRecipient` and exemptions `[launcher, maker]`;
   maker curve buy sized so Pons lands at the pump.fun fdv; `live`.
5. Poller + maker per live coin; `/coin/<id>` shows both sides, gap, chart, trades.

Phase 2 (not built): front repayment, deposit refund on success, dev fee share, buy-and-burn.

## Setup

```bash
cd server && npm install && cp .env.example .env   # fill it in
cd ../web && npm install
```

Test profile for a first real launch (mainnet, small):

```
DEPOSIT_SOL=0.1  FRONT_SOL=1.0  FRONT_ETH=0.03  AUTO_APPROVE=true
MAKER_MAX_CLIP_USD=5  MAKER_MIN_SOL=0.05  MAKER_MIN_ETH=0.003  POOL_MIN_SOL=0.1  POOL_MIN_ETH=0.005
```

Fund the pool: ≈ 1.3 SOL and ≈ 0.05 ETH on Robinhood Chain (chain 4663; bridge with `npm run bridge -- sol-to-eth 0.5 --confirm`).

## Run

```bash
cd server && npm run dev          # API on :8787
cd web && npm run dev             # site on :3000 (NEXT_PUBLIC_API_URL=http://localhost:8787)
npm test                          # server unit tests (no chain)
```

## API

Public: `GET /api/health`, `GET /api/coins`, `GET /api/coins/:id/state?range=1h|6h|24h`, `GET /api/paid`,
`GET /api/paid/:id`, `POST /api/paid`, `GET /api/paid/quote`, `GET /api/pool`, `GET /api/chain/blockhash`.
Admin (`x-admin-token`): `POST /api/admin/paid/:id/approve|reject|retry`, `POST /api/admin/coins/:id/maker/halt|resume`.

## Railway

Two Dockerfile services. **server**: root `server/`, env from `.env.example` (keys as secrets), volume at
`/app/data`, `DATA_DIR=/app/data`, healthcheck `/api/health`. **web**: root `web/`, build arg
`NEXT_PUBLIC_API_URL=https://<server>.up.railway.app`.

## Security notes

- Pool keys only in env; per-coin keys only in `DATA_DIR/launches/<id>/keys.json` (0600). Logs print addresses and lengths, never secrets.
- Fronting refuses when the pool would drop below `POOL_MIN_*`; the launch waits.
- Launch steps are checkpointed; a crash resumes at boot. Failed launches are retried by an admin.
- Makers halt per coin after `MAKER_MAX_ERRORS`.
```

- [ ] **Step 3: Dockerfile comment**

In `server/Dockerfile` replace the `launch.json` comment line with `# DATA_DIR (launch records, keys, series) is a mounted volume at /app/data.`

- [ ] **Step 4: Update the local `.env`**

Add to `server/.env` (do not print existing values): `POOL_SOL_KEY=<fill>`, `POOL_EVM_KEY=<fill>`, the test-profile lines from the README, `ADMIN_TOKEN=<fill>`, and remove the `TOKEN_*`, `SOL_DEV_BUY_SOL`, `SOL_MAKER_BUY_SOL`, `ETH_MAKER_BUY_ETH`, `EVM_CREATOR_KEY`, `EVM_MAKER_KEY`, `SOLANA_MAKER_KEY`, `EVM_EXEMPT_WALLETS` lines. Keep the header comment about `ENV_FILE`.

- [ ] **Step 5: Full verification**

```bash
cd server && npm run typecheck && npm test && npm run build
cd ../web && npm run build
```

Expected: all green. Then a local end-to-end without funds: start the server with throwaway pool keys and `PINATA_JWT` set, start the web, open `http://localhost:3000/launch`, submit a coin, confirm `/launch/<id>` shows the CA and payment address, and that `GET /api/paid` lists it as `awaiting_deposit`. (Payment and launch need real funds and are the user's test.)

- [ ] **Step 6: Commit**

```bash
git add README.md server/.env.example server/Dockerfile
git commit -m "docs: launchpad README, env example, test profile"
```

---

## Self-review

- Spec §1 pages → Task 11. §2.1 data → Tasks 2, 9. §2.2 record → Task 2. §2.3 modules → Tasks 1–10 (`approval.ts` is folded into `scheduler.ts`; same behavior). §2.4 API → Task 10 (plus `/api/chain/blockhash` for the Phantom flow). §2.5 sizing → Tasks 3, 8. §2.6 config → Tasks 1, 12. §2.7 safety → Tasks 4, 6, 8, 10. §2.8 tests → Tasks 1, 2, 3, 5, 6, 7, 9, 10. §3 web → Task 11. §4 deploy → Task 12.
- `MAX_OPEN_LAUNCHES` is enforced at `POST /api/paid`; `MAX_LIVE_MAKERS` in `plan()`.
- Names used across tasks: `Registry.keys/save/saveKeys/list/get/newId/dir/imagePath`, `newRecord/transition/step/publicRecord/OPEN_STATUSES`, `buildQuote/quoteNetForFdv/grossFromNet/pumpLanding/tokensOut`, `Pool.transferSol/transferEth/canFront/summary/sol/evmAddress`, `sendSol/sweepSol`, `reconcile/observeTransfers/PaymentWatcher/refundDeposit`, `plan/approve/reject/Scheduler`, `runLaunch`, `CoinState.snapshot/summary/gap/pushPoint/persist`, `Poller`, `Maker.start/stop/resume`, `Makers.arm/halt/resume/register`, `Router/RateLimit/HttpError/serve/query` — consistent between definition and use.
