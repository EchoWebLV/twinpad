#!/usr/bin/env python3
"""Lockstep (LSTP) — pump.fun launch for the Twinpad OFT twin proof of concept.

Modes
  python3 launch.py                 dry run (default): checks everything, sends nothing
  python3 launch.py --upload-only   pin image + metadata to IPFS through pump.fun, verify it resolves
  python3 launch.py --confirm       upload if needed, build, sign and send the create + dev-buy tx

Flow is decided by .env (same folder):
  SOLANA_PRIVATE_KEY or SOLANA_KEYPAIR_PATH present -> PumpPortal trade-local + RPC_URL, signed locally
  only PUMPPORTAL_API_KEY present                    -> PumpPortal Lightning /api/trade?api-key=...
The mint keypair is pre-generated (MINT_KEYPAIR_PATH), so the CA is known before launch.
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
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.transaction import VersionedTransaction

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
IMAGE = HERE / "lockstep.png"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) twinpad-lockstep-launch/1.0"

TOKEN = {
    "name": "Lockstep",
    "symbol": "LSTP",
    "description": (
        "One supply, two chains. Lockstep lives on Solana and Robinhood Chain through a "
        "LayerZero bridge, so the two prices stay in lockstep by arbitrage, not by a bot. "
        "Twinpad proof of concept."
    ),
    "website": "https://twinpad.one",
    "twitter": "",
    "telegram": "",
}

PUMP_IPFS = "https://pump.fun/api/ipfs"
PORTAL_LOCAL = "https://pumpportal.fun/api/trade-local"
PORTAL_LIGHTNING = "https://pumpportal.fun/api/trade"
PUMP_COIN_API = "https://frontend-api-v3.pump.fun/coins/"


def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def resolve(p: str) -> Path:
    q = Path(p).expanduser()
    return q if q.is_absolute() else (HERE / q).resolve()


def keypair_from_file(path: Path) -> Keypair:
    return Keypair.from_bytes(bytes(json.loads(path.read_text())))


def creator_keypair(env: dict[str, str]) -> Keypair | None:
    raw = env.get("SOLANA_PRIVATE_KEY", "").strip()
    if raw:
        if raw.startswith("["):
            return Keypair.from_bytes(bytes(json.loads(raw)))
        return Keypair.from_base58_string(raw)
    p = resolve(env.get("SOLANA_KEYPAIR_PATH", "../.keys/solana-deployer.json"))
    return keypair_from_file(p) if p.exists() else None


def rpc(url: str, method: str, params: list) -> object:
    r = requests.post(url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
                      headers={"User-Agent": UA}, timeout=40)
    r.raise_for_status()
    j = r.json()
    if "error" in j:
        raise RuntimeError(f"{method}: {j['error']}")
    return j["result"]


GATEWAYS = ("https://pump.mypinata.cloud/ipfs/", "https://ipfs.io/ipfs/", "https://dweb.link/ipfs/",
            "https://gateway.pinata.cloud/ipfs/", "https://w3s.link/ipfs/")


def ipfs_urls(url: str) -> list[str]:
    """Same CID through several public gateways; gateways rate-limit and 403 scripts at random."""
    if "/ipfs/" not in url:
        return [url]
    cid = url.split("/ipfs/", 1)[1]
    return [url] + [g + cid for g in GATEWAYS if not url.startswith(g)]


def get_bytes(url: str, tries: int = 3) -> bytes:
    last: Exception | None = None
    for i in range(tries):
        for u in ipfs_urls(url):
            try:
                g = requests.get(u, headers={"User-Agent": UA}, timeout=60)
                if g.status_code == 200:
                    return g.content
                last = RuntimeError(f"GET {u} -> {g.status_code}")
            except Exception as e:  # noqa: BLE001
                last = e
        time.sleep(3 * (i + 1))
    raise RuntimeError(f"could not fetch {url} from any gateway: {last}")


def get_json(url: str) -> dict:
    return json.loads(get_bytes(url))


def saved_metadata() -> dict | None:
    p = OUT / "metadata.json"
    return json.loads(p.read_text()) if p.exists() else None


def upload_metadata() -> dict:
    if not IMAGE.exists():
        sys.exit(f"missing {IMAGE}; run: python3 make_image.py")
    with IMAGE.open("rb") as f:
        r = requests.post(
            PUMP_IPFS,
            data={
                "name": TOKEN["name"], "symbol": TOKEN["symbol"], "description": TOKEN["description"],
                "twitter": TOKEN["twitter"], "telegram": TOKEN["telegram"], "website": TOKEN["website"],
                "showName": "true",
            },
            files={"file": ("lockstep.png", f, "image/png")},
            headers={"User-Agent": UA}, timeout=120,
        )
    if r.status_code != 200:
        raise RuntimeError(f"pump.fun ipfs upload {r.status_code}: {r.text[:300]}")
    j = r.json()
    uri = j["metadataUri"]
    meta = get_json(uri)
    if meta.get("name") != TOKEN["name"] or meta.get("symbol") != TOKEN["symbol"]:
        raise RuntimeError(f"metadata mismatch at {uri}: {meta}")
    img = get_bytes(meta["image"])
    rec = {"metadataUri": uri, "metadata": meta, "imageBytes": len(img), "uploadedAt": int(time.time())}
    OUT.mkdir(exist_ok=True)
    (OUT / "metadata.json").write_text(json.dumps(rec, indent=2))
    return rec


def mint_exists(rpc_url: str, mint: Pubkey) -> bool:
    res = rpc(rpc_url, "getAccountInfo", [str(mint), {"encoding": "base64"}])
    return bool(res and res.get("value"))


def build_local_tx(creator: Pubkey, mint: Pubkey, uri: str, dev_buy_sol: float, slippage: int, prio: float) -> bytes:
    body = {
        "publicKey": str(creator),
        "action": "create",
        "tokenMetadata": {"name": TOKEN["name"], "symbol": TOKEN["symbol"], "uri": uri},
        "mint": str(mint),
        "denominatedInSol": "true",
        "amount": dev_buy_sol,
        "slippage": slippage,
        "priorityFee": prio,
        "pool": "pump",
    }
    r = requests.post(PORTAL_LOCAL, json=body, headers={"User-Agent": UA}, timeout=60)
    if r.status_code != 200:
        raise RuntimeError(f"trade-local {r.status_code}: {r.text[:300]}")
    return r.content


def send_and_confirm(rpc_url: str, signed: VersionedTransaction) -> str:
    sig = rpc(rpc_url, "sendTransaction", [base64.b64encode(bytes(signed)).decode(),
                                           {"encoding": "base64", "skipPreflight": False, "maxRetries": 3}])
    for _ in range(40):
        st = rpc(rpc_url, "getSignatureStatuses", [[sig], {"searchTransactionHistory": True}])
        v = (st or {}).get("value", [None])[0]
        if v:
            if v.get("err"):
                raise RuntimeError(f"tx {sig} failed: {v['err']}")
            if v.get("confirmationStatus") in ("confirmed", "finalized"):
                return sig
        time.sleep(2)
    raise RuntimeError(f"tx {sig} not confirmed in time; check an explorer")


def verify_live(rpc_url: str, mint: Pubkey) -> None:
    sigs = rpc(rpc_url, "getSignaturesForAddress", [str(mint), {"limit": 5}])
    print(f"on-chain signatures for mint: {len(sigs)}")
    for i in range(10):
        g = requests.get(PUMP_COIN_API + str(mint), headers={"User-Agent": UA}, timeout=30)
        if g.status_code == 200:
            c = g.json()
            print(f"pump.fun sees it: {c.get('name')} ({c.get('symbol')}) creator={c.get('creator')}")
            return
        time.sleep(3)
    print("pump.fun API has not indexed the coin yet; the chain has (see signatures above)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--upload-only", action="store_true")
    ap.add_argument("--confirm", action="store_true")
    a = ap.parse_args()

    env = load_env(HERE / ".env")
    rpc_url = env.get("RPC_URL", "https://api.mainnet-beta.solana.com")
    dev_buy = float(env.get("DEV_BUY_SOL", "0.05"))
    slippage = int(env.get("SLIPPAGE", "10"))
    prio = float(env.get("PRIORITY_FEE", "0.0005"))
    api_key = env.get("PUMPPORTAL_API_KEY", "").strip()

    mint_path = resolve(env.get("MINT_KEYPAIR_PATH", "../.keys/pumpfun-mint.json"))
    if not mint_path.exists():
        sys.exit(f"missing mint keypair {mint_path}")
    mint_kp = keypair_from_file(mint_path)
    creator = creator_keypair(env)
    flow = "trade-local (sign locally)" if creator else ("lightning (api key)" if api_key else None)
    if flow is None:
        sys.exit("no signer: set SOLANA_KEYPAIR_PATH / SOLANA_PRIVATE_KEY, or PUMPPORTAL_API_KEY, in .env")

    mode = "CONFIRM" if a.confirm else ("UPLOAD-ONLY" if a.upload_only else "DRY RUN")
    print(f"== Lockstep launch [{mode}] ==")
    print(f"token     {TOKEN['name']} / {TOKEN['symbol']}")
    print(f"CA (mint) {mint_kp.pubkey()}")
    print(f"flow      {flow}")
    print(f"rpc       {rpc_url.split('?')[0]}")
    if creator:
        print(f"creator   {creator.pubkey()}")
        try:
            lam = rpc(rpc_url, "getBalance", [str(creator.pubkey())])["value"]
            print(f"balance   {lam / 1e9:.4f} SOL  (need dev buy {dev_buy} SOL + ~0.03 SOL fees/rent)")
        except Exception as e:  # noqa: BLE001
            print(f"balance   unknown ({e})")
    try:
        exists = mint_exists(rpc_url, mint_kp.pubkey())
        print(f"mint on-chain already: {exists}")
        if exists and a.confirm:
            sys.exit("refusing: mint account already exists on-chain")
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        print(f"mint check failed: {e}")

    meta = saved_metadata()
    if a.upload_only or (a.confirm and not meta):
        meta = upload_metadata()
        print(f"metadata  pinned + verified: {meta['metadataUri']} (image {meta['imageBytes']} bytes)")
    elif meta:
        print(f"metadata  already pinned: {meta['metadataUri']}")
    else:
        print("metadata  not pinned yet (run --upload-only)")
    if a.upload_only:
        return

    print(f"dev buy   {dev_buy} SOL, slippage {slippage}%, priority fee {prio} SOL")
    if not a.confirm:
        print("dry run only. To launch:  python3 launch.py --confirm")
        return

    uri = meta["metadataUri"]
    if creator:
        raw = build_local_tx(creator.pubkey(), mint_kp.pubkey(), uri, dev_buy, slippage, prio)
        tx = VersionedTransaction.from_bytes(raw)
        signed = VersionedTransaction(tx.message, [mint_kp, creator])
        sig = send_and_confirm(rpc_url, signed)
    else:
        body = {
            "action": "create",
            "tokenMetadata": {"name": TOKEN["name"], "symbol": TOKEN["symbol"], "uri": uri},
            "mint": str(mint_kp),  # Lightning wants the base58 mint SECRET key
            "denominatedInSol": "true", "amount": dev_buy, "slippage": slippage,
            "priorityFee": prio, "pool": "pump",
        }
        r = requests.post(f"{PORTAL_LIGHTNING}?api-key={api_key}", json=body, headers={"User-Agent": UA}, timeout=60)
        if r.status_code != 200:
            raise RuntimeError(f"lightning {r.status_code}: {r.text[:300]}")
        sig = r.json().get("signature")
        print("lightning accepted; waiting for confirmation")
        time.sleep(8)
    print(f"tx        https://solscan.io/tx/{sig}")
    print(f"coin      https://pump.fun/coin/{mint_kp.pubkey()}")
    (OUT / "launch.json").write_text(json.dumps({"mint": str(mint_kp.pubkey()), "signature": sig,
                                                 "metadataUri": uri, "launchedAt": int(time.time())}, indent=2))
    verify_live(rpc_url, mint_kp.pubkey())


if __name__ == "__main__":
    main()
