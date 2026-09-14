// Submit the test launch to the local pad API. Spends nothing: pins image + metadata to IPFS,
// generates the per-coin keys, and returns the launch id, pump.fun CA and payment address.
// Usage: node create.mjs [--api http://localhost:8787]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const api = process.argv.includes("--api") ? process.argv[process.argv.indexOf("--api") + 1] : "http://localhost:8787";

const token = {
  name: "Test Twin",
  symbol: "TTWIN",
  description: "Twinpad production test. One deposit, live on pump.fun and Pons (Robinhood Chain) at the same FDV, held inside a 5% band by the pad's market maker.",
  boostSol: Number(process.env.BOOST_SOL ?? 0),
  twitter: "",
  website: "",
  telegram: "",
};

const pool = await fetch(`${api}/api/pool`).then((r) => r.json());
const devWallet = process.env.DEV_WALLET || pool.solana.address; // pays the deposit; defaults to the pool wallet
const png = fs.readFileSync(path.join(here, "image.png"));
const body = { ...token, devWallet, imageDataUrl: `data:image/png;base64,${png.toString("base64")}` };

const r = await fetch(`${api}/api/paid`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const j = await r.json();
if (!r.ok) { console.error("create failed:", j); process.exit(1); }
fs.writeFileSync(path.join(here, "launch.json"), JSON.stringify(j, null, 2));
console.log(JSON.stringify({
  id: j.id, status: j.status,
  pumpMint: j.wallets.pumpMint,
  payTo: j.payment.address, requiredSol: j.payment.required, from: j.devWallet,
  deadline: new Date(j.payment.deadlineAt).toISOString(),
  imageCid: j.token.imageCid, metadataUri: j.token.metadataUri,
  boostSol: j.boostSol, page: `${process.env.WEB_URL ?? "http://localhost:3000"}/launch/${j.id}`,
}, null, 2));
