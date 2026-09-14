// Pay the deposit for the test launch from the sol_wallet in ../../.env.
// Dry run by default: prints what it would send. `--confirm` signs and sends.
// Usage: node pay.mjs [--confirm] [--id <launchId>] [--api http://localhost:8787]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const confirm = process.argv.includes("--confirm");
const api = arg("--api") ?? "http://localhost:8787";

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(here, "../../.env"), "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
const kp = Keypair.fromSecretKey(bs58.decode(env.sol_wallet));
const conn = new Connection(env.rpc_url, "confirmed");

const id = arg("--id") ?? JSON.parse(fs.readFileSync(path.join(here, "launch.json"), "utf8")).id;
const l = await fetch(`${api}/api/paid/${id}`).then((r) => r.json());
if (l.status !== "awaiting_deposit") { console.error(`launch ${id} is ${l.status}, not awaiting_deposit`); process.exit(1); }
if (l.devWallet !== kp.publicKey.toBase58()) { console.error(`launch expects deposit from ${l.devWallet}, but sol_wallet is ${kp.publicKey.toBase58()}`); process.exit(1); }
if (Date.now() > l.payment.deadlineAt) { console.error("deposit deadline passed"); process.exit(1); }

const lamports = Math.round(l.payment.requiredSol * LAMPORTS_PER_SOL);
const bal = await conn.getBalance(kp.publicKey);
console.log(JSON.stringify({ launch: id, from: kp.publicKey.toBase58(), to: l.payment.address, sol: l.payment.requiredSol, balanceSol: bal / LAMPORTS_PER_SOL, minutesLeft: Math.floor((l.payment.deadlineAt - Date.now()) / 60000), mode: confirm ? "SEND" : "dry-run" }, null, 2));
if (!confirm) { console.log("dry run only. re-run with --confirm to send."); process.exit(0); }
if (bal < lamports + 10_000) { console.error("insufficient balance"); process.exit(1); }

const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(l.payment.address), lamports }));
const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: "confirmed" });
console.log(`sent ${l.payment.requiredSol} SOL · https://solscan.io/tx/${sig}`);
console.log(`watch: http://localhost:3000/launch/${id}`);
