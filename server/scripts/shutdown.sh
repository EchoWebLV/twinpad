#!/usr/bin/env bash
# Wind the pad down: close every live coin, pull all ETH into the pool wallet, hide everything.
# Dry run by default; --confirm does it for real.
set -uo pipefail

API="${API:-https://server-production-27d94.up.railway.app}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIRM=0
[ "${1:-}" = "--confirm" ] && CONFIRM=1

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ---- token: whatever is already exported, else straight from Railway. Never printed.
if [ -z "${ADMIN_TOKEN:-}" ]; then
  ADMIN_TOKEN="$(cd "$REPO" && railway variables --service server --json 2>/dev/null \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("ADMIN_TOKEN",""))' 2>/dev/null)"
fi
if [ -z "$ADMIN_TOKEN" ]; then
  echo "No ADMIN_TOKEN. Run 'railway login' and 'railway link' in $REPO, or export ADMIN_TOKEN yourself." >&2
  exit 1
fi

H=(-H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json')
code="$(curl -s -o /dev/null -w '%{http_code}' "$API/api/admin/pool/status" "${H[@]}")"
if [ "$code" != "200" ]; then
  echo "Admin auth failed (HTTP $code). The token did not work against $API." >&2
  exit 1
fi
echo "admin auth ok"

# ---- what is live
live="$(curl -s "$API/api/paid" "${H[@]}" \
  | python3 -c 'import sys,json; print(" ".join(l["id"] for l in json.load(sys.stdin) if l["status"] in ("live","failed","closing")))')"

if [ "$CONFIRM" = "0" ]; then
  say "DRY RUN — nothing will move. Re-run with --confirm."
  echo "would close:${live:- nothing}"
  say "ETH that would be collected into the pool wallet"
  curl -s -X POST "$API/api/admin/pool/sweep-eth" "${H[@]}" -d '{}' \
    | python3 -c 'import sys,json
d=json.load(sys.stdin)
for w in d["wallets"]:
    print("  {:14s} {:12s} {:.5f} ETH  {}".format(w["id"], w["wallet"], w["eth"], w.get("skipped","")))
print("  pool now {:.5f} ETH at {}".format(d["pool"]["eth"], d["pool"]["address"]))'
  echo
  echo "would then hide every launch from the public lists"
  exit 0
fi

# ---- 1. close every live coin (sells both sides, claims creator fees, sweeps to the pool)
say "1/3  closing coins"
if [ -z "$live" ]; then
  echo "  nothing live"
else
  for c in $live; do
    printf '  %s ... ' "$c"
    curl -s --max-time 900 -X POST "$API/api/admin/coins/$c/close" "${H[@]}" -d '{"reason":"shutdown"}' \
      | python3 -c 'import sys,json
try:
  r=json.load(sys.stdin); print(r.get("status") or r.get("error"))
except Exception: print("no response")'
  done
fi

# ---- 2. every per-coin EVM wallet into the pool wallet
say "2/3  collecting ETH into the pool wallet"
curl -s --max-time 600 -X POST "$API/api/admin/pool/sweep-eth" "${H[@]}" -d '{"confirm":true,"includeLive":true}' \
  | python3 -c 'import sys,json
d=json.load(sys.stdin)
for w in d["wallets"]:
    tag=w.get("tx") or w.get("error") or w.get("skipped","")
    print("  {:14s} {:12s} {:.5f} ETH  {}".format(w["id"], w["wallet"], w["eth"], tag))
print("  moved {:.5f} ETH".format(d["moved"]))
print("  pool  {:.5f} ETH at {}".format(d["pool"]["eth"], d["pool"]["address"]))'

# ---- 3. hide everything
say "3/3  hiding every launch"
curl -s -X POST "$API/api/admin/paid/all/hidden" "${H[@]}" -d '{"hidden":true}' \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print("  hidden:", ", ".join(d["ids"]))'

# ---- where things landed
say "done"
curl -s "$API/api/pool" | python3 -c 'import sys,json
p=json.load(sys.stdin)
print("  pool SOL {:.4f} at {}".format(p["solana"]["balance"], p["solana"]["address"]))
print("  pool ETH {:.5f} at {}".format(p["robinhood"]["balance"], p["robinhood"]["address"]))'
echo "  public list:"
curl -s "$API/api/paid" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("   ", len(d), "launches visible")'
curl -s "$API/api/coins" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("   ", len(d), "coins visible")'
