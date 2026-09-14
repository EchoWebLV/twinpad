# Duo Launchpad — design (2026-09-14)

Turn the single-coin launcher in this repo into a public, custodial launchpad that works the way
TWINE V2 worked (DUO-LAUNCH-SPEC.md §10.2–10.5): a deployer pays a SOL deposit, the operator's pool
fronts fresh per-coin wallets, the server creates the coin on pump.fun and Pons v2 from those
wallets, market-makes from the creator wallet, and shows a status page per coin. No coin of our own.

This spec covers **phase 1: the launchpad** (deposit → approve → front → launch → live → maker).
**Phase 2, the money waterfall** (repay the front from fees, refund the deposit, pay the dev half of
fee claims, buy-back), is a separate spec and is only stubbed here as record fields.

## 1. What the user sees

- `/` — live coins (cards: image, name, symbol, both FDVs, gap, in band) and open launches
  (awaiting deposit / approval / launching). Button: "Launch a coin".
- `/launch` — form: name, symbol (≤10), description, image (PNG/JPG ≤ 2 MB), twitter, website,
  telegram, **dev Solana wallet** (the wallet that will pay the deposit and, in phase 2, receive
  the dev share). Shows the current quote (deposit, what the pool fronts, opening FDV) from
  `/api/paid/quote`. Submit → `/launch/[id]`.
- `/launch/[id]` — the launch record: pump.fun CA (known immediately), payment address, amount,
  deadline, "Pay with Phantom" button (a SystemProgram transfer signed in the browser) plus a copy
  button for wallet users, then a step timeline (deposit → approval → fronting → launched → live).
  Rejected/expired launches show the refund tx. Live launches link to `/coin/[id]`.
- `/coin/[id]` — the existing twine.auction-style status page, per coin (two chain cards, gap
  needle, chart, stats, maker trades).
- `/admin` — token field (kept in localStorage), pending launches with approve/reject (+ note),
  pool balances, live makers with halt/resume.

## 2. Server

Node 22 + TypeScript, same repo layout. One process serves the API, the poller, the payment
watcher, the launcher and the maker.

### 2.1 Data (all under `DATA_DIR`, a Railway volume)

```
data/
  launches/<id>/record.json   public record (same shape as TWINE's /api/paid entry, see 2.2)
  launches/<id>/keys.json     0600: mint, solCreator, evmLauncher, evmMaker, payment secret keys
  launches/<id>/image.png     uploaded image
  state/<id>.json             series + trades for the status page (current state.json, per coin)
```

Ids are `<symbol lowercase>-<4 base36 chars>` (`doggo-jq2m`). The registry is the directory
listing; records are read at boot and kept in memory, written on every change (atomic rename).
The single-coin `data/launch.json`, `launch-progress.json` and `keys/mint.json` go away.

### 2.2 Launch record

```jsonc
{
  "id": "doggo-jq2m", "createdAt": 0,
  "status": "awaiting_deposit" | "paid" | "approved" | "launching" | "live" | "rejected" | "expired" | "failed",
  "token": { "name", "symbol", "description", "twitter", "website", "telegram",
             "imageCid", "metadataCid", "metadataUri" },
  "devWallet": "H6CS…", "devShareBps": 0, "devShareBpsFunded": 5000,
  "wallets": { "pumpMint", "solCreator", "evmLauncher", "evmMaker", "payment" },  // public keys only
  "payment": { "address", "requiredSol", "receivedSol", "paidAt", "from", "expectedFrom",
               "overpaidSol", "deadlineAt", "toPoolTx", "txs": [{tx, from, sol, at, late}], "foreign": [] },
  "approval": { "status": "pending"|"approved"|"rejected", "at", "note", "auto": bool },
  "front":  { "sol", "eth", "at", "txSol", "txRh", "repaidSol": 0, "writtenOffSol": 0 },
  "seed":   { "pumpTokens", "ponsTokens", "openingFdv", "at" },
  "launch": { "startedAt", "steps": [{at, name, ...}], "pumpMint", "ponsToken", "ponsCurve",
              "launchedAt", "txs": { "pumpCreate", "ponsLaunch", "evmMakerBuy" }, "error" },
  "refund": { "sol": 0, "paidSol": 0, "txs": [] },
  "reserve": null, "waterfall": null, "retire": null,      // phase 2
  "quote": { … the quote used at creation, see 2.5 … }
}
```

