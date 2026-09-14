# Lockstep: one-supply twin over LayerZero OFT (proof of concept)

Date: 2026-09-15. Branch `poc/oft-twin`. Status: built and rehearsed locally; mainnet steps are the operator's to run (see `poc/oft-twin/README.md`).

## Why

Twinpad today launches two separate coins (pump.fun on Solana, Pons on Robinhood Chain) and pays a maker bot to hold the two prices together. The bot needs inventory on both chains and loses money when the gap moves against it. TWINE, which Twinpad copies, has the same weakness and its holders noticed.

An OFT twin has one supply. Tokens exist on Robinhood only while the same amount is locked on Solana. If the two prices drift, anyone can buy on the cheap side, bridge, and sell on the dear side. Arbitrage does the maker's job for free, and there is no bot that can be drained.

## Design

- **Solana side**: an ordinary pump.fun launch (Lockstep, LSTP, mint `2QFZpv8PHcJXNLHZd6S3pEFcf6tpog1BZvVLHGE85Vrb`, 6 decimals). Nothing about it changes for pump.fun users or their bots.
- **Bridge**: LayerZero V2 OFT. On Solana an OFT Adapter (lock/unlock) wraps the existing mint, so it works even though pump.fun revokes mint authority. On Robinhood Chain a native OFT ERC-20 (`LockstepOFT`, 18 decimals, shared decimals 6) mints on arrival and burns on the way back. Total Robinhood supply always equals the adapter's escrow balance.
- **Robinhood side**: a Uniswap v4 ETH/LSTP pool (1% fee, full range, no hooks) seeded at the current pump.fun price. Uniswap v4 on Robinhood is what Axiom, GMGN and DexScreener already index, so trading tools work without any integration.
- **Security**: one required DVN (LayerZero Labs) for the PoC, with the config generator ready to add Nethermind and Horizen. Enforced options: 80k gas for the EVM mint, 200k CU plus token-account rent for the Solana unlock. Admin keys stay with the deployer during the PoC and move to a multisig (or are burned) afterwards.
- **No token taxes, no fee-on-transfer.** Routers and bots assume a plain ERC-20.

## What was verified without spending

- `LockstepOFT` compiles; the Foundry suite (3 tests) and Hardhat suite (1 test) pass.
- `lz:deploy` of `LockstepOFT` against an anvil fork of Robinhood mainnet, talking to the real EndpointV2 (`0x6F475642a6e85809B1c36Fa62763669b1b48DD5B`): 2,875,621 gas; name/symbol/decimals/sharedDecimals/owner/totalSupply as expected.
- The Solana OFT program built reproducibly in Docker (`target/verifiable/oft.so`, 540,040 bytes). Program id `3j8E9XzJ5LpKPcHMWyB36oE1ju9CZ2MvMXTYqFdn97MZ`. Rent-exempt minimum for the program data account: 2.744 SOL at exact size (`--max-len 540040`), 5.488 SOL with the default 2x headroom.
- The Uniswap v4 seeding script initialized a pool, minted full-range liquidity, quoted a swap and bought through the UniversalRouter on an anvil fork of Robinhood mainnet with a mock 18-decimal token.
- pump.fun metadata pinned to IPFS and read back through a gateway; the launch script dry run passes; the mint is not on chain yet.

## Not verified yet

- A live LayerZero message in either direction. That needs the program deployed and the adapter created on Solana mainnet, or devnet SOL for a rehearsal (the fresh deployer has none and airdrops are rate limited).
- LayerZero fees per send. `lz:oft:send` quotes them before sending.
- DexScreener pickup of the new pool. Expected from its Robinhood indexing; confirmed only once the pool exists.

## Costs (measured or quoted, not estimated)

- One-time: Solana OFT program rent 2.744 SOL (exact size) or 5.488 SOL (default headroom), reusable for every later launch because one program hosts many OFT stores.
- Per launch: pump.fun create plus dev buy; `LockstepOFT` deploy at 2,875,621 gas (0.076 gwei on Robinhood at the time of writing, so a fraction of a cent); adapter and wiring account rents on Solana; the ETH you choose to seed the pool with, which stays yours as LP.
- Gone: the Pons launch, the maker bot's inventory on both chains, and its losses.

## Alternatives considered

- Native OFT on both chains (mint/burn on Solana too): needs mint authority, which pump.fun revokes. Rejected.
- Mint-and-burn adapter (MABA): same mint-authority requirement. Rejected.
- Keeping the maker bot as a safety net: reintroduces the drainable inventory the design removes. Rejected.
- Other Solana venues (Meteora DBC, Raydium LaunchLab): the adapter locks any SPL mint, so the venue is a swap of the `launch/` folder only. pump.fun kept for the PoC for cost and bot discovery.
