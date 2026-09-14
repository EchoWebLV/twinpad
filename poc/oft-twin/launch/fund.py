#!/usr/bin/env python3
"""Top up the PoC deployer from the Twinpad pool wallet (SOL only).

Dry run by default: prints both balances and what would move, sends nothing.
  python3 fund.py                 # dry run, default amount
  python3 fund.py --sol 3.5       # dry run, other amount
  python3 fund.py --confirm       # send

The pool key is read from the pool env file (POOL_ENV in ./.env or --pool-env) and never printed.
Refuses to drop the pool below its own POOL_MIN_SOL floor.
Blockhash and preflight both at 'confirmed' (the default 'finalized' preflight rejects a fresh blockhash).
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
from pathlib import Path

import requests
from solders.hash import Hash
from solders.keypair import Keypair
from solders.message import Message
from solders.pubkey import Pubkey
from solders.system_program import TransferParams, transfer
from solders.transaction import Transaction

HERE = Path(__file__).resolve().parent
DEFAULT_SOL = 0.1          # covers the launch: 0.05 dev buy + ~0.03 fees/rent, with slack
FEE_RESERVE_SOL = 0.001    # transfer fee + rounding


def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def resolve(p: str) -> Path:
    q = Path(os.path.expanduser(p))
    return q if q.is_absolute() else (HERE / q).resolve()


def keypair_from_secret(v: str) -> Keypair:
    v = v.strip()
    if v.startswith("["):
        return Keypair.from_bytes(bytes(json.loads(v)))
    return Keypair.from_base58_string(v)


def keypair_from_file(p: Path) -> Keypair:
    return Keypair.from_bytes(bytes(json.loads(p.read_text())))


def rpc(url: str, method: str, params: list):
    r = requests.post(url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=30)
    r.raise_for_status()
    body = r.json()
    if "error" in body:
        raise RuntimeError(f"{method}: {body['error']}")
    return body["result"]


def balance_sol(url: str, pk: Pubkey) -> float:
    return rpc(url, "getBalance", [str(pk), {"commitment": "confirmed"}])["value"] / 1e9


def build_tx(url: str, sender: Keypair, to: Pubkey, lamports: int) -> Transaction:
    bh = rpc(url, "getLatestBlockhash", [{"commitment": "confirmed"}])["value"]["blockhash"]
    ix = transfer(TransferParams(from_pubkey=sender.pubkey(), to_pubkey=to, lamports=lamports))
    msg = Message.new_with_blockhash([ix], sender.pubkey(), Hash.from_string(bh))
    tx = Transaction.new_unsigned(msg)
    tx.sign([sender], Hash.from_string(bh))
    return tx


def send_and_confirm(url: str, tx: Transaction) -> str:
    sig = rpc(url, "sendTransaction", [base64.b64encode(bytes(tx)).decode(),
                                       {"encoding": "base64", "skipPreflight": False, "preflightCommitment": "confirmed",
                                        "maxRetries": 3}])
    print(f"sent      {sig}")
    for _ in range(40):
        st = rpc(url, "getSignatureStatuses", [[sig]])["value"][0]
        if st is not None:
            if st.get("err"):
                raise RuntimeError(f"transfer failed on-chain: {st['err']}")
            if st.get("confirmationStatus") in ("confirmed", "finalized"):
                return sig
        time.sleep(2)
    raise RuntimeError(f"transfer not confirmed yet: {sig}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sol", type=float, default=DEFAULT_SOL, help=f"amount to move (default {DEFAULT_SOL})")
    ap.add_argument("--to", help="recipient pubkey (default: the deployer from SOLANA_KEYPAIR_PATH in ./.env)")
    ap.add_argument("--pool-env", help="pool env file holding POOL_SOL_KEY (default: POOL_ENV in ./.env, else ../../../server/.env.pool)")
    ap.add_argument("--confirm", action="store_true", help="actually send")
    a = ap.parse_args()

    env = load_env(HERE / ".env")
    pool_path = resolve(a.pool_env or env.get("POOL_ENV") or "../../../server/.env.pool")
    pool = load_env(pool_path)
    if "POOL_SOL_KEY" not in pool:
        sys.exit(f"POOL_SOL_KEY not found in {pool_path}")
    sender = keypair_from_secret(pool["POOL_SOL_KEY"])
    floor = float(pool.get("POOL_MIN_SOL", "0") or 0)

    if a.to:
        to = Pubkey.from_string(a.to)
    elif env.get("SOLANA_PRIVATE_KEY"):
        to = keypair_from_secret(env["SOLANA_PRIVATE_KEY"]).pubkey()
    else:
        to = keypair_from_file(resolve(env.get("SOLANA_KEYPAIR_PATH", "../.keys/solana-deployer.json"))).pubkey()

    url = env.get("RPC_URL") or pool.get("SOLANA_RPC_URL") or "https://api.mainnet-beta.solana.com"
    lamports = int(round(a.sol * 1e9))
    if lamports <= 0:
        sys.exit("amount must be positive")

    print(f"== fund deployer {'[SEND]' if a.confirm else '[DRY RUN]'} ==")
    print(f"pool env  {pool_path}")
    print(f"rpc       {url.split('?')[0]}")
    from_bal = balance_sol(url, sender.pubkey())
    to_bal = balance_sol(url, to)
    print(f"from      {sender.pubkey()}  {from_bal:.4f} SOL")
    print(f"to        {to}  {to_bal:.4f} SOL")
    print(f"amount    {a.sol} SOL  (pool after: {from_bal - a.sol:.4f} SOL, floor POOL_MIN_SOL={floor})")
    if from_bal < a.sol + FEE_RESERVE_SOL:
        sys.exit("refusing: pool wallet cannot cover amount + fee")
    if from_bal - a.sol < floor:
        sys.exit(f"refusing: would drop the pool below its POOL_MIN_SOL floor of {floor} SOL")

    tx = build_tx(url, sender, to, lamports)
    if not a.confirm:
        sim = rpc(url, "simulateTransaction", [base64.b64encode(bytes(tx)).decode(),
                                               {"encoding": "base64", "sigVerify": True, "commitment": "confirmed"}])
        print(f"simulate  err={sim['value']['err']}  units={sim['value'].get('unitsConsumed')}")
        print(f"dry run only. To send:  python3 fund.py --sol {a.sol} --confirm")
        return

    sig = send_and_confirm(url, tx)
    print(f"confirmed https://solscan.io/tx/{sig}")
    print(f"to        {to}  {balance_sol(url, to):.4f} SOL")
    print(f"pool      {sender.pubkey()}  {balance_sol(url, sender.pubkey()):.4f} SOL")


if __name__ == "__main__":
    main()
