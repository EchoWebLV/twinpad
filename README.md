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
| 4. Front | pool | The deposit (and any boost) is swept into the pool. Pool SOL wallet funds the per-coin Solana maker with the quoted front plus the boost (minus `SOL_CREATOR_SOL`, which goes to the separate pump.fun creator wallet for rent and the bundle tip); pool ETH wallet funds the Pons launcher (gas + launch fee) and the Pons maker with the quoted ETH front. |
| 5. Launch | server | pump.fun `create` from the creator wallet (no dev buy) and the opening buy of `front − SOL_GAS_BUDGET + boost` from the maker wallet, both in one Jito bundle (`JITO_TIP_SOL`) so nothing trades between them; the creator never holds tokens, so pump.fun shows no dev buys or sells. Falls back to create then buy in sequence if the bundle will not land. Reads the resulting curve, then Pons `launchToken` (maker = `creatorFeeRecipient`, launcher + maker tax-exempt) and a maker buy: with `SEED_PONS` (default) the whole ETH front above `EVM_MAKER_CASH`, so the maker holds tokens on Robinhood from the first tick; otherwise only what lands the Pons FDV on the pump.fun FDV. |
| 6. Live | maker | Per-coin maker polls both sides and trades whenever the gap exceeds `BAND`, capped by `MAKER_MAX_CLIP_USD` and wallet floors. The cheap-side buy is skipped once the peg holds `MAKER_MAX_BOUGHT_CLIPS` clips (at cost) of tokens it bought on that side on top of the opening position; sells release the ceiling and the pool never tops a side up past it (`maker.bought` in the coin state). `server/scripts/sim-peg.ts` is the simulation behind these two rules. Inside the band it harvests: while a side's front is not repaid and that side trades `RECOVER_MARGIN` above the opening price, it sells one clip into the demand. Quote above the keep level goes back to the pool (`front.repaid*`); when demand on one side drains the quote the maker needs on the other, the pool tops it up (`TOPUP_ETH` / `TOPUP_SOL`, at most `MAX_TOPUP_ETH_PER_COIN` / `MAX_TOPUP_SOL_PER_COIN` per coin). A coin that has repaid more than it was fronted can be topped up past that cap (the pool is net ahead). Creator fees are claimed while live, once a minute per coin: the pump.fun creator vault to the creator wallet (`creator_fee_pump`; swept to the pool when the maker has been rotated off the creator) and the Pons creator-tax escrow to the maker wallet (`creator_fee_pons`), thresholds `CLAIM_MIN_SOL` / `CLAIM_MIN_ETH`. Repaid ≥ fronted on both chains = **front retired**, alert + `front_retired` step. |
| 7. Exit check | timer | At launch + `RETIRE_AFTER_MIN` the coin needs `RETIRE_MIN_BUYERS` outside holders or `RETIRE_MIN_USD` held by outsiders across both chains. Met: the maker stays. Zero outside holders: instant close. Otherwise: selldown (sell clips at or above the opening price, no buys) for `RETIRE_SELLDOWN_MIN`, then close. The rule is printed on the launch page. `keep` from `/admin` switches the timer off. |
| 8. Close | pool | Sells the maker's tokens back on both chains, collects pump.fun creator fees (creator wallet) and the Pons creator tax, sweeps every per-coin wallet (Solana maker + creator, Pons maker + launcher, payment) to the pool. Recovered amounts are on the record (`retire.swept`). Idempotent: a failed close resumes at the step it stopped. |

Every step is checkpointed in the launch record, so a crash mid-launch resumes at the
next step instead of re-running a spend. A failed launch is re-queued `LAUNCH_AUTO_RETRIES`
times (after `LAUNCH_RETRY_BACKOFF_MIN`) and stays retryable from `/admin` after that.

Loss guards: each maker halts when the pool is down more than `MAX_LOSS_USD_PER_COIN` on
that coin (fronted value minus what the maker holds); above `MAX_LOSS_USD_POOL` across live
coins every maker halts and approvals pause until `POST /api/admin/pool/resume`. Halts,
the breaker and closes go to `ALERT_WEBHOOK_URL` when set.

