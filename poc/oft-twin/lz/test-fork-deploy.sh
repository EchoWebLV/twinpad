#!/usr/bin/env bash
# Rehearse `lz:deploy` of LockstepOFT against an anvil fork of Robinhood Chain mainnet (real EndpointV2 at 0x6F47…DD5B).
# Uses anvil's well-known account #0. Nothing touches mainnet. Prints gas so the mainnet ETH need can be quoted.
set -euo pipefail
cd "$(dirname "$0")"
FORK_URL=${FORK_URL:-https://rpc.mainnet.chain.robinhood.com}
PORT=${PORT:-8546}
export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil account 0
# LayerZero devtools allow one network per eid, so the rehearsal reuses `robinhood-mainnet` with its RPC pointed at anvil.
export RPC_URL_ROBINHOOD="http://127.0.0.1:$PORT"
if [ -e deployments/robinhood-mainnet/LockstepOFT.json ]; then
  echo "deployments/robinhood-mainnet/LockstepOFT.json exists (a real deployment?). Move it away before rehearsing."; exit 1
fi
LOG=$(mktemp -t anvil)
anvil --fork-url "$FORK_URL" --port "$PORT" --silent > "$LOG" 2>&1 &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true; rm -rf deployments/robinhood-mainnet' EXIT
for i in $(seq 1 60); do cast chain-id --rpc-url "http://127.0.0.1:$PORT" >/dev/null 2>&1 && break; sleep 1; done
echo "anvil fork up, chain id $(cast chain-id --rpc-url http://127.0.0.1:$PORT)"
npx hardhat lz:deploy --ci --networks robinhood-mainnet --tags LockstepOFT
ADDR=$(jq -r .address deployments/robinhood-mainnet/LockstepOFT.json)
TX=$(jq -r .transactionHash deployments/robinhood-mainnet/LockstepOFT.json)
RPC="http://127.0.0.1:$PORT"
echo "LockstepOFT at $ADDR"
echo "gasUsed      $(cast receipt "$TX" gasUsed --rpc-url $RPC)"
echo "name/symbol  $(cast call $ADDR 'name()(string)' --rpc-url $RPC) / $(cast call $ADDR 'symbol()(string)' --rpc-url $RPC)"
echo "decimals     $(cast call $ADDR 'decimals()(uint8)' --rpc-url $RPC)  sharedDecimals $(cast call $ADDR 'sharedDecimals()(uint8)' --rpc-url $RPC)"
echo "endpoint     $(cast call $ADDR 'endpoint()(address)' --rpc-url $RPC)"
echo "owner        $(cast call $ADDR 'owner()(address)' --rpc-url $RPC)"
echo "totalSupply  $(cast call $ADDR 'totalSupply()(uint256)' --rpc-url $RPC)  (must be 0: supply only arrives over the bridge)"
echo "fork deploy passed"
