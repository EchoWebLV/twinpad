import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex, PublicClient } from "viem";
import { keypairFromBase58 } from "./solana/pump.js";
import { BUY_FEE_RATE } from "./quote.js";

/** Lock/buyer wallet extras on top of the buy: rent + fees on Solana, gas on Robinhood. */
export const LOCK_SOL_EXTRA = 0.01;
export const LOCK_ETH_EXTRA = 0.001;

/**
 * Operator bundle from the operator's own wallets: the dev wallet (one Solana secret key + one Robinhood private key)
 * holds the locked allocation, and each buyer wallet places its own buy in the opening bundle. Every wallet pays for
 * its own buys; the pool only fronts the maker, the creator and the launcher. Keys are parsed here, held in memory for
 * the funding check, and written to the per-coin keys.json (0600) by createOperatorLaunch. Nothing here logs a key.
 */
export interface BundleBuyerKeys { sol: Keypair | null; evm: Hex | null; buySol: number; buyEth: number }
export interface BundleWallets {
  dev: { sol: Keypair; evm: Hex };
  buyers: BundleBuyerKeys[];
}

export const BUNDLE_LIMITS = { maxBuyers: 12, buySolMax: 100, buyEthMax: 5 };
/** pump.fun/Jito: five transactions a bundle; create + dev + maker leave room for two buyers in the first one. */
export const JITO_BUNDLE_MAX = 5;

function parseSolKey(s: string, who: string): Keypair {
  try {
    return keypairFromBase58(s.trim());
  } catch {
    throw new Error(`${who}: Solana key must be a base58 secret key`);
  }
}

