/**
 * Read both sides of any pair without a launch record — used to test the price
 * readers against live coins (TWINE by default).
 *   npm run prices -- [pumpMint] [ponsToken]
 */
import { PublicKey } from "@solana/web3.js";
import { getAddress, type Address } from "viem";
import { config } from "./config.js";
import { fx } from "./fx.js";
import { connection } from "./solana/pump.js";
import { publicClient } from "./evm/pons.js";
import { pumpSide, ponsSide } from "./prices.js";

const mint = new PublicKey(process.argv[2] ?? "CNWxmoBSQZo2Sgp5KSAK5m9FwSqDbXQRP4CNMuoe78Gm");
const token = getAddress(process.argv[3] ?? "0xe27501d787d647CC82a5B4a7Eafd5750386F1B77") as Address;

const f = await fx();
const [p, q] = await Promise.all([
  pumpSide(connection(config.solana.rpcUrl), mint, f.SOL),
  ponsSide(publicClient(config.evm.rpcUrl), token, f.ETH),
]);
const hi = Math.max(p.fdv, q.fdv);
const lo = Math.min(p.fdv, q.fdv);
console.log(JSON.stringify({ fx: f, pump: p, pons: q, gap: (hi - lo) / lo, expensive: p.fdv > q.fdv ? "pump" : "pons" }, null, 2));
