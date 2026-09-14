#!/bin/bash
# Deploy the OFT program to Solana mainnet under our pre-generated program id.
# Dry run by default (checks only, spends nothing).   bash deploy-program.sh --confirm   deploys.
set -euo pipefail
cd "$(dirname "$0")"
SO=target/verifiable/oft.so
KP=../.keys/oft-program-keypair.json
DEPLOYER=../.keys/solana-deployer.json
RPC=$(grep -E '^RPC_URL_SOLANA=' .env | cut -d= -f2- | tr -d '"' | tr -d "'")
[ -n "$RPC" ] || { echo "RPC_URL_SOLANA missing in lz/.env"; exit 1; }
[ -f "$SO" ] || { echo "missing $SO: cd lz && anchor build -v -e OFT_ID=$(solana-keygen pubkey "$KP")"; exit 1; }
SIZE=$(stat -f%z "$SO")
PROG=$(solana-keygen pubkey "$KP")
DEP=$(solana-keygen pubkey "$DEPLOYER")
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
awk -v b="$BAL" -v r="$RENT" 'BEGIN { if (b + 0 < r + 0.02) { print "!! deployer cannot cover rent + fees"; exit 1 } }'
if [ "${1:-}" != "--confirm" ]; then
  echo "dry run only. To deploy:  bash deploy-program.sh --confirm"; exit 0
fi
if ! solana program deploy --program-id "$KP" "$SO" --url "$RPC" --keypair "$DEPLOYER" \
     --max-len "$SIZE" --with-compute-unit-price 50000 --use-rpc; then
  echo "!! deploy failed. If it stopped midway the SOL sits in a buffer account:"
  echo "   solana program show --buffers --keypair $DEPLOYER --url \"\$RPC\"     (list)"
  echo "   rerun this script with the CLI's suggested --buffer, or refund with: solana program close --buffers --keypair $DEPLOYER --url \"\$RPC\""
  exit 1
fi
echo "== deployed =="
solana program show "$PROG" --url "$RPC"