Statuses: `awaiting_deposit → paid → approved → launching → live → closing → closed`, plus `rejected`,
`expired`, `failed` (retry puts it back to `approved`).

### Sizing

`AUTO_SIZE=true` (default): each launch is fronted with what the pool has free above its
floor, divided by the open maker slots, clamped to `[FRONT_SOL_MIN, FRONT_SOL]` and
`[FRONT_ETH_MIN, FRONT_ETH]`. SOL is also capped at the parity dev buy (the amount that lands
pump.fun on the Pons floor, `phantom ETH × ETH price`, ≈ 6.6 SOL at $101 SOL / $2.5k ETH):
above that the ETH side would have to grow too. Fronts already reserved by paid or queued
launches are excluded, so the quote grows as fees and recovered fronts flow back into the pool.
`POST /api/paid` refuses with 503 while the pool cannot front even the minimum.

Deployers can add a **boost** (`boostSol`, up to `MAX_BOOST_SOL`, SOL deposits only): it is paid
with the deposit, goes straight into the dev buy next to the pool's SOL, and comes back to the
dev wallet pro-rata from everything the coin returns when the pool closes it (`refund`).

With TWINE V2 ceilings (`FRONT_SOL=13.8`, `FRONT_ETH=0.33`) both chains open near
**$5.9k FDV**. The maker's Pons buy is solved in closed form on the live curve reserves
(`sqrt(p·Q·T) − Q`, grossed up for fee + creator tax), so the number tracks the actual
pump.fun landing price rather than a fixed ETH amount. `GET /api/paid/quote?boost=<sol>` shows
the current numbers before you launch.

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
- RPC URLs (`SOLANA_RPC_URL`, `EVM_RPC_URL`). The public Solana RPC works but is slow. `EVM_RPC_URL` may be a comma-separated list, tried in order and the next one on any error: `https://robinhood-rpc.publicnode.com,https://rpc.mainnet.chain.robinhood.com,https://rpc.ordofi.network`. The official `rpc.mainnet.chain.robinhood.com` answers some hosts with a Cloudflare 403 challenge page; `rpc.ordofi.network` is load-balanced over a replica that lags hundreds of blocks, so balances and freshly launched tokens intermittently vanish there.

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
GET  /api/paid/quote?boost=          current sizing (deposit, auto-sized fronting, boost, expected opening FDV)
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
POST /api/admin/paid/:id/ban           {note?, names?: [..], refund?: false}  ban deployer + payer wallets (and names), reject, close if fronted, refund the deposit (payment address or pool)
POST /api/admin/paid/:id/refund        {to?, amount?, reason?}  refund from the pool: the payer by default; to+amount for an unclaimed transfer the sweep picked up (`deposit_excess` step)
GET  /api/admin/bans                                 banned wallets + reserved names (DATA_DIR/bans.json, seeded from BANNED_WALLETS / BANNED_NAMES)
POST /api/admin/bans                   {wallets?: [..], names?: [..]}
POST /api/admin/bans/remove            {wallets?: [..], names?: [..]}
POST /api/admin/coins/:id/maker/halt
POST /api/admin/coins/:id/maker/resume
POST /api/admin/coins/:id/close        {reason?}  sell back, collect fees, sweep to the pool (live, failed, stuck closing)
POST /api/admin/coins/:id/keep                    exit timer off for this coin
POST /api/admin/coins/:id/maker/rotate            move the Solana maker off the pump.fun creator wallet (pre-split launches)
POST /api/admin/pool/resume                       lift the loss breaker
GET  /api/admin/pool/status                       paused flag, closes in flight, per-coin loss / fronted / repaid / retired
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
node test-launch/create.mjs      # submit a test launch (image + metadata in test-launch/), writes launch.json
node test-launch/pay.mjs         # pay its deposit from the root .env wallet; dry run unless --confirm
```