Step names copy TWINE's: `preflight`, `fronting`, `deposit_to_pool`, `funded`, `engine_armed`,
`launched`, `live`. Every state change appends a step, so the page timeline is the record itself.

### 2.3 Modules

| Module | One purpose |
|---|---|
| `registry.ts` | load/save records + keys, id generation, list/filter, atomic writes. No chain calls. |
| `paid.ts` | `createLaunch(input)`: validate, write image, pin image + metadata (Pinata), generate the four keypairs + payment keypair, compute quote, write record. |
| `payments.ts` | Watcher loop (every 5 s over `awaiting_deposit` records): read payment-address balance and recent signatures; match `from` against `devWallet`; record `txs`/`foreign`; mark `paid` when `receivedSol ≥ requiredSol`; expire past `deadlineAt`; refund foreign, rejected and expired payments back to their sender (minus tx fee). |
| `approval.ts` | `AUTO_APPROVE` → approve on `paid`; else admin endpoints. Enforces `MAX_LIVE_MAKERS` and `MAX_OPEN_LAUNCHES` (excess stays `paid`, queued, oldest first). |
| `launcher.ts` | The current `launch.ts` turned into a library: `runLaunch(record, keys)` executes the checkpointed steps for one launch from its per-coin wallets. Steps: preflight (balances, Pons `canLaunch`, PumpPortal create simulation) → fronting (pool → creator `front.sol`; pool → launcher launch fee + gas; pool → maker `front.eth`) → deposit_to_pool (payment address → pool) → funded → pump.fun `create` + dev buy (creator = maker on Solana, no fee-share program, as in DOGGO) → Pons `launchToken` from the launcher with `creatorFeeRecipient = maker`, exemptions `[launcher, maker]` → maker curve buy from the maker wallet → launched → live. Any thrown error sets `status: failed` with `launch.error`; the admin can retry (steps already done are skipped by their checkpoint). |
| `quote.ts` | Pure sizing: given `FRONT_SOL`/`FRONT_ETH`, gas budgets and the live curve states, returns dev-buy SOL, pump landing FDV, and the ETH buy that lands Pons at the same FDV (bisection over `quoteBuy`), plus token counts and supply %. Same fields as TWINE's `/api/paid/quote`. |
| `coin.ts` | `CoinState` = today's `State` minus launch loading: per-coin pump/pons sides, series, trades, maker status, `snapshot()`. |
| `poller.ts` | Every 3 s: fx once, then both sides for every live coin (`Promise.allSettled`, bounded concurrency 4). |
| `maker.ts` | Today's `Maker` with the coin, wallets and per-coin state injected; unchanged trading logic. `makers.ts` starts one per live coin (`engine_armed`), stops on halt/retire, exposes halt/resume for admin. |
| `pool.ts` | Pool wallets from `POOL_SOL_KEY` / `POOL_EVM_KEY`: balances, floors (`POOL_MIN_SOL`/`POOL_MIN_ETH`, never lent), outstanding = Σ front − repaid, `transferSol`/`transferEth` helpers. Refuses to front below the floor. |
| `api.ts` | Routes below. Tiny hand-rolled router on `node:http` like today, plus JSON body parsing (limit 3 MB for the image). |
| `config.ts` | New keys, see 2.6. Token fields and single-coin keys removed. |

### 2.4 API

Public (CORS `*`, GET unless noted):

- `GET /api/health`
- `GET /api/coins` — live coins summary list
- `GET /api/coins/:id/state?range=1h|6h|24h` — twine `/api/state` schema for one coin
- `GET /api/paid` — launch records, newest first, keys never included
- `GET /api/paid/:id`
- `POST /api/paid` — body `{name, symbol, description, twitter?, website?, telegram?, devWallet, imageDataUrl}` → record. Rate limit 1 per IP per 60 s; refuses when open launches ≥ `MAX_OPEN_LAUNCHES`.
- `GET /api/paid/quote` — current quote for a new launch
- `GET /api/pool` — balances, floors, outstanding, counts (live, queued, open)

Admin (`x-admin-token` header must equal `ADMIN_TOKEN`; 401 otherwise; disabled when unset):

- `POST /api/admin/paid/:id/approve`, `POST /api/admin/paid/:id/reject` `{note}`
- `POST /api/admin/paid/:id/retry` (failed → approved, re-runs the launcher)
- `POST /api/admin/coins/:id/maker/halt`, `…/resume`

### 2.5 Sizing (what the pool fronts)

Copied from TWINE V2 (§10.5 economics), all configurable:

