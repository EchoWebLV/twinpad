# Twinpad

A custodial two-chain launchpad. One form, one deposit, and the pad launches your token
on **pump.fun (Solana)** and **Pons v2 (Robinhood Chain, id 4663)** at the same opening price,
then runs a market maker that keeps the two prices inside a 5% band.

It reproduces the TWINE V2 launch flow: per-launch payment wallet, operator pool that fronts
every launch, pump.fun `create` + dev buy, Pons `launchToken` with the maker as creator-fee
recipient, and a Pons maker buy sized so both chains open at the same fully diluted value.

Phase 1 (this repo): deposit → approve → front → launch → live → maker.
Phase 2 (not built): deposit refunds, waterfall, dev share.

---

## How a launch works

| Step | Who | What happens |
|---|---|---|
| 1. Submit | deployer | Fills the `/launch` form (name, symbol, description, image, socials, dev wallet). Image + pump.fun metadata are pinned to IPFS on submit. |
| 2. Deposit | deployer | Sends `DEPOSIT_SOL` to a fresh per-launch payment address (Phantom button or manual). Watcher confirms it; wrong-sender or late payments are refunded. |
| 3. Approve | operator | `/admin` approve/reject, or `AUTO_APPROVE=true`. |
| 4. Front | pool | Pool SOL wallet funds the per-coin creator/maker wallet with `FRONT_SOL`; pool ETH wallet funds the Pons launcher (gas + launch fee) and the Pons maker with `FRONT_ETH`. The deposit is swept into the pool. |
| 5. Launch | server | pump.fun `create` + dev buy of `FRONT_SOL − SOL_GAS_BUDGET`. Reads the resulting curve, then Pons `launchToken` (maker = `creatorFeeRecipient`, launcher + maker tax-exempt) and a maker buy sized to land the Pons FDV on the pump.fun FDV. |
| 6. Live | maker | Per-coin maker polls both sides and trades whenever the gap exceeds `BAND`, capped by `MAKER_MAX_CLIP_USD` and wallet floors. |

Every step is checkpointed in the launch record, so a crash mid-launch resumes at the
next step instead of re-running a spend. A failed launch is retryable from `/admin`.

Statuses: `awaiting_deposit → paid → approved → launching → live`, plus `rejected`,
`expired`, `failed` (retry puts it back to `approved`).

### Sizing

With TWINE V2 defaults (`FRONT_SOL=13.8`, `FRONT_ETH=0.33`) both chains open near
**$5.9k FDV**. The maker's Pons buy is solved in closed form on the live curve reserves
(`sqrt(p·Q·T) − Q`, grossed up for fee + creator tax), so the number tracks the actual
pump.fun landing price rather than a fixed ETH amount. `GET /api/paid/quote` shows the
current numbers before you launch.

---

## Layout

```
server/   Node 22 + TypeScript. HTTP API, payment watcher, scheduler, launcher, makers.
web/      Next.js 15. Home (live coins + queue), /launch, /launch/[id], /coin/[id], /admin.
docs/     Design spec and implementation plan.
reference/ Original TWINE handoff material.
```

Server modules: `config` (env), `record`/`registry` (launch records + per-coin keys),
`quote` (curve math), `pool` (operator wallets), `paid` (form → record), `payments`
(deposit watcher), `scheduler` (approve/launch queue), `launcher` (checkpointed launch),
`coin`/`poller`/`maker`/`makers` (price series + market making), `api`/`index` (HTTP).

---

## Setup

### 1. Server

```bash
cd server
npm install
cp .env.example .env
```

Fill in `.env`:

- `POOL_SOL_KEY` — base58 secret key of the pool's Solana wallet.
- `POOL_EVM_KEY` — 0x private key of the pool's Robinhood Chain wallet.
- `ADMIN_TOKEN` — any long random string; the `/admin` page and `/api/admin/*` need it.
- `PINATA_JWT` — Pinata v3 JWT for IPFS pinning.
- RPC URLs (`SOLANA_RPC_URL`, `EVM_RPC_URL`). The public Solana RPC works but is slow. Use `https://rpc.mainnet.chain.robinhood.com` for Robinhood Chain: `rpc.ordofi.network` is load-balanced over a replica that lags hundreds of blocks, so balances and freshly launched tokens intermittently vanish.

