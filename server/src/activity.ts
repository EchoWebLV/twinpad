import { Connection, PublicKey } from "@solana/web3.js";
import { parseAbiItem, type Address, type PublicClient } from "viem";
import { pda, mintTokenProgram, readBondingCurve } from "./solana/pump.js";
import { erc20Abi } from "./evm/pons.js";
import type { Activity } from "./exit.js";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export interface ActivityInput {
  pumpMint: string; ponsToken: string; ponsCurve: string;
  /** Our own wallets on each chain: never counted as outside. */
  ours: { solana: string[]; evm: string[] };
  /** Block the Pons token was launched in (Transfer logs are read from here). */
  ponsFromBlock: bigint;
  price: { pump: number; pons: number }; // USD per token
}

/**
 * Outside interest in a coin: holders that are not us and not a venue, and the USD value they hold now.
 * pump.fun: the 20 largest token accounts minus the curve / PumpSwap pool / our creator ATA.
 * Pons: every Transfer recipient since launch minus us / curve / pool manager, then balanceOf each.
 * Throws when either chain cannot be read: the caller treats that as "unknown", never as zero.
 */
export async function measureActivity(conn: Connection, pub: PublicClient, i: ActivityInput): Promise<Activity & { pump: Activity; pons: Activity }> {
  const [pump, pons] = await Promise.all([pumpActivity(conn, i), ponsActivity(pub, i)]);
  return { outsideBuyers: pump.outsideBuyers + pons.outsideBuyers, outsideUsd: pump.outsideUsd + pons.outsideUsd, pump, pons };
}

async function pumpActivity(conn: Connection, i: ActivityInput): Promise<Activity> {
  const mint = new PublicKey(i.pumpMint);
  const prog = await mintTokenProgram(conn, mint);
  const curve = pda.bondingCurve(mint);
  const excluded = new Set<string>([
    pda.ata(curve, mint, prog).toBase58(),
    pda.ata(pda.pumpSwapPool(mint), mint, prog).toBase58(),
    ...i.ours.solana.map((o) => pda.ata(new PublicKey(o), mint, prog).toBase58()),
  ]);
  const bc = await readBondingCurve(conn, mint);
  if (!bc) throw new Error("pump: bonding curve not found");
  const largest = await conn.getTokenLargestAccounts(mint, "confirmed");
  let buyers = 0, tokens = 0;
  for (const a of largest.value) {
    if (excluded.has(a.address.toBase58())) continue;
    const n = Number(a.uiAmountString ?? 0);
    if (n <= 0) continue;
    buyers++;
    tokens += n;
  }
  return { outsideBuyers: buyers, outsideUsd: tokens * i.price.pump };
}

async function ponsActivity(pub: PublicClient, i: ActivityInput): Promise<Activity> {
  const token = i.ponsToken as Address;
  const ours = new Set([...i.ours.evm, i.ponsCurve, token].map((a) => a.toLowerCase()));
  const logs = await pub.getLogs({ address: token, event: TRANSFER, fromBlock: i.ponsFromBlock, toBlock: "latest" });
  const holders = new Set<string>();
  for (const l of logs) {
    const to = (l.args.to ?? "").toLowerCase();
    if (to && to !== "0x0000000000000000000000000000000000000000" && !ours.has(to)) holders.add(to);
  }
  let buyers = 0, tokens = 0;
  const list = [...holders].slice(0, 200);
  const balances = await Promise.all(list.map((h) => pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [h as Address] })));
  for (const b of balances) {
    if (b === 0n) continue;
    buyers++;
    tokens += Number(b) / 1e18;
  }
  return { outsideBuyers: buyers, outsideUsd: tokens * i.price.pons };
}
