#!/usr/bin/env bash
# End-to-end rehearsal of seed-pool.ts against an anvil fork of Robinhood Chain mainnet.
# Uses anvil's well-known test account #0 (public key material, not a secret). Nothing touches mainnet.
set -euo pipefail
cd "$(dirname "$0")"
FORK_URL=${FORK_URL:-https://rpc.mainnet.chain.robinhood.com}
PORT=${PORT:-8545}
KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil account 0
ADDR=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
LOG=$(mktemp -t anvil)
anvil --fork-url "$FORK_URL" --port "$PORT" --silent > "$LOG" 2>&1 &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true' EXIT
for i in $(seq 1 60); do cast chain-id --rpc-url "http://127.0.0.1:$PORT" >/dev/null 2>&1 && break; sleep 1; done
echo "anvil fork up, chain id $(cast chain-id --rpc-url http://127.0.0.1:$PORT), block $(cast block-number --rpc-url http://127.0.0.1:$PORT)"
forge build --silent
BYTECODE=$(forge inspect contracts/MockLSTP.sol:MockLSTP bytecode)
CTOR=$(cast abi-encode "constructor(uint256)" 1000000000000000000000000000)
TOKEN=$(cast send --rpc-url "http://127.0.0.1:$PORT" --private-key "$KEY" --json --create "${BYTECODE}${CTOR#0x}" | jq -r .contractAddress)
echo "mock LSTP deployed at $TOKEN (1,000,000,000 * 1e18 to $ADDR)"
export PRIVATE_KEY=$KEY
echo "--- dry run"
pnpm -s seed -- --rpc "http://127.0.0.1:$PORT" --token "$TOKEN" --price-eth 0.0000001 --eth 0.05
echo "--- confirm (initialize + mint full-range liquidity)"
pnpm -s seed -- --rpc "http://127.0.0.1:$PORT" --token "$TOKEN" --price-eth 0.0000001 --eth 0.05 --confirm
echo "--- swap 0.001 ETH -> LSTP through the UniversalRouter (what Axiom/GMGN/DexScreener-linked bots use)"
pnpm -s seed -- --rpc "http://127.0.0.1:$PORT" --token "$TOKEN" --price-eth 0.0000001 --swap-test 0.001
echo "--- one-sided seed on the 0.3% tier: 1,000,000 LSTP, zero ETH; dry run, confirm, then buy 0.01 ETH through the router"
pnpm -s seed -- --rpc "http://127.0.0.1:$PORT" --token "$TOKEN" --price-eth 0.0000001 --fee 3000 --lstp 1000000
pnpm -s seed -- --rpc "http://127.0.0.1:$PORT" --token "$TOKEN" --price-eth 0.0000001 --fee 3000 --lstp 1000000 --confirm
pnpm -s seed -- --rpc "http://127.0.0.1:$PORT" --token "$TOKEN" --price-eth 0.0000001 --fee 3000 --swap-test 0.01
echo "fork test passed"
