#!/bin/bash
# rescue-bridge.sh: deliver the two stuck Solana->Robinhood LayerZero messages (nonces 1 and 2, 100,000 LSTP each)
# to LockstepOFT by temporarily making the OApp owner the only required verifier, then restoring the original
# receive config (LayerZero Labs DVN). Only the OApp owner/delegate can do this; it changes nothing on Solana.
#
# Ran on Robinhood mainnet 2026-09-14 23:44Z (by the user): nonce 1 delivered in tx 0x79679886f59eac06dea990b6f5f00259e9dc2d7b21a923987253b1829098ee04,
# nonce 2 in 0x3e47c7f4cc2e8ce5682da0dc6c0db9484bf4349c4ae91528ad42f4ddb407bacc; receive config restored to LayerZero Labs.
# CFG_ORIG below is the single-DVN config of that day; the live config has since moved to LayerZero Labs + Nethermind,
# so before reusing this script set CFG_ORIG to the current `getUlnConfig` output and replace HDR/GUID/PH for the new nonces.
#
# Modes:
#   (no arg)   dry run: print the plan and eth_call-simulate the first steps, send nothing
#   --fork     rehearse every step on a local anvil fork of Robinhood (impersonated owner), send nothing on mainnet
#   --confirm  send on Robinhood mainnet, signing with PRIVATE_KEY from poc/oft-twin/lz/.env (value never printed)
set -euo pipefail
MODE=${1:-dry}
ENVF=${ENVF:-$HOME/Documents/GitHub/duo-launcher-pad-oft-poc/poc/oft-twin/lz/.env}
MAIN=https://rpc.mainnet.chain.robinhood.com
EP=0x6F475642a6e85809B1c36Fa62763669b1b48DD5B   # EndpointV2 on Robinhood
RL=0xe1844c5D63a9543023008D332Bd3d2e6f1FE1043   # ReceiveUln302 on Robinhood
C=0x0ABc9Ae77ca2e4b442D1c9a6A335bb2E15128f42    # LockstepOFT
DEP=0x3F0b2De9ABbC1eB7a787018C18B95548b5DC7aa3  # owner and endpoint delegate
LZ=0xd01ae6905d48315f7be10c7330aecf8360ef5b12   # LayerZero Labs DVN (original config)
SENDER=0xb4cdfc71a090a1eb76d9f4aa89b4746f99b14e0370e4010f20f6d1dec4c1ab1f  # Solana OFT Store as bytes32
SRC=30168
MSG=0x0000000000000000000000003f0b2de9abbc1eb7a787018c18b95548b5dc7aa3000000174876e800  # to=deployer, amountSD 1e11 (100,000 LSTP)
HDR[1]=0x010000000000000001000075d8b4cdfc71a090a1eb76d9f4aa89b4746f99b14e0370e4010f20f6d1dec4c1ab1f000076d00000000000000000000000000abc9ae77ca2e4b442d1c9a6a335bb2e15128f42
HDR[2]=0x010000000000000002000075d8b4cdfc71a090a1eb76d9f4aa89b4746f99b14e0370e4010f20f6d1dec4c1ab1f000076d00000000000000000000000000abc9ae77ca2e4b442d1c9a6a335bb2e15128f42
GUID[1]=0xc0d8fb6e099525c44f14766580f9d94c335422af6186a6aec3a94c30662f0e1a
GUID[2]=0x2a518ac0a48dd29f859f63a8233f8279b9780bad94070bd477914ec72e38f1ba
PH[1]=0x8db0b73253d815f39cc17a0e6827d2f55f16de91756b18c1888f4c7f5ed71fa0
PH[2]=0x7b4c914003729f23542ae93d917f1774d88320500e29c5bbb3e9530d3eb6fc9a
CFG_SELF=$(cast abi-encode 'f((uint64,uint8,uint8,uint8,address[],address[]))' "(32,1,0,0,[$DEP],[])")
CFG_ORIG=$(cast abi-encode 'f((uint64,uint8,uint8,uint8,address[],address[]))' "(32,1,0,0,[$LZ],[])")

# sanity: recompute guid and payload hash from the header + message, refuse to run if they drift
for N in 1 2; do
  h=${HDR[$N]}; g=$(cast keccak "0x${h:4}"); [ "$g" = "${GUID[$N]}" ] || { echo "guid mismatch nonce $N"; exit 1; }
  p=$(cast keccak "${GUID[$N]}${MSG:2}"); [ "$p" = "${PH[$N]}" ] || { echo "payload hash mismatch nonce $N"; exit 1; }
done

ANVIL_PID=""
cleanup() { [ -n "$ANVIL_PID" ] && kill "$ANVIL_PID" 2>/dev/null || true; }
trap cleanup EXIT