function parseEvmKey(s: string, who: string): Hex {
  const v = s.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${who}: Robinhood key must be a 0x-prefixed 32-byte private key`);
  privateKeyToAccount(v as Hex);
  return v.toLowerCase() as Hex;
}

const NONE = new Set(["", "-", "none", "x"]);

/**
 * Buyers come as text, one wallet a line: `<solana secret key | -> <robinhood private key | -> <buy SOL> <buy ETH>`,
 * separated by spaces or commas. A wallet with no key on a chain does not buy there.
 */
export function parseBuyers(text: string): BundleBuyerKeys[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (lines.length > BUNDLE_LIMITS.maxBuyers) throw new Error(`max ${BUNDLE_LIMITS.maxBuyers} buyer wallets`);
  return lines.map((line, n) => {
    const who = `buyer ${n + 1}`;
    const parts = line.split(/[\s,]+/).filter(Boolean);
    if (parts.length !== 4) throw new Error(`${who}: expected "<solana key or -> <robinhood key or -> <buy SOL> <buy ETH>"`);
    const [solRaw, evmRaw, solAmt, ethAmt] = parts;
    const sol = NONE.has(solRaw.toLowerCase()) ? null : parseSolKey(solRaw, who);
    const evm = NONE.has(evmRaw.toLowerCase()) ? null : parseEvmKey(evmRaw, who);
    const buySol = amount(solAmt, `${who} buy SOL`, BUNDLE_LIMITS.buySolMax);
    const buyEth = amount(ethAmt, `${who} buy ETH`, BUNDLE_LIMITS.buyEthMax);
    if (!sol && !evm) throw new Error(`${who}: needs a key on at least one chain`);
    if (buySol > 0 && !sol) throw new Error(`${who}: buys SOL but has no Solana key`);
    if (buyEth > 0 && !evm) throw new Error(`${who}: buys ETH but has no Robinhood key`);
    if (buySol <= 0 && buyEth <= 0) throw new Error(`${who}: buys nothing`);
    return { sol, evm, buySol, buyEth };
  });
}

function amount(s: string, what: string, max: number) {
  const v = NONE.has(s.toLowerCase()) ? 0 : Number(s);
  if (!Number.isFinite(v) || v < 0) throw new Error(`${what} must be a number ≥ 0`);
  if (v > max) throw new Error(`${what} max ${max}`);
  return Math.round(v * 1e6) / 1e6;
}

/** `wallets` on the launch body: `{ dev: { sol, evm }, buyers: "<lines>" }`; null/absent = the pool funds generated lock wallets. */
export function parseBundleWallets(raw: unknown): BundleWallets | null {
  if (raw == null || raw === "") return null;
  const w = raw as { dev?: { sol?: unknown; evm?: unknown }; buyers?: unknown };
  const devSol = typeof w.dev?.sol === "string" ? w.dev.sol : "";
  const devEvm = typeof w.dev?.evm === "string" ? w.dev.evm : "";
  if (!devSol.trim() && !devEvm.trim() && !(typeof w.buyers === "string" && w.buyers.trim())) return null;
  if (!devSol.trim()) throw new Error("dev wallet: Solana secret key missing");
  if (!devEvm.trim()) throw new Error("dev wallet: Robinhood private key missing");
  const dev = { sol: parseSolKey(devSol, "dev wallet"), evm: parseEvmKey(devEvm, "dev wallet") };
  const buyers = typeof w.buyers === "string" ? parseBuyers(w.buyers) : [];
  const devSolAddr = dev.sol.publicKey.toBase58();
  const devEvmAddr = privateKeyToAccount(dev.evm).address.toLowerCase();
  const seenSol = new Set([devSolAddr]);
  const seenEvm = new Set([devEvmAddr]);
  buyers.forEach((b, n) => {
    const s = b.sol?.publicKey.toBase58();
    const e = b.evm ? privateKeyToAccount(b.evm).address.toLowerCase() : null;
    if (s && seenSol.has(s)) throw new Error(`buyer ${n + 1}: Solana wallet repeats another wallet`);
    if (e && seenEvm.has(e)) throw new Error(`buyer ${n + 1}: Robinhood wallet repeats another wallet`);
    if (s) seenSol.add(s);
    if (e) seenEvm.add(e);
  });
  return { dev, buyers };
}

/** Public shape of the pasted wallets: addresses and amounts only. */
export function bundleAddresses(w: BundleWallets) {
  return {
    dev: { sol: w.dev.sol.publicKey.toBase58(), evm: privateKeyToAccount(w.dev.evm).address },
    buyers: w.buyers.map((b) => ({
      sol: b.sol ? b.sol.publicKey.toBase58() : null,
      evm: b.evm ? privateKeyToAccount(b.evm).address : null,
      buySol: b.buySol, buyEth: b.buyEth, txSol: null as string | null, txEth: null as string | null,
    })),
  };
}

/** What a wallet must hold to place its buy: pump.fun gross + PumpPortal fee + rent/fees; Pons gross + gas. */
export function buyerNeedSol(buySol: number) {
  return buySol > 0 ? r6(buySol * (1 + BUY_FEE_RATE) + LOCK_SOL_EXTRA) : 0;
}
export function buyerNeedEth(buyEth: number) {
  return buyEth > 0 ? r6(buyEth + LOCK_ETH_EXTRA) : 0;
}

export interface WalletCheck { address: string; balance: number; need: number; ok: boolean }
export interface BundleCheckRow { label: string; sol: WalletCheck | null; evm: WalletCheck | null }
export interface BundleCheck { ok: boolean; rows: BundleCheckRow[]; short: string[] }

/**
 * Live balances against what each pasted wallet has to hold. The dev wallet needs the lock funding from the shape;
 * every buyer needs its own buys plus the margin. Read-only: nothing moves.
 */
export async function checkBundleFunding(
  conn: Pick<Connection, "getBalance">, pub: Pick<PublicClient, "getBalance">,
  w: BundleWallets, need: { devSol: number; devEth: number },
): Promise<BundleCheck> {
  const a = bundleAddresses(w);
  const solBal = async (addr: string) => (await conn.getBalance(new PublicKey(addr), "processed")) / 1e9;
  const ethBal = async (addr: string) => Number(await pub.getBalance({ address: addr as Address })) / 1e18;
  const mk = async (addr: string | null, need: number, chain: "sol" | "evm"): Promise<WalletCheck | null> => {
    if (!addr) return null;
    const balance = r6(chain === "sol" ? await solBal(addr) : await ethBal(addr));
    return { address: addr, balance, need, ok: need <= 0 || balance >= need };
  };
  const rows: BundleCheckRow[] = [
    { label: "dev", sol: await mk(a.dev.sol, need.devSol, "sol"), evm: await mk(a.dev.evm, need.devEth, "evm") },
    ...(await Promise.all(a.buyers.map(async (b, n) => ({
      label: `buyer ${n + 1}`,
      sol: await mk(b.sol, buyerNeedSol(b.buySol), "sol"),
      evm: await mk(b.evm, buyerNeedEth(b.buyEth), "evm"),
    })))),
  ];
  const short: string[] = [];
  for (const row of rows) {
    if (row.sol && !row.sol.ok) short.push(`${row.label} holds ${row.sol.balance} SOL, needs ${row.sol.need}`);
    if (row.evm && !row.evm.ok) short.push(`${row.label} holds ${row.evm.balance} ETH, needs ${row.evm.need}`);
  }
  return { ok: short.length === 0, rows, short };
}

function r6(n: number) {
  return Math.round(n * 1e6) / 1e6;
}