Any value left as `<fill>` is treated as unset.

```bash
npm run typecheck
npm test
npm run dev        # http://localhost:8787
```

### 2. Web

```bash
cd web
npm install
cp .env.example .env.local   # NEXT_PUBLIC_API_URL=http://localhost:8787
npm run dev                  # http://localhost:3000
```

### 3. Fund the pool

The pool wallets must hold enough to front a launch **plus** stay above
`POOL_MIN_SOL` / `POOL_MIN_ETH`; otherwise the launch preflight refuses. The
server logs the pool address on boot and `GET /api/pool` reports balances and
what is outstanding.

---

## Small-amount mainnet test profile

Use this in `server/.env` to exercise the full flow with real chains and little capital:

```
DEPOSIT_SOL=0.1
FRONT_SOL=1.0
FRONT_ETH=0.03
AUTO_APPROVE=true
MAKER_MAX_CLIP_USD=5
MAKER_MIN_SOL=0.05
MAKER_MIN_ETH=0.003
POOL_MIN_SOL=0.1
POOL_MIN_ETH=0.005
```

Fund the pool with roughly **1.3 SOL** and **0.05 ETH on Robinhood Chain (4663)**.

Then:

1. Start server and web.
2. Open `/launch`, fill the form, submit.
3. On `/launch/<id>` pay the deposit with Phantom (or send `DEPOSIT_SOL` to the shown address from the dev wallet you entered).
4. Watch the timeline: paid → approved → launching → live. The coin then appears on the home page and `/coin/<id>`.
5. `/admin` (paste `ADMIN_TOKEN`) shows pool balances, approve/reject/retry, and maker halt/resume.

The pump.fun mint address is generated at form submit and shown on the launch page
before anything is spent.

---

## API

Public

```
GET  /api/health
GET  /api/paid/quote                 current sizing (deposit, fronting, expected opening FDV)
POST /api/paid                       submit a launch (1 per IP per minute)
GET  /api/paid                       open launches
GET  /api/paid/:id                   one launch (public fields)
GET  /api/coins                      live coins
GET  /api/coins/:id/state?range=     price series + maker state
GET  /api/pool                       pool balances, floors, outstanding fronts
GET  /api/chain/blockhash            for the browser wallet payment
```

Admin (`x-admin-token` header)

```
POST /api/admin/paid/:id/approve
POST /api/admin/paid/:id/reject
POST /api/admin/paid/:id/retry
POST /api/admin/coins/:id/maker/halt
POST /api/admin/coins/:id/maker/resume
```

---

## Deploy (Railway)

Both `server/` and `web/` have a `Dockerfile` and `railway.json`.

- Server: set the `.env` keys as Railway variables and mount a volume at `/app/data`
  (`DATA_DIR`). That volume holds launch records, **per-coin secret keys**, and price series.
- Web: set `NEXT_PUBLIC_API_URL` to the server's public URL; set `CORS_ORIGIN` and
  `PUBLIC_URL` on the server to the web URL. Every token's website is `<PUBLIC_URL>/coin/<id>`.

---

## Security notes

- Per-coin keys (`keys.json`) are written `0600` under `DATA_DIR/launches/<id>/`. Back that
  directory up; losing it means losing the creator, maker, and payment wallets of every launch.
- Pool keys, admin token, Pinata JWT, and RPC hosts are masked in the boot config log.
- `.gitignore` covers `.env`, `server/keys/`, `server/data/`, build output.
- Admin routes are only as safe as `ADMIN_TOKEN`. Put the server behind HTTPS.
- This is custodial: the operator's pool is at risk for every fronted launch. Keep
  `MAX_LIVE_MAKERS` and `MAX_OPEN_LAUNCHES` sized to the pool.

## Scripts

```bash
cd server
npm run bridge -- eth-to-sol 0.1            # quote a Relay bridge between the pool wallets; add --confirm to send
npm run prices     # print current fx and pair prices
```
