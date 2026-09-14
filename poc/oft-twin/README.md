# Lockstep (LSTP): one-supply twin, pump.fun + Robinhood Chain, no maker bot

Proof of concept for the Twinpad redesign described in
`docs/superpowers/specs/2026-09-15-oft-twin-poc-design.md`. One token supply lives on the pump.fun mint.
A LayerZero OFT Adapter locks LSTP on Solana and a native OFT ERC-20 mints the same amount on Robinhood
Chain, where a Uniswap v4 pool gives Axiom, GMGN and DexScreener something to trade. Arbitrage keeps the
two prices in lockstep. Nothing to drain, nothing to babysit.

```
poc/oft-twin/
  launch/    pump.fun launch (image, metadata on IPFS, pre-generated mint)      python3 launch.py
  lz/        LayerZero: Solana OFT program + adapter tasks, LockstepOFT.sol,     pnpm hardhat lz:*
             layerzero.config.ts (mainnet) / layerzero.testnet.config.ts
  uniswap/   Uniswap v4 pool on Robinhood: init + seed + UniversalRouter swap   pnpm seed
  .keys/     deployer and mint keypairs (0600, gitignored)
```

## Fixed identifiers

- pump.fun mint (CA, known before launch): `2QFZpv8PHcJXNLHZd6S3pEFcf6tpog1BZvVLHGE85Vrb`
- Solana OFT program: `3j8E9XzJ5LpKPcHMWyB36oE1ju9CZ2MvMXTYqFdn97MZ` (`.keys/oft-program-keypair.json`)
- Solana deployer / payer: `CbezAz2tauHMhacv2X4mcqWvML8hfUH1o683NiRtqNrG` (`.keys/solana-deployer.json`)
- Robinhood deployer / owner: `0x3F0b2De9ABbC1eB7a787018C18B95548b5DC7aa3` (`.keys/evm-deployer.json`)
- LayerZero eids: Solana mainnet 30168, Robinhood mainnet 30416 (testnet: 40168 / 40451)
- Robinhood EndpointV2: `0x6F475642a6e85809B1c36Fa62763669b1b48DD5B`; Uniswap v4 PoolManager
  `0x8366a39cc670b4001a1121b8f6a443a643e40951`, PositionManager `0x58daec3116aae6d93017baaea7749052e8a04fa7`,
  UniversalRouter `0x8876789976decbfcbbbe364623c63652db8c0904`

## What already ran (free)

- `lz`: `forge test` 3/3, `hardhat test` 1/1. `lz:deploy` rehearsed on an anvil fork of Robinhood mainnet
  against the real EndpointV2: 2,875,621 gas, name/symbol/decimals/sharedDecimals(6)/owner/totalSupply(0) checked.
  `bash lz/test-fork-deploy.sh` repeats it.
- `lz`: Solana OFT program built reproducibly in Docker: `target/verifiable/oft.so`, 540,040 bytes.
  Rent-exempt minimum 2.74428204 SOL at exact size (`--max-len 540040`), 5.48768524 SOL with the default 2x headroom.
- `uniswap`: pool initialized, full-range liquidity minted, quote read, 0.001 ETH bought through the
  UniversalRouter, all on an anvil fork of Robinhood mainnet with a mock token. `bash uniswap/test-fork.sh` repeats it.
- `launch`: image rendered, metadata pinned to IPFS and read back, dry run passes. The mint is not on chain.

Not yet exercised: a live LayerZero message. That needs the Solana program and adapter on mainnet (or devnet
SOL for a rehearsal; the deployer has none and public airdrops are rate limited).

## Costs

- One-time: program rent 2.744 SOL (exact size) or 5.488 SOL (default headroom). One program serves every
  later launch; each launch only adds an OFT store.
- Per launch: pump.fun create + dev buy (`DEV_BUY_SOL` in `launch/.env`, 0.05); `LockstepOFT` deploy
  2,875,621 gas (Robinhood gas price was 0.076 gwei when measured); adapter + wiring account rents on Solana;
  LayerZero fees per bridge send (quoted by `lz:oft:send` before it sends); the ETH you seed the pool with,
  which remains yours as LP.

## Run sheet (mainnet, in order, each command is yours to run)

Fund first: SOL to `CbezAz2tauHMhacv2X4mcqWvML8hfUH1o683NiRtqNrG` (program rent above, plus the dev buy,
plus fees and rents for the deploy, adapter, wiring and sends). `launch/fund.py` moves it from the Twinpad pool
wallet: `python3 fund.py` dry-runs 0.1 SOL (the launch alone), `python3 fund.py --sol 3.5 --confirm` sends enough
for the whole sheet; it reads `POOL_SOL_KEY` from the file named by `POOL_ENV` in `launch/.env` and refuses to
cross the pool's `POOL_MIN_SOL` floor. `launch/fund-eth.sh` does the same for ETH from the pool EVM wallet
(`bash fund-eth.sh` dry-runs 0.03 ETH, `--confirm` sends, floor `POOL_MIN_ETH`). ETH on Robinhood Chain to
`0x3F0b2De9ABbC1eB7a787018C18B95548b5DC7aa3` (deploy + wiring gas, the pool seed, the swap test, the return
bridge fee). Fresh clone only: `pnpm install` in `lz/` and `uniswap/`, then rebuild the program with
`cd lz && anchor build -v -e OFT_ID=3j8E9XzJ5LpKPcHMWyB36oE1ju9CZ2MvMXTYqFdn97MZ` (Docker).