- Solana: `front.sol = FRONT_SOL`. Dev buy = `FRONT_SOL − SOL_GAS_BUDGET` (creator gas 0.08 + maker cash 0.05 + create 0.025 in TWINE; our default budget 0.13 SOL).
- Robinhood: launcher gets `launchFee + EVM_GAS_LAUNCHER` (0.012 ETH in TWINE), maker gets `FRONT_ETH` of which the curve buy is sized by `quote.ts` so both curves land at the same FDV (TWINE: `mult 1.02`, Pons seed 15 %); the remainder is maker cash.
- The quote is computed at `POST /api/paid` and again at `fronting` (curves are fresh each launch, so the quote only depends on config and the two launch configs on-chain).

### 2.6 Config

```
POOL_SOL_KEY, POOL_EVM_KEY            pool wallets (base58 / hex)
SOLANA_RPC_URL, EVM_RPC_URL           as today
PINATA_JWT                            required at POST /api/paid
DEPOSIT_SOL=0.5                       deposit required
DEPOSIT_DEADLINE_MIN=60               awaiting_deposit → expired
FRONT_SOL=13.8  FRONT_ETH=0.33        what the pool fronts per coin
SOL_GAS_BUDGET=0.13  EVM_GAS_LAUNCHER=0.012  EVM_MAKER_CASH=0.01
POOL_MIN_SOL=5  POOL_MIN_ETH=0.05     floors, never lent
AUTO_APPROVE=false  ADMIN_TOKEN=      approval
MAX_LIVE_MAKERS=10  MAX_OPEN_LAUNCHES=20
BAND, MAKER_* , SOL_SLIPPAGE_PCT, SOL_PRIORITY_FEE_SOL, EVM_CREATOR_TAX_BPS   as today
PORT, CORS_ORIGIN, DATA_DIR           as today
```

Test profile for the first real launch: `DEPOSIT_SOL=0.1 FRONT_SOL=1.0 FRONT_ETH=0.03 AUTO_APPROVE=true
MAKER_MAX_CLIP_USD=5 MAKER_MIN_SOL=0.05 MAKER_MIN_ETH=0.003`. Pool needs ≈ 1.3 SOL + 0.05 ETH on
Robinhood Chain.

### 2.7 Errors and safety

- Keys: per-coin keys live only in `keys.json` (0600) on the volume; pool keys only in env. Logs
  print addresses and lengths, never secrets. `GET /api/paid` strips `keys` and the payment secret.
- Fronting refuses if the pool would drop below its floor; the launch stays `approved` and is
  retried on the next scheduler tick (every 30 s) until funds exist.
- Launch steps are idempotent by checkpoint (tx signature stored before confirmation, as today);
  a crash mid-launch resumes at boot for every record in `launching`.
- Payment watcher tolerates RPC errors (logs, retries next tick); payments after the deadline are
  refunded as `late`.
- Maker halts per coin after `MAKER_MAX_ERRORS`; other coins keep running.
- One launch runs at a time (queue), so pool accounting is sequential.

### 2.8 Tests (node:test, no chain)

- `registry`: id format, atomic save/load, list filters.
- `payments`: matching rules (expected sender, foreign, late, overpaid, partial + top-up).
- `quote`: FDV-match solver against a fake curve quoter; gas budget arithmetic.
- `approval`: auto vs manual, queue limits.
- Record state machine: legal transitions only.

Chain paths (create, launchToken, maker buys, transfers) are proven by the first small mainnet
launch, as they were for the single-coin launcher.

## 3. Web

Next.js 15 app router, existing styling. Pages listed in §1. Data: polls the server every 3 s
(coin page, launch page) or 10 s (home, admin). "Pay with Phantom" uses `window.solana` and
`@solana/web3.js` in the browser to build a `SystemProgram.transfer` to the payment address for
exactly `requiredSol`; everything else is plain fetch. Admin token stored in `localStorage`.

## 4. Deploy

Unchanged: two Railway services from `server/` and `web/`, volume at `/app/data`, healthcheck
`/api/health`, `NEXT_PUBLIC_API_URL` on the web service. New env vars per §2.6.

## 5. Out of scope (phase 2 spec)

Front repayment, deposit refund on success, dev fee share transfers, reserve targets, buy-and-burn
flywheel, retire, cooldown per dev wallet, `launchAndBuy` via the Pons router as one tx (we keep
`launchToken` + a separate maker buy, which has the same on-chain result).
