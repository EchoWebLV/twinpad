#!/bin/bash
# Top up the PoC EVM deployer on Robinhood Chain from the Twinpad pool EVM wallet.
# Dry run by default (balances + gas, sends nothing).   bash fund-eth.sh [--eth 0.03] --confirm   sends.
# Reads POOL_EVM_KEY from the pool env file (POOL_ENV in ./.env or --pool-env); the key is passed to cast
# through the environment of that one process and never printed. Refuses to cross the pool's POOL_MIN_ETH floor.
set -euo pipefail
cd "$(dirname "$0")"
AMOUNT=0.03; CONFIRM=no; POOL_ENV_ARG=""; TO_ARG=""; RPC_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --eth) AMOUNT="$2"; shift 2 ;;
    --to) TO_ARG="$2"; shift 2 ;;
    --pool-env) POOL_ENV_ARG="$2"; shift 2 ;;
    --rpc) RPC_ARG="$2"; shift 2 ;;
    --confirm) CONFIRM=yes; shift ;;
    *) echo "unknown arg $1"; exit 1 ;;
  esac
done
getvar() { grep -E "^$2=" "$1" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'"; }
POOL_ENV=${POOL_ENV_ARG:-$(getvar .env POOL_ENV)}; POOL_ENV=${POOL_ENV:-../../../server/.env.pool}
[ -f "$POOL_ENV" ] || { echo "pool env not found: $POOL_ENV"; exit 1; }
KEY=$(getvar "$POOL_ENV" POOL_EVM_KEY); [ -n "$KEY" ] || { echo "POOL_EVM_KEY missing in $POOL_ENV"; exit 1; }
RPC=${RPC_ARG:-https://rpc.mainnet.chain.robinhood.com}   # the pool env may hold a comma-separated fallback list; a one-off transfer uses the official RPC
FLOOR=$(getvar "$POOL_ENV" POOL_MIN_ETH); FLOOR=${FLOOR:-0}
FROM=$(cast wallet address --private-key "$KEY")
if [ -n "$TO_ARG" ]; then TO="$TO_ARG"; else TO=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); d=d[0] if isinstance(d,list) else d; print(d["address"])' ../.keys/evm-deployer.json); fi
TO=$(cast to-check-sum-address "$TO")
CHAIN=$(cast chain-id --rpc-url "$RPC")
FROM_BAL=$(cast balance "$FROM" --rpc-url "$RPC" --ether); TO_BAL=$(cast balance "$TO" --rpc-url "$RPC" --ether)
GAS=$(cast gas-price --rpc-url "$RPC")
echo "== fund EVM deployer $([ $CONFIRM = yes ] && echo '[SEND]' || echo '[DRY RUN]') =="
echo "pool env  $POOL_ENV"
echo "rpc       $RPC (chain $CHAIN)"
echo "from      $FROM  $FROM_BAL ETH"
echo "to        $TO  $TO_BAL ETH"
echo "amount    $AMOUNT ETH  (gas price $GAS wei; 21000 gas)"
python3 - "$FROM_BAL" "$AMOUNT" "$FLOOR" <<'PY'
import sys
bal, amt, floor = map(float, sys.argv[1:4])
print(f"pool after {bal - amt:.6f} ETH  (floor POOL_MIN_ETH={floor})")
if bal < amt + 0.0001: sys.exit("refusing: pool wallet cannot cover amount + gas")
if bal - amt < floor: sys.exit(f"refusing: would drop the pool below its POOL_MIN_ETH floor of {floor} ETH")
PY
[ "$CHAIN" = "4663" ] || { echo "refusing: expected Robinhood Chain 4663, got $CHAIN"; exit 1; }
if [ $CONFIRM != yes ]; then echo "dry run only. To send:  bash fund-eth.sh --eth $AMOUNT --confirm"; exit 0; fi
OUT=$(ETH_PRIVATE_KEY="$KEY" cast send "$TO" --value "${AMOUNT}ether" --rpc-url "$RPC" --private-key "$KEY" --json)
TX=$(printf '%s' "$OUT" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["transactionHash"], d["status"])')
echo "tx        $TX"
echo "to        $TO  $(cast balance "$TO" --rpc-url "$RPC" --ether) ETH"
echo "pool      $FROM  $(cast balance "$FROM" --rpc-url "$RPC" --ether) ETH"