1. Launch on pump.fun (writes `launch/out/launch.json`, verifies the coin is live):
```bash
cd poc/oft-twin/launch && python3 launch.py --confirm
```
2. Deploy the OFT program to Solana mainnet (exact size; later upgrades need `solana program extend`):
```bash
cd lz && bash deploy-program.sh            # dry run: checks id-in-binary, balance, rent, not-yet-deployed
cd lz && bash deploy-program.sh --confirm  # runs: solana program deploy --program-id ../.keys/oft-program-keypair.json target/verifiable/oft.so --url "$RPC_URL_SOLANA" --keypair ../.keys/solana-deployer.json --max-len 540040 --with-compute-unit-price 50000 --use-rpc
```
3. Create the OFT Adapter for the pump.fun mint (writes `lz/deployments/solana-mainnet/OFT.json`):
```bash
cd poc/oft-twin/lz && pnpm hardhat lz:oft-adapter:solana:create --eid 30168 --program-id 3j8E9XzJ5LpKPcHMWyB36oE1ju9CZ2MvMXTYqFdn97MZ --mint 2QFZpv8PHcJXNLHZd6S3pEFcf6tpog1BZvVLHGE85Vrb --token-program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
```
4. Deploy LockstepOFT on Robinhood Chain (writes `lz/deployments/robinhood-mainnet/LockstepOFT.json`):
```bash
cd poc/oft-twin/lz && pnpm hardhat lz:deploy --ci --networks robinhood-mainnet --tags LockstepOFT
```
5. Initialize the Solana send/receive config accounts:
```bash
cd poc/oft-twin/lz && pnpm hardhat lz:oft:solana:init-config --oapp-config layerzero.config.ts
```
6. Wire both sides (peers, DVN = LayerZero Labs, confirmations, enforced options); review the plan it prints, then confirm:
```bash
cd poc/oft-twin/lz && pnpm hardhat lz:oapp:wire --oapp-config layerzero.config.ts
```
7. Bridge LSTP from Solana to Robinhood (amount in whole tokens, below your balance from the dev buy; fee quoted first):
```bash
cd poc/oft-twin/lz && pnpm hardhat lz:oft:send --src-eid 30168 --dst-eid 30416 --amount 100000 --to 0x3F0b2De9ABbC1eB7a787018C18B95548b5DC7aa3
```
   Follow the message on https://layerzeroscan.com. When it lands, `LockstepOFT.totalSupply()` equals the escrowed amount.
8. Seed the Uniswap v4 pool at the live pump.fun price (dry run first; it prints the LSTP it needs):
```bash
cd poc/oft-twin/uniswap && pnpm seed -- --mint 2QFZpv8PHcJXNLHZd6S3pEFcf6tpog1BZvVLHGE85Vrb --eth 0.01
```
```bash
cd poc/oft-twin/uniswap && pnpm seed -- --mint 2QFZpv8PHcJXNLHZd6S3pEFcf6tpog1BZvVLHGE85Vrb --eth 0.01 --confirm
```
   It prints the pool id and the DexScreener link `https://dexscreener.com/robinhood/<poolId>`.
   If the price feed is down, pass `--price-eth <ETH per LSTP>` instead of `--mint`.
9. Buy through the UniversalRouter, the path the bots use:
```bash
cd poc/oft-twin/uniswap && pnpm seed -- --mint 2QFZpv8PHcJXNLHZd6S3pEFcf6tpog1BZvVLHGE85Vrb --swap-test 0.001
```
10. Bridge back to Solana (burn on Robinhood, unlock from the escrow):
```bash
cd poc/oft-twin/lz && pnpm hardhat lz:oft:send --src-eid 30416 --dst-eid 30168 --amount 1000 --to CbezAz2tauHMhacv2X4mcqWvML8hfUH1o683NiRtqNrG
```

Checks along the way: `pnpm hardhat lz:oft:solana:debug --eid 30168`, `pnpm hardhat lz:oapp:config:get --oapp-config layerzero.config.ts`,
Blockscout `https://robinhoodchain.blockscout.com/address/<LockstepOFT>`, pump.fun `https://pump.fun/coin/2QFZpv8PHcJXNLHZd6S3pEFcf6tpog1BZvVLHGE85Vrb`.

## After the PoC proves out

- Add required DVNs (Nethermind, Horizen) in `layerzero.config.ts` and re-run `lz:oapp:wire`.
- Set rate limits (`lz:oft:solana:set-outbound-rate-limit`, inbound likewise) and move the Solana OFT store
  admin and the `LockstepOFT` owner/delegate to a multisig; finalize the program upgrade authority.
- Productize: Twinpad launches the pump.fun coin, creates the adapter, deploys the OFT, wires, bridges a slice
  and seeds the pool from the same run sheet. Venue on Solana is interchangeable (Meteora DBC or Raydium
  LaunchLab produce an SPL mint the adapter can lock); only `launch/` changes.

## Testnet rehearsal (optional)

Same tasks with `--oapp-config layerzero.testnet.config.ts`, `--eid 40168` for Solana devnet, network
`robinhood-testnet` (chainId 46630, no Uniswap v4 there). Needs devnet SOL for the payer (program rent is the
same 2.744 SOL) and Robinhood testnet ETH for the EVM deployer; both come from captcha-gated faucets.