case "$MODE" in
  --fork)
    RPC=http://127.0.0.1:8546
    anvil --fork-url "$MAIN" --port 8546 --auto-impersonate --silent >/dev/null 2>&1 &
    ANVIL_PID=$!
    for i in $(seq 1 40); do cast chain-id --rpc-url $RPC >/dev/null 2>&1 && break; sleep 0.5; done
    cast chain-id --rpc-url $RPC >/dev/null 2>&1 || { echo "anvil fork did not come up"; exit 1; }
    cast rpc anvil_setBalance $DEP 0x8ac7230489e80000 --rpc-url $RPC >/dev/null
    SEND=(cast send --unlocked --from $DEP --rpc-url $RPC)
    echo "== FORK rehearsal (chain id $(cast chain-id --rpc-url $RPC), block $(cast block-number --rpc-url $RPC)); nothing is sent to mainnet";;
  --confirm)
    RPC=$MAIN
    PRIVATE_KEY=$(grep -m1 '^PRIVATE_KEY=' "$ENVF" | cut -d= -f2- | tr -d '"'"'"' \r' | tr -d ' ')
    [ -n "${PRIVATE_KEY:-}" ] || { echo "PRIVATE_KEY missing in $ENVF"; exit 1; }
    [ "$(cast wallet address --private-key "$PRIVATE_KEY")" = "$DEP" ] || { echo "PRIVATE_KEY in $ENVF is not the owner $DEP"; exit 1; }
    SEND=(cast send --private-key "$PRIVATE_KEY" --rpc-url $RPC)
    echo "== MAINNET (chain id $(cast chain-id --rpc-url $RPC)); owner ETH: $(cast balance $DEP --rpc-url $RPC --ether)";;
  *)
    RPC=$MAIN
    echo "== DRY RUN. Plan: 1) setConfig receive ULN for src $SRC -> required DVN = owner  2) verify + commitVerification for nonces 1,2"
    echo "   3) endpoint.lzReceive nonces 1,2 (mints 100,000 LSTP each to $DEP)  4) setConfig back to LayerZero Labs DVN"
    echo "   current totalSupply=$(cast call $C 'totalSupply()(uint256)' --rpc-url $RPC)  lazyInboundNonce=$(cast call $EP 'lazyInboundNonce(address,uint32,bytes32)(uint64)' $C $SRC $SENDER --rpc-url $RPC)"
    cast call $EP 'setConfig(address,address,(uint32,uint32,bytes)[])' $C $RL "[($SRC,2,$CFG_SELF)]" --from $DEP --rpc-url $RPC >/dev/null && echo "   eth_call setConfig(owner as DVN): ok"
    cast call $RL 'verify(bytes,bytes32,uint64)' "${HDR[1]}" "${PH[1]}" 32 --from $DEP --rpc-url $RPC >/dev/null && echo "   eth_call verify(nonce 1): ok"
    echo "   run with --fork for a full rehearsal, --confirm to send"; exit 0;;
esac

step() { echo "-- $1"; shift; "${SEND[@]}" "$@" --json | python3 -c 'import sys,json; r=json.load(sys.stdin); print("   tx", r["transactionHash"], "status", r["status"], "gas", int(r["gasUsed"],16))'; }

step "setConfig: receive ULN(src $SRC) required DVN = owner" $EP 'setConfig(address,address,(uint32,uint32,bytes)[])' $C $RL "[($SRC,2,$CFG_SELF)]"
for N in 1 2; do
  lazy=$(cast call $EP 'lazyInboundNonce(address,uint32,bytes32)(uint64)' $C $SRC $SENDER --rpc-url $RPC)
  if [ "$lazy" -ge "$N" ]; then echo "-- nonce $N already executed, skipping"; continue; fi
  have=$(cast call $EP 'inboundPayloadHash(address,uint32,bytes32,uint64)(bytes32)' $C $SRC $SENDER $N --rpc-url $RPC)
  if [ "$have" = "0x0000000000000000000000000000000000000000000000000000000000000000" ]; then
    step "verify nonce $N" $RL 'verify(bytes,bytes32,uint64)' "${HDR[$N]}" "${PH[$N]}" 32
    step "commitVerification nonce $N" $RL 'commitVerification(bytes,bytes32)' "${HDR[$N]}" "${PH[$N]}"
  else echo "-- nonce $N already committed, skipping verify/commit"; fi
  step "lzReceive nonce $N" $EP 'lzReceive((uint32,bytes32,uint64),address,bytes32,bytes,bytes)' "($SRC,$SENDER,$N)" $C "${GUID[$N]}" "$MSG" 0x --gas-limit 400000
done
step "setConfig: restore receive ULN(src $SRC) required DVN = LayerZero Labs" $EP 'setConfig(address,address,(uint32,uint32,bytes)[])' $C $RL "[($SRC,2,$CFG_ORIG)]"
echo "== result: totalSupply=$(cast call $C 'totalSupply()(uint256)' --rpc-url $RPC)  owner LSTP=$(cast call $C 'balanceOf(address)(uint256)' $DEP --rpc-url $RPC)  lazyInboundNonce=$(cast call $EP 'lazyInboundNonce(address,uint32,bytes32)(uint64)' $C $SRC $SENDER --rpc-url $RPC)"
echo "== receive config now: $(cast call $RL 'getUlnConfig(address,uint32)((uint64,uint8,uint8,uint8,address[],address[]))' $C $SRC --rpc-url $RPC)"
