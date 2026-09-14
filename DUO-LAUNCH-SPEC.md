# Duo Launcher Pad — how the TWINE two-chain launch worked, and what it takes to rebuild it

Everything in this document was verified on-chain or captured from the live sites between
2026-09-12 19:33 UTC and 2026-09-13 17:30 UTC. Where something could not be verified it is
listed under "Unknown / not verified" at the end. Dollar figures use SOL ≈ $101 and ETH ≈ $2,521,
the rates twine.auction itself reported in its `/api/state` payload (`fx: {SOL: 101.455, ETH: 2522.005}`).

Reference files captured from the original site live in [`reference/`](reference/).

---

## 1. What the product is

One meme coin, created at the same moment on two chains, each with its own bonding curve and its own
graduation, plus a market maker that keeps the two prices within a band and a status site that shows the gap.

| Leg | Chain | Launchpad | Curve / pool after graduation | Graduation rule shown on site |
|---|---|---|---|---|
| A | Solana | pump.fun | PumpSwap pool | "PumpSwap at ~85 SOL" |
| B | Robinhood Chain (chain id 4663) | Pons v2 (ponsfamily.com) | Uniswap v4 pool | "Uniswap v4 at 4.2 ETH" |

The site's own description of the mechanism (captured verbatim in
[`reference/twine-how-it-works.txt`](reference/twine-how-it-works.txt)):

1. **Two native launches.** Created on pump.fun and on PONS "in the same second, with the same opening market cap".
2. **One market maker.** Holds inventory and cash on both chains; when one side is >5% ahead it sells there and buys the other.
3. **Fees feed it.** Creator rewards from both chains are paid to the maker wallet.

### What actually happened (verified)

| Event | Time (UTC, Sep 12 2026) | Evidence |
|---|---|---|
| Pons v2 launch tx on Robinhood Chain | 19:32:59, block 61355994 | tx `0x21239611af2608b2aa61662324e07c5d136c995b6f241a9fdcc241c26574fdd6` |
| pump.fun mint created | 19:33:32 | mint `CNWxmoBSQZo2Sgp5KSAK5m9FwSqDbXQRP4CNMuoe78Gm`, creator `2HfMe7agaqDBbdNT8LLK3xEAyLe4VApXePcENV5RnDu5` |
| EVM bundle of 5 wallets buys | block 61356001 (~0.7 s after launch) | wallets listed in §6 |
| EVM bot's first trade | block 61356559 = 19:33:57 | bot `0x0cA689eC5898b1BCBD0aeC0D28490732f0cf7528` |
| Solana bot's first trades | 19:33:33 onward | bot `9iMztAwXeu4c8Qr4yFs1KM13xFbgFRCz6n1oPqjykBUR` |

So "the same second" was really 33 seconds apart, with the EVM side first.

Later events (Sep 13 2026, UTC): 14:40 10M TWINE burned; 15:03 150.75M locked in Streamflow; ~17:20 "Twine V2"
announced — a 0.5 SOL + 0.02 ETH deployer fee replaces the per-launch "$10k auctions" (details and on-chain
status in §10).

---

## 2. Architecture of the original (as observed)

```
                 ┌────────────────────────────┐
                 │  twine.auction (nginx)      │
                 │  static index.html + inline │
                 │  JS, polls /api/state every │
                 │  3 s (range=1h|6h|24h)      │
                 └─────────────┬──────────────┘
                               │ JSON (schema in §7)
                 ┌─────────────┴──────────────┐
                 │  state service              │
                 │  reads both chains, computes│
                 │  fdv / price / gap / inBand │
                 └──────┬──────────────┬───────┘
                        │              │
      ┌─────────────────┴───┐    ┌─────┴──────────────────────┐
      │ Solana              │    │ Robinhood Chain (4663)      │
      │ pump.fun curve →    │    │ Pons v2 curve → Uniswap v4  │
      │ PumpSwap pool       │    │ pool (PoolManager 0x8366…)  │
      │ creator fees →      │    │ creator fees → PonsV2Fee-   │
      │ shared to bot 9iMz… │    │ Escrow → claim() by 0x0cA6… │
      └─────────▲───────────┘    └────────────▲───────────────┘
                │                             │
      ┌─────────┴───────────┐    ┌────────────┴───────────────┐
      │ Solana bot 9iMzt…   │◄──►│ EVM bot 0x0cA689…           │
      │ buys/sells on curve │Relay│ swaps via UniversalRouter   │
      │ and PumpSwap        │bridge│ claims escrow fees          │
      └─────────────────────┘    └────────────────────────────┘
```

Both bots are one operator: Relay bridge records show `0x0cA689…` sending ETH to `9iMzt…` twelve times on
launch day (46.9 ETH), plus a 0.006 ETH test round-trip three days earlier, and at 23:32:56 UTC both
sides cashed out within the same fifteen seconds (§8).

---

## 3. Leg A — Solana / pump.fun

### 3.1 Creation
Standard pump.fun `create` from the creator wallet `2HfMe7agaqDBbdNT8LLK3xEAyLe4VApXePcENV5RnDu5`.
The creator wallet is *not* the trading wallet; it only created the coin and topped the bot up once (18 SOL).

### 3.2 Creator-fee routing
The creator fee was paid out to the bot wallet `9iMzt…`, not to the creator, via pump.fun's fee-sharing
mechanism (PumpSwap program `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`, instructions
`TransferCreatorFeesToPump` / `DistributeCreatorFees`). Payouts arrived roughly every 2 SOL.

Observed totals on the bot wallet:

| Window | Payouts | SOL |
|---|---|---|
| Launch → 22:45 UTC Sep 12 | 170 | 531.5 |
| 22:40 UTC Sep 12 → 16:39 UTC Sep 13 | — | ~154.6 |
| Trailing 5 h to 16:39 UTC Sep 13 | 14 | 28.4 |

**How the share was configured** — see §3.5 (filled from on-chain instruction decode).

### 3.3 Bot behaviour on the curve (from 2,413 wallet transactions, launch → 22:46 UTC)

| Phase (t = creation) | Buys | Sells |
|---|---|---|
| t+0 … 72 s | 3 buys, 15.2 SOL, 344.1M TWINE | 20 sells, 27.6 SOL, 195.9M TWINE |
| t+72 … 180 s | 19 buys, 34.0 SOL, 120.9M | 16 sells, 22.3 SOL, 75.7M |
| t+3 … 10 min | 93 buys, 331.9 SOL, 244.0M | 38 sells, 92.4 SOL, 85.3M |
| t+10 … 60 min | 467 buys, 2,760.8 SOL, 296.3M | 512 sells, 3,098.0 SOL, 273.9M |
| Whole window | 1,080 buys, 7,034 SOL, 1,241M | 1,129 sells, 7,414 SOL, 908M |

Trade sizing and cadence:

| Metric | Value |
|---|---|
| Median buy / sell | 5.2 SOL / 5.7 SOL |
| p90 buy / sell | 13.0 SOL / 11.2 SOL |
| Largest buy / sell | 37.8 SOL / 31.5 SOL |
| Median gap between trades | 2 s (p10 0 s, p90 12 s) |
| Trades per hour | 730 (19:xx), 1,021 (20:xx), 339 (21:xx), 119 (22:xx) |

