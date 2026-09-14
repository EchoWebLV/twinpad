#!/bin/bash
# Deploy the OFT program to Solana mainnet under our pre-generated program id.
# Dry run by default (checks only, spends nothing).   bash deploy-program.sh --confirm   deploys.
set -euo pipefail
cd "$(dirname "$0")"
SO=target/verifiable/oft.so
# Priority fee per compute unit (microlamports). Helius getPriorityFeeEstimate for loader writes: high 82k, veryHigh 1.5M.
# 50k landed ~25 writes per blockhash (too slow); at 1.5M a write costs ~0.000005 SOL, ~0.003 SOL for the whole upload.
CU_PRICE=${CU_PRICE:-1500000}
# SENDER=rpc (default, via the Helius RPC) or SENDER=tpu (QUIC straight to the leaders)
SENDER_FLAG=$([ "${SENDER:-rpc}" = tpu ] && echo --use-tpu-client || echo --use-rpc)
KP=../.keys/oft-program-keypair.json
DEPLOYER=../.keys/solana-deployer.json
RPC=$(grep -E '^RPC_URL_SOLANA=' .env | cut -d= -f2- | tr -d '"' | tr -d "'")
[ -n "$RPC" ] || { echo "RPC_URL_SOLANA missing in lz/.env"; exit 1; }
[ -f "$SO" ] || { echo "missing $SO: cd lz && anchor build -v -e OFT_ID=$(solana-keygen pubkey "$KP")"; exit 1; }
SIZE=$(stat -f%z "$SO")
PROG=$(solana-keygen pubkey "$KP")
DEP=$(solana-keygen pubkey "$DEPLOYER")
if [ "${1:-}" = "--close-buffers" ]; then
  echo "== closing upload buffers owned by $DEP (rent goes back to the deployer) =="
  solana program show --buffers --buffer-authority "$DEP" --url "$RPC"
  solana program close --buffers --authority "$DEPLOYER" --recipient "$DEP" --keypair "$DEPLOYER" --url "$RPC"
  echo "balance   $(solana balance "$DEP" --url "$RPC")"; exit 0
fi
echo "== OFT program deploy ${1:-[DRY RUN]} =="
echo "program   $PROG"
echo "binary    $SO ($SIZE bytes)"
echo "deployer  $DEP"
# the binary must carry this program id (Anchor declare_id), or every instruction fails on-chain
python3 - "$SO" "$PROG" <<'PY'
import sys
from solders.pubkey import Pubkey
so = open(sys.argv[1], "rb").read(); pk = bytes(Pubkey.from_string(sys.argv[2]))
ok = pk in so
print("id in .so ", "yes" if ok else "NO: rebuild with OFT_ID=" + sys.argv[2])
sys.exit(0 if ok else 1)
PY
BAL=$(solana balance "$DEP" --url "$RPC" | awk '{print $1}')
RENT=$(solana rent $((45 + SIZE)) --url "$RPC" | awk '/Rent-exempt minimum/ {print $3}')
echo "balance   $BAL SOL"
echo "rent      $RENT SOL locked in ProgramData (45 + $SIZE bytes), plus ~0.001 SOL program account and fees"
if solana program show "$PROG" --url "$RPC" >/dev/null 2>&1; then
  echo "already deployed:"; solana program show "$PROG" --url "$RPC"; exit 0
fi
echo "on-chain  not deployed yet"
echo "settings  cu price $CU_PRICE microlamports, 50 sign attempts, sender ${SENDER:-rpc}"
awk -v b="$BAL" -v r="$RENT" 'BEGIN { if (b + 0 < r + 0.02) { print "!! deployer cannot cover rent + fees"; exit 1 } }'
if [ "${1:-}" != "--confirm" ]; then
  echo "dry run only. To deploy:  bash deploy-program.sh --confirm"; exit 0
fi
if ! solana program deploy --program-id "$KP" "$SO" --url "$RPC" --keypair "$DEPLOYER" \
     --max-len "$SIZE" --with-compute-unit-price "$CU_PRICE" --max-sign-attempts 50 $SENDER_FLAG; then
  echo "!! deploy failed. If it stopped midway the rent sits in a buffer account owned by the deployer."
  echo "   refund it:   bash deploy-program.sh --close-buffers      then rerun:   bash deploy-program.sh --confirm"
  echo "   (or resume with the CLI's printed --buffer keypair: solana-keygen recover -o buffer.json, then add --buffer buffer.json)"
  exit 1
fi
echo "== deployed =="
solana program show "$PROG" --url "$RPC"