Inventory: the Solana wallet held a minimum of 143.8M TWINE (14.4% of supply) at t+72 s and never went
below 299.1M after 19:35. It sold 200.3M for 28.5 SOL in the first 72 seconds (0.142 SOL per million) and
rebought 450M for 726 SOL (1.61 SOL per million) — i.e. it seeded the curve cheap and rebought from itself
and early buyers at eleven times the price.

### 3.4 Bridging
Relay (relay.link) filler `F7p3dFrjRTbtRp8FRF6qHLomXbKRBzpvBLjtQcfcgmNe` delivered 1,159.4 SOL to the bot on
launch day; the bot bridged 79 SOL back to ETH at 19:57 via Relay's `DepositNative`
(program `99vQwtBw…`). On Sep 13 02:46 and 02:48 UTC two more ETH→SOL bridges landed (99.3 + 145.0 SOL).

### 3.5 Fee-sharing configuration (on-chain decode)

pump.fun has a dedicated **Pump Fees program** `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` (Anchor IDL name
`pump_fees`). The creator used it 27 seconds after creation to hand 100% of creator fees to the bot wallet:

| # | Time (UTC) | Tx | What |
|---|---|---|---|
| 1 | 19:33:32 | `62uFxJw474T4gfuN2jcGKj1gRrz9sSSab4BakhNLkm97NV2d3BXjGP1MTWEhVeckmyW6GCfP2rdAnhUfiuW4iC6b` | pump `create_v2` (discriminator `d6904cec5f8b31b4`) |
| 2 | 19:33:45 | `23aawndbhi3SRQAKZ5v8Y97QAZmw9WtUkdYPanptNFDcY1VdpoExnbJNJ499EzjhccA6NSWCpPmaNyBRGmaQJsfm` | `collect_creator_fee` + `collect_coin_creator_fee` (0.053 SOL) |
| 3 | 19:33:46 | `BYkkpamXRMcd7R9v7z4LyEuWmsjoJo1jmURpdY4tCPgm7y7ZQS5nNnJxRvG6MxiBe7cDdMY3KgYvMryTaGZ7Lu7` | System transfer 18.0165 SOL creator → bot |
| 4 | 19:33:59 | `s5pQUhFSPfd7Mx5D7e7H5o6L8wFsgV4wQ7zPifuxzRRztAuacNm7o89i3V5t4dyppW8283a4WPnwVjvKmShkY8w` | pfee **`create_fee_sharing_config`** (disc `c34e564c6f34fbd5`, no args). CPIs pump `extend_account` and pump `migrate_bonding_curve_creator` (bonding-curve creator becomes the sharing-config PDA). Initial shareholders `[(creator, 10000 bps)]`. |
| 5 | 19:33:59 | `3jE127wcGUurF81L21wakhykKDpEWs5c4UrBofheZomUB6sGEXveamVpAMuzizoQYtVXkMwRA2JAVfNRCB6yU6Lp` | pfee **`update_fee_shares`** (disc `bd0d8863bba4ed23`, arg `Vec<Shareholder>` = `[{address: 9iMzt…, share_bps: 10000}]`). CPI pump `distribute_creator_fees` paid the pending 0.0093 SOL to the old shareholder first. Event `UpdateFeeSharesEvent` version=2. |

Accounts:

| Account | Address | Derivation |
|---|---|---|
| Sharing config PDA | `AhhGKAr4pWCwUtA2AfhahdyxYSEZYsi3rEvSEWKErEmM` | pfee `["sharing-config", mint]`, 1024 bytes |
| Creator vault (pump, post-config) | `H1jqHTQHsordiPUfgJFYqaeS6rimC5tKHTCoSpx6Ea1W` | pump `["creator-vault", sharing_config]` |
| Creator vault (PumpSwap, post-config) | `HzGr7Xb41wCTbFrpaXfCCdZsV3qzy96E6kXVY4HJuafe` | pAMM `["creator_vault", sharing_config]`; WSOL ATA `2HFaWZprK1RdQG49kXDbGZ4rXszcv2odMc64GmknL5qo` |
| Bonding curve | `6BnZC3DSyAUmmTWLC7DyJhgo3dY847THFLobPXgaojxq` | pump `["bonding-curve", mint]` |
| PumpSwap pool | `5x74XfDESP5j2vfr7nW76mqgQkKMUJUhGWXog4FaJs9X` | from `frontend-api-v3.pump.fun/coins/<mint>` |

Current on-chain `SharingConfig` state: version 2, status Active, admin = creator, **admin_revoked = true**,
shareholders = `[(9iMzt…, 10000)]`. Token program is Token-2022.

Rules from pump.fun's public docs (`github.com/pump-fun/pump-public-docs`, `docs/instructions/CREATOR_FEE_SHARING.md`),
which the IDL error codes corroborate:

- `create_fee_sharing_config` may be called by the coin creator (or pump's admin authority); calling twice is a no-op; payer funds 1024 bytes of rent (5,852,160 lamports).
- `update_fee_shares_v2` takes `shareholders: Vec<{address, share_bps: u16}>`: 1–10 entries, no duplicates, each > 0, sum exactly 10,000. It sets `admin_revoked = true`, so **it can be used once per coin**. It first sweeps pending fees to the current shareholders.
- Distribution is permissionless: `transfer_creator_fees_to_pump_v2` (PumpSwap) then `distribute_creator_fees_v2` (pump) pay shareholders in config order once the vault holds the minimum distributable amount. This is why the bot's payouts arrived in ~2 SOL lumps.
- TWINE used the v1 instruction names (`update_fee_shares`, `distribute_creator_fees`); the docs now describe `_v2` variants with extra quote-mint accounts. Both still exist in the IDLs.

The pump.fun coin record exposes no fee-sharing fields, so nothing on the pump.fun page tells holders the creator fee is going to a trading bot.

**For the Duo Launcher:** after `create`, send `create_fee_sharing_config` and `update_fee_shares_v2` in one
transaction from the creator keypair, with the maker wallet as the single 10,000 bps shareholder (or a split, e.g.
maker 7,000 / treasury 3,000). Because the update is one-shot, the split must be final at launch.

---

## 4. Leg B — Robinhood Chain / Pons v2

### 4.1 What the Pons create form exposes (captured 2026-09-13 from ponsfamily.com/launchpad/create, "v2" tab)

| Field | Notes shown in the UI |
|---|---|
| Name, Ticker, Description, Token image, X profile, Telegram | standard metadata |
| Paired asset | ETH ("Graduates once the curve raises 4.2 ETH") |
| Developer buy (ETH) | initial buy in the launch tx |
| Holder fee sharing | "Creator fees go to the creator wallet" or route pro-rata to holders |
| Creator wallet | "Receives creator fees and the creator tax. Leave blank to use your connected wallet." |
| Creator tax % | "Traders pay 1.00% in total, up to 10% of it yours." |
| Snipe tax exemptions | "Buys in the launch second pay 99%, decaying to zero across 3s. Declare the wallets your team opens with." |
| Launch fee | 0.0005 ETH |
| Liquidity | Locked |

The TWINE token page on Pons (captured 2026-09-13 ~17:20 UTC) shows: creator `0xfA7a…3a6f`, **2.00% creator tax**,
supply 990,000,000 fixed at launch, creator fees **108.60 ETH earned across 549 sweeps**, 0.572 ETH claimable,
"payable to 0x0cA6…7528". Pons lists 4,228,127 tokens launched and 977 graduated, so launching is open to anyone
with a wallet and 0.0005 ETH.

The "snipe tax exemptions" field matters: the five bundle wallets bought seven blocks (~0.7 s) after launch,
inside the 99%-decaying-to-zero window. Whether they were declared exempt is checked in §4.3.

### 4.2 Contracts (verified)

| Role | Address |
|---|---|
| TWINE token | `0xe27501d787d647CC82a5B4a7Eafd5750386F1B77` |
| PonsV2LaunchFactory (`launchToken`, `msg.value` 0.0005 ETH) | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` |
| Pons v2 curve contract for TWINE | `0xE1229BDC66e377D7a3baF910bCca8264012d8B57` |
| Pons trade router used by the bot | UniversalRouter `0x8876789976dEcBfCbBbe364623C63652db8C0904` (`execute`) |
| Uniswap v4 PoolManager | `0x8366a39C…` as seen in Swap logs (full address not captured; docs-derived pool key `{0x0, TWINE, fee 0, tickSpacing 200, hooks 0xE5e7…}` hashes to `0x9ee0e829…`, which does not match the `0x85ec4e37…2b3a` id shown earlier, so the real key is still unknown) |
| Meme hook (Uniswap v4 hook, sweeps fees to escrow) | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` |
| PonsV2FeeEscrow | `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e` — `Credited(recipient, depositor, amount)` topic0 `0x4e45da44…967d5`, `claim()` (no params), `balanceOf(address)` |
| Creator fee recipient (= EVM bot) | `0x0cA689eC5898b1BCBD0aeC0D28490732f0cf7528`, `creatorTaxBps = 200` |

### 4.3 Launch transaction decode (verified with `cast` against archive RPC rpc.ordofi.network)

Tx `0x21239611af2608b2aa61662324e07c5d136c995b6f241a9fdcc241c26574fdd6`, block 61,355,994, type 2, gasUsed 3,884,036,
`from` = `0xfA7a71f662810594231713DCbc734E6e99c13a6f` at **nonce 0** (a fresh wallet), `to` = PonsV2LaunchFactory,
`value` = 0.0005 ETH = `factory.launchFee()` to the wei.

Selector `0xa72101af` = `launchToken((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address,address[])`
— the 4-argument overload that takes a snipe-tax exemption list. Decoded arguments:

```
TokenParams params = {
  name: "TWINE", symbol: "TWINE",
  logo: "ipfs://bafybeieexfb3vjeg25iy32tswfgtfkt42pigxt4jnoigngjt73nh4zdflq",
  description: "One coin, two chains. Launched natively on pump.fun and on Robinhood Chain and kept within 5% of each other by a market maker. twine.auction",
  socials: { twitter: "https://x.com/twinedotfun", telegram: "", discord: "", website: "https://twine.auction/", farcaster: "" },
  creatorFeeRecipient: 0x0cA689eC5898b1BCBD0aeC0D28490732f0cf7528,   // the EVM bot
  creatorTaxBps: 200, buybackEnabled: false,
  expectedEconomics: 0xa9fc75d4203a33fe660e8fa32c74c3aa41c1fda4bf23d3a39b6bc22a1f8b1ca7,  // == previewLaunchEconomics(0, 0x0)
  salt: 0x1c6350c6f83feede576a3755e4fa258b9a4ddc92af4a8135c79b9bd39da9ad54
}
launchConfigId = 0
pairToken      = 0x0000000000000000000000000000000000000000        // native ETH quote
snipeTaxExemptions[7] = [ 0xfA7a71…3a6f (launcher), 0x0cA689…7528 (bot),
                          0xfB5acFd061d432eAf84020F730a383DdD707E7Cf, 0xc6ddb116B063D8a318a64A08cD69E19Ca8350B97,
                          0xF0533c99ADC4d0AA1B9c0203Bb71E957E8C1e097, 0x3A0a781671053175280B915509c80AFd4A8ee977,
                          0x3C1c51A756483e8a9535550B3fB0d16c3BAD1288 ]
```

**What this proves**

- The five "bundle" wallets of §6 were declared by the operator in the launch calldata as snipe-tax exempt
  (the create form's "Declare the wallets your team opens with" field). That is how they bought at block
  61,356,001, 0.7 s after launch, without the 99% snipe tax. Same-control is no longer an inference.
- **No developer buy in the launch tx**: `msg.value` equals the launch fee exactly, the call went to the factory
  rather than the launch-and-buy router `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948` (`launchAndBuy`,
  selector `0xf85f8e41`), and the receipt has no `CurveBuy`. The opening inventory was bought by the exempt wallets.
- **Pons allocates nothing to the creator.** Log 0 mints 1,000,000,000 TWINE straight to the curve; launch config 0
  is `{supply 1e27, curveFeeBps 100, phantomQuote 1.68 ETH, graduationThreshold 4.2 ETH, poolFee 0, tickSpacing 200}`,
  so 714,285,714 tokens (71.43%) are sold on the curve for 4.2 ETH and 285,714,286 (28.57%) are reserved for the
  Uniswap v4 pool. Any "33% for balancing" on this side had to be bought on the curve (see §5).
- Launch gate: `launchEnabled() = true`, `canLaunch(anyAddress) = true` both just before the launch and now;
  `whitelistedLaunchers(0xfA7a…) = false`. Anyone can launch; no API key or whitelist.
- Fee policy for TWINE: `protocolFeeShareBps 3000, buybackBurnBps 5000, hookFeeBps 100, maxCreatorTaxBps 1000`.
  1% base fee on the curve and 1% via the hook after graduation; protocol keeps 30% of the base fee, the creator
  gets the other 70% plus 100% of the 2% creator tax. Uniswap pool fee is 0.

**Receipt (13 logs)**: ERC20 `Transfer` 0x0→curve 1e27; curve `Initialized(token)`; `SnipeTaxExempted` ×9 (launcher and
bot auto-exempted, then the 7 explicit entries); factory `TokenLaunched(token, curve, deployer, pairToken=0x0,
launchConfigId=0, graduationThreshold=4.2 ETH)` topic0 `0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607`;
one unknown-signature event (topic0 `0x3d0ce9bf…`) on `0x263ed295dAFaE1d9AAdD6E56c4B6F9f38eE019Dd` = `factory.owner()`
and protocol fee recipient, carrying the 0.0005 ETH launch fee. No Uniswap v4 `Initialize` in this tx: the pool
is created at graduation. EVM `totalSupply` was 1e27 at launch and is 990,000,000 now (matches the 10M burn in §1).

**Other Pons v2 addresses (from docs, responding on-chain)**: Meme hook `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044`
(= the escrow depositor), buyback vault `0x42df2a798f82289E177311362e8f5ccC45c1219c`, launch locker
`0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952`, launch deployer `0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42`,
graduation executor `0xC7819B64A1dAECD7eC19856d026cb14EfBd89046`, graduation guard `0xf5695117b99B6f6401e67d4195BD653628176C6C`.

**Launcher recipe (Pons leg)**

1. Pin the logo to IPFS; everything else (`description`, socials) is stored on-chain in `TokenParams`.
2. Just before sending, read `launchFee()`, `canLaunch(you)`, `getLaunchConfig(0).enabled` and
   `expectedEconomics = previewLaunchEconomics(0, 0x0)` (the tx reverts `LaunchEconomicsMismatch` otherwise).
3. Random 32-byte `salt`; addresses are CREATE2 and namespaced per launcher wallet.
4. `factory.launchToken(params, 0, 0x0, exemptions[])` with `value = launchFee()`; up to 32 exemptions.
   For an atomic dev buy use the router's `launchAndBuy(params, 0, 0x0, quoteIn, minTokensOut, recipient, exemptions)`
   with `value = launchFee + quoteIn`.
5. Trade with `curve.buy(quoteIn, minTokensOut, recipient)` (payable) / `curve.sell(tokensIn, minQuoteOut, recipient)`;
   quote from `getReserves()`, `sellableTokens()`, `feeBps()`, `creatorTaxBps()`, `currentSnipeTaxBps(recipient)`.
   Snipe tax is keyed on the token *recipient* and decays from 99% to ~0 over the first seconds (docs say 5 s, UI says 3 s).
6. Graduation happens inside the buy that empties the curve; on `AutoGraduationFailed` anyone calls
   `factory.createGraduatedPool(token)`.
7. Fees: `escrow.balanceOf(recipient)` → `escrow.claim()`. Before graduation fees sit in `curve.quoteFeeBalance()` /
   `creatorTaxBalance()`, after in `hook.pendingFees / pendingCreatorTax(poolId, currency)`, moved by `sweepFees` /
   `sweepPoolFees`. `transferCreatorFeeRecipient(token, newRecipient)` re-points the payout.
8. Events to index: factory `TokenLaunched`, `LaunchSwept`, `PoolGraduated`; curve `CurveBuy`, `CurveSell`,
   `CurveCompleted`, `FeesSwept`; hook `PoolRegistered`, `PoolFeesSwept`; escrow `Credited`, `Claimed`.

### 4.4 EVM bot behaviour (from PoolManager Swap logs, launch → 22:45 UTC)

| Metric | Value |
|---|---|
| Buys / sells | 730 / 970 |
| Volume | 687.1M bought, 687.1M sold |
| Peak inventory | 147M TWINE, all market-bought (no allocation at launch) |
| Trading P&L to 22:45 | ≈ −10.9 ETH |
| Fee claims to 22:45 | 86.2 ETH claimed (88.0 of 88.5 ETH of `Credited` events traced to TWINE swaps) |

In the trailing 5 h to 16:53 UTC Sep 13 the bot went from 17.03 ETH / 29.3M TWINE (nonce 3,856) to
24.24 ETH / 7.0M TWINE (nonce 4,283): 427 transactions, net +7.2 ETH, sold down 22M tokens.

---

## 5. The market maker — what "arb bots keeping prices in band" really was

- **No inventory was moved cross-chain.** Only cash (ETH↔SOL via Relay). Tokens on each chain are separate
  supplies; the "mirror" is two independent books steered by one operator.
- **Inventory came from launch, not from the market.** Solana side held 33%+ of supply throughout; the EVM
  side ran with zero allocation and bought up to 147M on the open market.
- **The Solana side made money on trading; the EVM side lost.** +380 SOL vs −10.9 ETH to 22:45 UTC.
  The real income was fees: 531.5 SOL + 86.2 ETH by 22:45 UTC (≈ $271k), and 108.6 ETH on the Pons side alone
  by Sep 13 17:20 UTC.
- **The 5% band was not verified.** The site's `/api/state` reported `inBandPct: 100` and `maxGap: 2.7%` over
  the 24 h it served us, but that is the operator's own number; the tick-by-tick price series from both pools
  were not compared independently.

If the goal is an honest version, the maker needs (a) allocated inventory on **both** chains, (b) a hedged
quote: sell on the expensive side only when it can buy the same notional on the cheap side, (c) a published
inventory and P&L feed so holders can see it is not net-selling.

---

## 6. Wallet map

| Wallet | Chain | Role |
|---|---|---|
| `2HfMe7agaqDBbdNT8LLK3xEAyLe4VApXePcENV5RnDu5` | Solana | pump.fun creator |
| `9iMztAwXeu4c8Qr4yFs1KM13xFbgFRCz6n1oPqjykBUR` | Solana | bot / fee recipient / market maker |
| `0xfA7a…3a6f` (per Pons UI) | Robinhood | Pons launch tx sender / "creator" |
| `0x0cA689eC5898b1BCBD0aeC0D28490732f0cf7528` | Robinhood | bot / creator fee recipient |
| `0xfb5acfd061d432eaf84020f730a383ddd707e7cf` | Robinhood | bundle wallet 1 |
| `0xc6ddb116b063d8a318a64a08cd69e19ca8350b97` | Robinhood | bundle wallet 2 |
| `0xf0533c99adc4d0aa1b9c0203bb71e957e8c1e097` | Robinhood | bundle wallet 3 |
| `0x3a0a781671053175280b915509c80afd4a8ee977` | Robinhood | bundle wallet 4 |
| `0x3c1c51a756483e8a9535550b3fb0d16c3bad1288` | Robinhood | bundle wallet 5 |
| `0xC97D1D86E2C2a373027Fc5514997495E2749515c` | Robinhood | cash-out collector (23:32 UTC sweep) |
| `6p69W2aU1DiidVFz3mLSEAGbjzwFJDNkGZiQTNF3KKKJ` | Solana | cash-out hub (23:32 UTC) |
| `Bz1vksmFhQbYnSJUA3Dz2tz5mvvtcJ379Y9AssrGH19i` | Solana | Streamflow vesting vault token owner |

The bundle bought 128.7M TWINE at launch and sold 125.7M (12.9% of supply), netting +28.9 ETH (≈ $73k).

---

## 7. The status site (twine.auction)

Single static page, nginx, no framework (`hasNext: false`, no Nuxt). One inline script
([`reference/twine-frontend.js`](reference/twine-frontend.js), 7.4 KB) polls `GET /api/state?range=<1h|6h|24h>`
every 3 s and renders: two chain cards (market cap, price, quote depth, phase, graduation progress bar, CA + copy
button, trade links), a gap "needle" between the cards, a canvas chart of both fdv series with in-band shading,
and stats (in-band %, max gap, high, low).

`/api/state` schema as served (full sample in [`reference/twine-api-state-sample.json`](reference/twine-api-state-sample.json)):

```jsonc
{
  "status": "live",                 // "starting" | "live" | anything else = prelaunch
  "coin": {"id": "twine", "source": "pair"},
  "coins": 2,                       // registry size — the site was built to host more pairs
  "pair": {"pumpMint": "...", "ponsToken": "0x...", "ponsCurve": "0x...", "launchedAt": null, "name": "TWINE", "symbol": "TWINE"},
  "meta": {"name", "symbol", "image", "twitter", "website", "description"},
  "fx": {"SOL": 101.455, "ETH": 2522.005},
  "band": 0.05,
  "pump": {"chain":"Solana","venue":"pump.fun","kind":"pumpswap","phase":"amm","phaseLabel":"PumpSwap pool",
           "fdv":2445705.7,"price":0.00244,"quoteSymbol":"SOL","quoteDepth":752.8,"progress":1,"realQuote":0,"mint":"...","at":1789247024420},
  "pons": {"chain":"Robinhood Chain","venue":"PONS","kind":"v4","phase":"amm","phaseLabel":"Uniswap v4 pool",
           "fdv":2454148.6,"price":0.00245,"quoteSymbol":"ETH","quoteDepth":28.88,"progress":1,"realQuote":0,"token":"0x...","curve":"0x...","taxBps":200,"at":1789247024420},
  "gap": 0.00345, "expensive": "pons", "inBand": true,
  "stats": {"range":"24h","points":1,"inBandPct":100,"maxGap":0.0274,"high":2605291,"low":2535786},
  "series": [{"t":1789247012255,"pump":2605291,"pons":2535786}],
  "updatedAt": 1789247024420,
  "errors": {"pump":0,"pons":0}
}
```

`kind` before graduation is presumably the curve (`progress` < 1, `quoteDepth` = quote in curve, and the UI
label switches from "quote in pool" to "quote in curve"); after graduation `kind` is `pumpswap` / `v4`.

Design tokens and fonts are in [`reference/twine-how-it-works.txt`](reference/twine-how-it-works.txt).

---

## 8. Where the money went (so the "self-funding maker" claim can be judged)

At 23:32:56–23:33:12 UTC on Sep 12, both sides cashed out:

| Leg | Path | Amount |
|---|---|---|
| Solana | bot → `6p69W2aU…` → 3 fresh wallets → Jupiter swap to USDC → Mayan Swift bridge → Arbitrum → **Hyperliquid Bridge2** | 1,971 SOL → 200,557 USDC |
| Solana | `6p69W2aU…` → `B48kNVXs…` (unlabelled hot wallet, 73k funded accounts) | 500 SOL |
| Robinhood | ~30 wallets (bot 38.07 ETH, 5 bundle wallets 29.43 ETH, ~25 others) → `0xC97D1D86…` → 5 fresh wallets → ETH→USDG → Relay → Arbitrum USDC → **Hyperliquid Bridge2** | 95.6 ETH → 227,953 USDC |
| **Total into Hyperliquid** | | **428,510 USDC** |

Hyperliquid Bridge2 is `0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7` on Arbitrum (confirmed against Hyperliquid's docs).

Afterwards (Sep 13): 10M TWINE burned at 14:40 UTC; 150.75M TWINE deposited to a Streamflow vesting vault at 15:03 UTC
(tx `363EkcrBhvpK5rnfGuu6ewKbE2dE7sMG74iSSVTXFvL4GghaVELgcjkThCnUSh3KGX6ETonLwBYkhdSAwGFgV51b`).

---

## 9. Build plan for a Duo Launcher Pad

### 9.1 Components

1. **Launcher CLI / service** — one command that:
   - generates the Solana mint keypair up front (CA known before launch) and the EVM token's expected address
     (Pons derives it from the create call; capture it from the receipt);
   - uploads metadata once (IPFS) and reuses the same image/description on both legs;
   - fires the Pons v2 create and the pump.fun create back-to-back from two pre-funded wallets, with the
     developer buy sized so both curves open at the same market cap in USD (use a live SOL/ETH quote);
   - sets the creator-fee recipient on each leg to the maker wallet (Pons: "Creator wallet" field; pump.fun: fee sharing — §3.5).
2. **Maker** — one process, two chain adapters (Solana: pump curve + PumpSwap; EVM: Pons curve + Uniswap v4 via
   UniversalRouter), a shared price model (USD fdv on both sides from pool reserves), a band parameter (5%), and
   a hedge rule (never net-sell beyond the declared allocation).
3. **Treasury / bridge** — Relay quote+execute for ETH↔SOL rebalancing; a claim loop for the Pons escrow and for
   pump.fun creator fees.
4. **State service + site** — reimplement `/api/state` (schema §7) and the single-page frontend; the original's
   script is in `reference/` and can be re-used with new copy.

### 9.2 Inputs the launcher needs (from `.env`)

| Key | Purpose |
|---|---|
| Solana: RPC URL, creator keypair, maker keypair, mint keypair path | pump.fun create + trading |
| EVM: RPC URL for chain 4663, creator private key, maker private key | Pons create + trading |
| IPFS pinning credentials | metadata |
| Relay API base (public) | bridging |
| Band, allocation %, developer-buy USD, start time | maker + launch params |

### 9.3 Open decisions (change the design)

1. One coin on two chains, or a registry of pairs (the original's API already had `coins: 2` and a `coin.id`).
2. Keep Robinhood Chain + Pons, or swap for a chain/launchpad with deeper liquidity.
3. Allocate real maker inventory on both legs (honest version) or copy the original (33% on Solana, 0 on EVM).
4. Whether to declare team wallets in Pons's snipe-tax exemption list at all.

---

## 10. Twine V2 — the "0.5 SOL + 0.02 ETH" update (announced 2026-09-13, ~17:20 UTC)

Source: two posts by @twinedotfun on X, read live from the timeline (status ids `2099186378684723612`,
`2099186380274368715`, quote post `2099186804670824693`). Verbatim claims, in the order posted:

> Twine V2. Pay 0.5 SOL as a deployer fee. The excess funds in $TWINE's market makers fund a deploy reserve.
> The reserve is used to fund the 2 makers for the deploy. Once the maker has enough cash to run itself, the
> deployer is refunded his 0.5 SOL. Initially, the deployer will receive a % of the fees that would go to the
> makers as an incentive. In the future ill add a feature to use those fees as buyback and burns, holder
> dividends etc. $TWINE has grown massively, enough to allow me to use the maker funds for more than just buying
> and selling. ETA - 1 Hour.

> The issue ive heard the most is how there are very few coins being deployed. This should change that.
> Ill add a dashboard for the reserve, and monitor every launch closely.

> No more $10k auctions to fill. 0.5 SOL, 0.02 ETH and deploy.

An hour earlier: "Working on something huge. Full rework on how Twine tokens are launched" (status `2099162411332673589`).

### 10.1 What changes versus V1

| | V1 (TWINE itself) | V2 (as announced) |
|---|---|---|
| Who pays for the makers | The deployer, by filling a "$10k auction" per side (~$10,000 of native token per maker, per the pinned post) | A **deploy reserve** owned by the operator, funded from "excess" in the TWINE makers |
| Deployer pays | the maker capital | **0.5 SOL** (Solana side) + **0.02 ETH** (Robinhood side) as a fee |
| Refund | n/a | the 0.5 SOL is returned "once the maker has enough cash to run itself" (threshold not stated) |
| Deployer income | creator fees flow to the maker wallets (see §3.2 / §4.4) | "a % of the fees that would go to the makers" (percentage not stated) |
| Reserve transparency | none | "a dashboard for the reserve" promised |

Nothing else about the mechanism (token supply split, the 33% "balancing" allocation, snipe-tax exemptions,
who signs the pump.fun `create` and the Pons `launchToken`) is described in the announcement.

### 10.2 V2 went live (twine.auction back up, read 2026-09-13 23:16 UTC)

The site returned with a reworked frontend (saved as [`reference/twine-site-v2-2026-09-13.html`](reference/twine-site-v2-2026-09-13.html))
and new endpoints: `/api/coins`, `/api/pool`, `/api/paid`, `/api/paid/quote`, `/api/flywheel`, `/api/auctions`,
`/api/chain/balance?chain=`, `/api/chain/blockhash`, `/api/demo/*`, plus the old `/api/state?range=`
(sample: [`reference/twine-api-state-v2-sample.json`](reference/twine-api-state-v2-sample.json)). Everything below is
from those JSON responses, cross-checked on-chain where noted.

**Mechanism, in the site's own words:** "Seeded with inventory by the Twine pool, no cash. Its creator fees build a
cash reserve on each side; once both reserves are full the dev gets half of every fee claim and the maker's half
repays the pool, refunds the deposit, then buys and burns TWINE." The pool "seeds each new coin's market maker
with inventory on both chains and is repaid out of that coin's own fees; a floor on each side is never lent."

**The pool (`/api/pool`)** is two plain wallets, both confirmed on-chain:

| | Address | Balance | Floor | Outstanding (fronted, not yet repaid) |
|---|---|---|---|---|
| Solana | `7UQ2Xi4sU3VJcQkfFRDRZRu3gEocAyGVdBoczvYkdS4c` | 250.4 SOL (RPC: 246.9) | 5 SOL | 118.8 SOL |
| Robinhood | `0x0C06c86db988568CA070074d741b6F2D93dcDF2f` | 18.70 ETH | 0.05 ETH | 2.15 ETH |

Totals reported: 19 launches (7 live, 12 retired), 451.0 SOL + 2.15 ETH fronted, 330.7 SOL repaid, 1.53 SOL
written off, 57.06 SOL of deposits refunded, 10.48 SOL of deposits kept by the pool, 183.4 SOL + 4.77 ETH
"recovered" from 12 retired coins. Funding target 300 SOL / 6 ETH ("contributedSol" 117.05). Gates: max 10 live
makers ("machines"), 20 money slots, next front 9.02 SOL, max front 12 SOL, queue 81.

**Per-launch quote (`/api/paid`, example "DOGGO", pair SOL, 23:05 UTC):** opening FDV $4,611; the pool fronts
8.91 SOL + 0.091 ETH (≈$1,182) which buys 238.3M tokens on pump.fun (23.83% of supply) and 50M on Pons (5%);
gas budget 0.08 SOL creator + 0.05 SOL maker + 0.025 SOL create, 0.012 ETH deployer + 0.01 ETH maker + 0.002 ETH
launch. Deposit 0.5 SOL to a per-launch payment address (`F4NGa2aP…` in that record) from a declared dev wallet;
payments from any other wallet are auto-refunded ("foreign"). Fields: `devShareBps 0` until funded, then
`devShareBpsFunded 5000` (the "half of every fee claim"), `cooldownH 24`, approval status (that record was
rejected with note "cooldown"). The 0.02 ETH in the X post does not appear in the quote; the deposit is 0.5 SOL only
and ETH gas is fronted by the pool.

**Flywheel (`/api/flywheel`):** 18 coins, 7 armed, 73.08 SOL + 1.23 ETH spent on buy-and-burn, 2.79M pump-side and
1.13M Pons-side TWINE burned, each burn listed with buy tx and burn tx on both chains. TWINE supply is now
976.18M on Solana (23.8M burned, 150M locked in Streamflow `Bz1vksmF…`) and 988.87M on Robinhood (11.1M burned).

**Auction limits (`/api/auctions`, V1 path, `publicCreate false`, `hideV1 true`):** pairs SOL/SPY/QQQ, target
$5k–$250k, wallet cap 5%, side cap 60%, minimum maker $4,300, max raise ≈$38.7k for SOL; the estimate table
shows e.g. a $10k raise giving contributors 33.5% of supply and a maker of $8,162 ($6,180 inventory + $1,983 cash).

**Where the old maker capital went:** the Solana bot `9iMzt…` dropped from 947.5 SOL (17:31 UTC) to 28.1 SOL with
243.9M TWINE, and the EVM bot `0x0cA689…` from 24.6 ETH to 2.48 ETH with **0 TWINE** (23:16 UTC). The pool wallets
above now hold the bulk. The exact transfer path was not traced.

### 10.3 The band under stress, from the site's own series (21:18–23:16 UTC, 342 points)

Recomputed from `series[]` (identical to the site's `stats`): in band 81.6%, max gap **21.1%**, 11 points above 10%.

| UTC | pump.fun FDV | Pons FDV | Gap |
|---|---|---|---|
| 22:56:10 | 5.89M | 6.32M | 7.4% |
| 22:57:51 | 5.92M | 7.17M | **21.1%** |
| 22:58:32 | 6.26M | 6.53M | 4.3% |
| 23:12:42 | 4.81M | 5.47M | 13.9% |
| 23:14:03 | 4.62M | 5.43M | 17.6% |
| 23:16:46 | 4.79M | 5.10M | 6.4% |

What the Solana bot did in that window (from its transactions): buys of 20–45 SOL each into the PumpSwap pool
(quote vault `92BuVNYY…`) roughly every minute, funded by top-ups of 100 SOL from the pool wallet `7UQ2Xi4s…`
(tx `5y8ZvVip…`) and 119.8 SOL from Relay filler `F7p3dFrj…` (tx `kMnSk6ML…`), i.e. ETH bridged to SOL. With
zero TWINE on the EVM side it cannot sell Pons down, so every gap is closed by spending SOL to lift pump.fun.

### 10.4 What the deployer fee actually covers (measured)

| Cost | Amount | Evidence |
|---|---|---|
| pump.fun `create` (Token-2022 mint, bonding curve, metadata rent + tx fee) | 0.00566 SOL | creator's balance delta in `62uFxJ…C6b` |
| Pons v2 `launchToken` fee | 0.0005 ETH | `msg.value` of `0x21239611…fdd6` |
| Pool front per V2 launch (inventory on both sides + gas) | ≈9.0 SOL + 0.11 ETH (≈$1,180) | `/api/paid` quote |
| Relay bridge overhead | ~$0.35–0.42 per hop | Appendix B |

The 0.5 SOL deposit is refundable and about 4% of what the pool fronts. The capital that matters comes from the
pool, which is the old makers' balances plus deposits kept from rejected/retired launches. For a Duo Launcher Pad
the product decision in §9.3 is therefore: *who fronts the maker inventory, and who owns it afterwards.*

### 10.5 One V2 launch traced end to end — DOGGO `doggo-jq2m` (verified on both chains, 2026-09-13 23:28–23:45 UTC)

Record: [`reference/twine-v2-paid-record-doggo.json`](reference/twine-v2-paid-record-doggo.json) (the `/api/paid`
entry) and [`reference/pons-launchAndBuy-tx-0x981444d6.json`](reference/pons-launchAndBuy-tx-0x981444d6.json).

| Step (site's `launch.steps`) | UTC | What happened on-chain |
|---|---|---|
| deposit | 23:28:51 | dev wallet `H6CSd2BA…FvLY` sends 0.5 SOL to the per-launch payment address `Fbout7B7…eu8E` (tx `42AmHqLH…`) |
| approval | 23:33:52 | manual/operator approval (`approval.status approved`, no note); 13 of the last 30 records were rejected "cooldown", 13 "launches closed: Twine v2 vote rounds coming; deposit refunded", every rejection refunded 0.499991 SOL |
| fronting | 23:38:35 | pool → per-coin wallets: 13.8178 SOL and 0.3276 ETH (`front.sol/eth`) |
| deposit_to_pool | 23:38:35 | payment address → pool `7UQ2Xi4s…` 0.499 SOL (tx `5Cgspg8o…`) |
| pump.fun `create_v2` + dev buy | 23:38:50 | tx `3r7Kujhe…`: fee payer `C3Ut6BkA…PVeS` pays rent (0.00579 SOL); **creator `7D63hiJ7…9SFE` buys 327,125,523 tokens (32.7% of supply) for 13.325 SOL in the create tx**; curve left with 672.9M |
| Pons `launchAndBuy` | 23:38:51 | tx `0x981444d6…aace` from per-coin launcher `0x6f3c8d63…4607` (nonce 1) to the router `0xe33E9E47…2948`, `msg.value` 0.30614 ETH = 0.0005 launch fee + **0.30564 ETH buy of 149.25M tokens (14.9%)** delivered to `0xb03a53b1…2fe4` |
| live | 23:38:54 | `pumpMint 68wfKrKB…6CA3`, `ponsToken 0x2669B2a4…68Da`, `ponsCurve 0xf3eFEb7D…52d1`, opening FDV $5,760 |
| reserveMet / funded | 23:39:14 / 23:39:18 | reserve targets $352.91 (Solana) / $383.24 (Robinhood) reached from fees; `devShareBps` flips 0 → 5000 |
| waterfall @ 23:44:50 | | `devPaid` 5.5107 SOL + 0.4267 ETH, front 13.8178 SOL fully repaid, deposit 0.5 SOL refunded, burns 0 so far |

**Answers to the earlier open items**

- **Per-coin wallets, yes.** Solana: creator/maker `7D63hiJ7…` (fresh, first tx is the create). Robinhood: launcher
  `0x6f3c8d63…` (nonce 0 → funded, nonce 1 → launch) and maker `0xb03a53b1…` which is both `creatorFeeRecipient`
  (`creatorTaxBps 200`) and the buy recipient. The dev's own wallet appears nowhere in the calldata.
- **Snipe-tax exemptions on a V2 launch:** exactly two, `[launcher, maker]`. No bundle wallets, unlike TWINE's seven.
- **No fee-share program on Solana.** The create tx contains no `pfee` instruction; the creator *is* the maker wallet,
  so creator fees land on it directly (`TransferCreatorFeesToPump` / `DistributeCreatorFees` claims every ~10 s once
  graduated). `feeShare: "ok"` in the record means nothing had to be set.
- **The "dev gets half" split is off-chain.** The maker wallet forwards SOL to the dev wallet by plain system
  transfers (e.g. `4fMaU8aa…` 0.103 SOL `7D63hiJ7…` → `H6CSd2BA…`); the pool tops the maker up the same way
  (`4MU69Y94…` 3.0627 SOL `7UQ2Xi4s…` → `7D63hiJ7…`). Nothing enforces the waterfall except the operator's server.
- **The maker trades from the creator wallet:** within the first minute after graduation it alternates buys of
  0.5–4 SOL and sells of 0.6–4.4 SOL against the PumpSwap pool `3fDQVmxV…RP6` (every tx carries `GetFeesWithQuoteMint`).
  DOGGO graduated inside the same block as its create: a sniper `FLRvmcX1…aMvF` bought 15.62 SOL right after the
  13.3 SOL dev buy.

**Economics of one launch (SOL pair, `/api/paid/quote` 23:44 UTC):** pool fronts 13.797 SOL + 0.3276 ETH ≈ $2,185,
of which 13.667 SOL buys 32.68% of the pump.fun supply and 0.30564 ETH buys 15% on Pons; the rest is gas
(0.08 creator + 0.05 maker + 0.025 create SOL; 0.012 deployer + 0.01 maker + 0.002 launch ETH). Deposit 0.5 SOL
(≈$50) is 2.3% of what the pool fronts. `mult 1.02`, floors pump $2,783 / pons $4,162, both sides land at the same
FDV. Gates at that moment: `closed true`, `publicCreate false`, `paused false`, 6 in queue, 79 pending, 6 of 10
"machines" live, 21 fronts so far (7 open, 503.9 SOL + 2.59 ETH fronted, 362.6 SOL repaid, 1.53 written off),
pool on-chain 364.4 SOL / 9.02 ETH.

**What this makes V2, concretely:** a custodial launch service. The operator's server holds every key (pool,
per-coin creator, per-coin launcher, per-coin maker), does the create + dev buy on both chains from its own capital,
market-makes from the creator wallet, and pays the dev by transfer. The deposit is an anti-spam bond; approval is
manual and currently closed ("Twine v2 vote rounds coming").

### 10.6 Still to verify on V2

1. The transfer path from the two old bot wallets to the pool wallets.
2. Whether the Pons maker wallet `0xb03a53b1…` ever sells on Pons (its maker cash is only 0.01 ETH at launch), or
   whether, as for TWINE, the band is held by buying the lagging side only.
3. What "vote rounds" are (announced in the rejection note, no public description yet).

---

## 11. Unknown / not verified

- The original bot's pricing logic and exact band enforcement (only its trades were observed).
- The tick-by-tick price gap between the two pools (the site's `inBandPct` is the operator's own figure).
- The identity of the Solana hot wallet `B48kNVXs…` that received 500 SOL, and of the Robinhood address
  `0xA5DF4D57…` that received 5 ETH.
- The EVM fee-claim count for the last 5 h and the complete escrow `Credited` total to head (archive RPC refuses
  long `eth_getLogs` scans with "network is busy"; a partial scan gives 379 credits / 88.51 ETH over blocks
  61,356,147–61,489,182, and the Pons UI shows 108.60 ETH across 549 sweeps).
- The full Uniswap v4 PoolManager address and TWINE's actual pool key / pool id (see §4.2).
- Whether any Pons v2 contract is source-verified on Blockscout (the smart-contracts API is behind a Cloudflare
  challenge); all ABI knowledge comes from the Pons docs and was corroborated by live `eth_call`s.
- The event with topic0 `0x3d0ce9bf…` emitted by the factory owner `0x263ed295…` when it receives the launch fee.
- Twine V2 (§10.5): the bot→pool transfer path, per-coin maker wallets, fee-share targets and exemption lists on V2 coins.
- Pons v2 discrepancy: the create form says "Traders pay 1.00% in total, up to 10% of it yours", while the TWINE
  token page says "2.00% creator tax" and the on-chain config is `creatorTaxBps = 200`. The form may describe a
  newer default; the launch-time parameters are the on-chain ones.
- twine.auction was unreachable for most of 2026-09-13 and came back at ~23:00 UTC with the V2 frontend (§10.2).

---

## 12. Launcher build (2026-09-14) — what is in the repo and what has been verified

Code lives in `server/` (node 22 + TypeScript) and `web/` (Next.js 15). Launch order copies TWINE V2
exactly: pump.fun create + dev buy → maker curve buy → creator-fee sharing to the maker →
Pons v2 `launchToken` with tax exemptions → maker curve buy → `data/launch.json`. See README.md for
setup, env vars, commands and Railway deploy.

### Verified without spending

| Piece | How it was verified |
|---|---|
| Pump Fees `create_fee_sharing_config` / `update_fee_shares` encoding | rebuilt instructions match TWINE txs `s5pQ…` and `3jE1…` byte-for-byte (`scripts/dev/verify-twine.mts`) |
| pump.fun bonding-curve reader, PumpSwap pool reader | prices/fdv equal what twine.auction shows for TWINE |
| PumpPortal `trade-local` create transaction | built and simulated against the RPC (no send) |
| Pons v2 `launchToken` calldata, `previewLaunchEconomics`, `canLaunch` | encoded; `eth_call` simulation predicts token + curve addresses (needs a funded EVM key to run) |
| Uniswap v4 buy/sell calldata (UniversalRouter, Permit2) | simulated from TWINE's maker address; pool id `0x9ee0e829…` and slot0 match |
| PoolManager `extsload` price + liquidity depth | fdv 4.28M and ~38 ETH depth match the site |
| Relay bridge quote/execute/poll | live quotes both directions (Appendix B) |
| API `/api/state` | server run against the live TWINE pair: gap 1.75%, in band, both sides live |
| Web page | `next build` passes; page polls `/api/state` every 3 s |
| Mint keypair + image + metadata | `keys/mint.json` generated, CA has no on-chain history and no pump.fun record; 1024×1024 PNG rendered |

### Not verified (needs a real launch or real funds)

- The pre-graduation Pons curve trade path (`buy`/`sell` on the curve contract with ERC20 approve) has
  only been type-checked and encoded; TWINE's curve is graduated so it could not be exercised live.
- The maker loop has never traded with real funds. Its clip logic (sell expensive side, buy cheap side,
  clip = `MAKER_MAX_CLIP_USD` × min(3, gap/band)) is untested against live slippage.
- Depth on the v4 side is the L/√P approximation for the current tick only, not the full range.
- Pinata pinning + gateway verification run only in `--upload-only` / `--confirm` (no JWT yet).
- Railway deploy has not been performed; Dockerfiles build locally.

## Appendix A — Chain / API endpoints used

| Purpose | Endpoint | Notes |
|---|---|---|
| Solana RPC | Helius (key in `.env`, never commit) | `getSignaturesForAddress`, `getTransaction` jsonParsed, `maxSupportedTransactionVersion: 0` |
| Robinhood Chain archive RPC | `https://rpc.ordofi.network` | `eth_getLogs` needs small ranges, cap `toBlock` at head, retry on "network is busy" |
| Robinhood official RPC | `https://rpc.mainnet.chain.robinhood.com` | 403 to curl |
| Robinhood explorer | `https://robinhoodchain.blockscout.com` | `/api/v2/…` works from a browser origin only |
| Relay | `https://api.relay.link/requests/v2?user=<addr>` | history; explorer `https://relay.link/transaction/<requestId>` |
| Mayan | `https://explorer-api.mayan.finance/v3/swaps?trader=<solana addr>` | cross-chain swap records |
| Arbitrum explorer | `https://arbitrum.blockscout.com/api/v2/…` | works with a browser UA |
| pump.fun coin API | `https://frontend-api-v3.pump.fun/coins/<mint>` | liveness check |
| twine.auction state | `https://twine.auction/api/state?range=1h|6h|24h` | offline since Sep 13 |

## Appendix B — Relay bridge (ETH on Robinhood Chain ↔ SOL), verified against api.relay.link

Chain support (`GET https://api.relay.link/chains`): id **4663** `robinhood` (vmType evm, depositEnabled, native ETH,
featured ETH/WETH/USDG) and id **792703809** `solana` (vmType svm, native SOL). Both bridging directions were quoted live
(no execution).

**Quote:** `POST https://api.relay.link/quote/v2` (the older `POST /quote` is deprecated). Body:

```jsonc
{
  "user": "<sender address on origin>",
  "recipient": "<address on destination>",     // must be a Solana address when destination is Solana
  "originChainId": 4663, "destinationChainId": 792703809,
  "originCurrency": "0x0000000000000000000000000000000000000000",
  "destinationCurrency": "11111111111111111111111111111111",
  "amount": "100000000000000000",               // smallest unit, string
  "tradeType": "EXACT_INPUT",                   // EXACT_INPUT | EXACT_OUTPUT | EXPECTED_OUTPUT
  "slippageTolerance": "200",                   // bps, optional (auto if omitted)
  "ttl": 300, "refundOnOrigin": true           // optional
}
```

Response: `requestId`, `steps[]`, `fees{gas, relayer, relayerGas, relayerService, app}`, `details{currencyIn, currencyOut, rate, timeEstimate, totalImpact, …}`.

**Execute:** walk `steps[]`. `kind: "transaction"` items are signed and sent by the user on `data.chainId`
(EVM: `{from, to, data, value, gas, maxFeePerGas, maxPriorityFeePerGas}`; Solana: `{instructions[], addressLookupTableAddresses[]}` for the user to build, sign and send).
`kind: "signature"` items are signed (`signatureKind` eip191/eip712) and POSTed to `post.endpoint`.
Then poll `check.endpoint` = `GET /intents/status/v3?requestId=<id>` until `status == "success"`
(statuses: refund, waiting, depositing, failure, pending, submitted, success; `failReason` includes SLIPPAGE, TTL_EXPIRED, SOLVER_BALANCE_TOO_LOW, DEPOSIT_CONFIRMATION_TIMEOUT).

Observed live quotes:

| Direction | Input | Quoted output | Steps | Fees |
|---|---|---|---|---|
| ETH (4663) → SOL | 0.1 ETH | 2.468 SOL | one `deposit` tx to RelayDepository `0x4cd00e387622c35bddb9b4c962c136462338bc31` | relayer 0.00017 ETH (~$0.42) |
| SOL → ETH (4663) | 1 SOL | 0.04006 ETH | one `deposit` Solana tx to program `99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2` | relayer 0.0035 SOL (~$0.35) |

Fee model (docs): $0.02 flat + destination gas, plus swap cost, plus a platform fee of 0.00% for a token bridge / 0.01% stable swap / 0.06% major swap / 0.15% minor swap.

History: `GET https://api.relay.link/requests/v2?user=<addr>` (deprecated, retired 2026-11-24; successor `/requests/v3`).
The original operator's record: 16 requests, all success — 14 ETH→SOL to `9iMzt…`, 2 SOL→ETH back to `0x0cA689…`.
Example request `0x17892677382cd613e867472174210d955cec84451a383cc9f14ceb41366e9348` (2026-09-13 02:48:58 UTC):
5.8965 ETH in ($14,872) → 145.0238 SOL out ($14,797), rate 24.59, total fees ≈ $23.23, filled in 11 seconds
(in-tx `0xe7b0c4b9eb1020287c5dd0890280300f3ff3c3fcb44e9c144b2598a0accff1b1`, out-tx a System transfer from solver `F7p3dFrjRTbtRp8FRF6qHLomXbKRBzpvBLjtQcfcgmNe`).

