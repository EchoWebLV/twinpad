import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Commitment,
} from "@solana/web3.js";
import bs58 from "bs58";
import { createHash } from "node:crypto";

// Verified program ids (see DUO-LAUNCH-SPEC.md §3.5, §4.2)
export const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMP_AMM_PROGRAM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
export const PUMP_FEES_PROGRAM = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
export const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");

export const PUMPPORTAL_TRADE_LOCAL = "https://pumpportal.fun/api/trade-local";
export const PUMP_COIN_API = "https://frontend-api-v3.pump.fun/coins/";

/** pump.fun sells 793.1M of the 1B supply on the curve; the rest seeds the AMM. */
export const CURVE_INITIAL_REAL_TOKENS = 793_100_000n * 1_000_000n;
export const TOTAL_SUPPLY_TOKENS = 1_000_000_000;

export const pda = {
  global: () => PublicKey.findProgramAddressSync([Buffer.from("global")], PUMP_PROGRAM)[0],
  bondingCurve: (mint: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM)[0],
  pumpEventAuthority: () =>
    PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_PROGRAM)[0],
  ammEventAuthority: () =>
    PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_AMM_PROGRAM)[0],
  feesEventAuthority: () =>
    PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_FEES_PROGRAM)[0],
  sharingConfig: (mint: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("sharing-config"), mint.toBuffer()], PUMP_FEES_PROGRAM)[0],
  pumpCreatorVault: (creator: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creator.toBuffer()], PUMP_PROGRAM)[0],
  ammCreatorVaultAuthority: (creator: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("creator_vault"), creator.toBuffer()], PUMP_AMM_PROGRAM)[0],
  poolAuthority: (mint: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("pool-authority"), mint.toBuffer()], PUMP_PROGRAM)[0],
  /** Canonical PumpSwap pool for a graduated pump.fun coin (index 0, creator = pump pool-authority). Verified against TWINE. */
  pumpSwapPool: (mint: PublicKey) => {
    const idx = Buffer.alloc(2);
    idx.writeUInt16LE(0);
    return PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), idx, pda.poolAuthority(mint).toBuffer(), mint.toBuffer(), WSOL.toBuffer()],
      PUMP_AMM_PROGRAM,
    )[0];
  },
  ata: (owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM) =>
    PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0],
};

export function keypairFromBase58(secret: string): Keypair {
  return Keypair.fromSecretKey(bs58.decode(secret.trim()));
}

export function connection(rpcUrl: string, commitment: Commitment = "confirmed") {
  return new Connection(rpcUrl, commitment);
}

export interface BondingCurveState {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  realQuoteReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: PublicKey;
  /** SOL per token */
  price: number;
  /** price × 1e9 tokens, in SOL */
  fdvSol: number;
  /** 0..1 */
  progress: number;
  /** real SOL sitting in the curve */
  quoteDepthSol: number;
}

/** Parse the pump `BondingCurve` account (IDL layout, discriminator 17b7f83760d8ac60). */
export function parseBondingCurve(data: Buffer): BondingCurveState {
  if (data.length < 8 + 8 * 5 + 1 + 32) throw new Error("bonding curve account too short");
  const u64 = (o: number) => data.readBigUInt64LE(o);
  const virtualTokenReserves = u64(8);
  const virtualQuoteReserves = u64(16);
  const realTokenReserves = u64(24);
  const realQuoteReserves = u64(32);
  const tokenTotalSupply = u64(40);
  const complete = data[48] === 1;
  const creator = new PublicKey(data.subarray(49, 81));
  const price = Number(virtualQuoteReserves) / 1e9 / (Number(virtualTokenReserves) / 1e6);
  const progress = Math.min(1, Math.max(0, 1 - Number(realTokenReserves) / Number(CURVE_INITIAL_REAL_TOKENS)));
  return {
    virtualTokenReserves,
    virtualQuoteReserves,
    realTokenReserves,
    realQuoteReserves,
    tokenTotalSupply,
    complete,
    creator,
    price,
    fdvSol: price * TOTAL_SUPPLY_TOKENS,
    progress,
    quoteDepthSol: Number(realQuoteReserves) / 1e9,
  };
}

export async function readBondingCurve(conn: Connection, mint: PublicKey): Promise<BondingCurveState | null> {
  const info = await conn.getAccountInfo(pda.bondingCurve(mint), "processed");
  if (!info) return null;
  return parseBondingCurve(info.data);
}

/** Which token program the mint uses (pump.fun coins created via create_v2 are Token-2022, like TWINE). */
export async function mintTokenProgram(conn: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await conn.getAccountInfo(mint);
  if (!info) throw new Error(`mint ${mint.toBase58()} not found`);
  return info.owner;
}

export interface TradeLocalBody {
  publicKey: string;
  action: "create" | "buy" | "sell";
  mint: string;
  denominatedInSol: "true" | "false";
  amount: number | string; // SOL when denominatedInSol=true, tokens otherwise; "100%" allowed for sells
  slippage: number;
  priorityFee: number;
  pool: "pump" | "pump-amm" | "auto";
  tokenMetadata?: { name: string; symbol: string; uri: string };
}

/** Ask PumpPortal for an unsigned transaction. Free; nothing happens until it is signed and sent. */
export async function tradeLocal(body: TradeLocalBody): Promise<VersionedTransaction> {
  const res = await fetch(PUMPPORTAL_TRADE_LOCAL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) {
    const text = await res.text().catch(() => "");
    throw new Error(`PumpPortal trade-local ${res.status}: ${text.slice(0, 300)}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return VersionedTransaction.deserialize(bytes);
}

/** Several unsigned transactions for one Jito bundle (up to 5). The first body's priorityFee becomes the bundle tip. */
export async function tradeLocalBundle(bodies: TradeLocalBody[]): Promise<VersionedTransaction[]> {
  const res = await fetch(PUMPPORTAL_TRADE_LOCAL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bodies),
  });
  if (res.status !== 200) {
    const text = await res.text().catch(() => "");
    throw new Error(`PumpPortal trade-local bundle ${res.status}: ${text.slice(0, 300)}`);
  }
  const encoded = (await res.json()) as string[];
  if (!Array.isArray(encoded) || encoded.length !== bodies.length) throw new Error(`PumpPortal returned ${encoded?.length} transactions for ${bodies.length}`);
  return encoded.map((t) => VersionedTransaction.deserialize(bs58.decode(t)));
}

/** Submit signed transactions as one atomic Jito bundle. Returns the bundle id; landing is checked by signature. */
export async function sendBundle(blockEngine: string, txs: VersionedTransaction[]): Promise<string> {
  const res = await fetch(blockEngine, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendBundle", params: [txs.map((t) => bs58.encode(t.serialize()))] }),
  });
  const j = (await res.json().catch(() => null)) as { result?: string; error?: { message?: string } } | null;
  if (!res.ok || !j?.result) throw new Error(`jito sendBundle ${res.status}: ${j?.error?.message ?? "no result"}`);
  return j.result;
}

/** Poll until `sig` is confirmed (or the wait runs out). Returns true when it landed. */
export async function waitForSignature(conn: Connection, sig: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const st = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const v = st.value[0];
    if (v?.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(v.err)}`);
    if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

export function signatureOf(tx: VersionedTransaction): string {
  return bs58.encode(tx.signatures[0]);
}

export async function sendSigned(conn: Connection, tx: VersionedTransaction): Promise<string> {
  const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  const latest = await conn.getLatestBlockhash("confirmed");
  await conn.confirmTransaction({ signature: sig, ...latest }, "confirmed");
  return sig;
}

/** Ground-truth check that a coin exists: on-chain signatures for the mint plus pump.fun's own API. */
export async function coinExists(conn: Connection, mint: PublicKey) {
  const sigs = await conn.getSignaturesForAddress(mint, { limit: 1 });
  let api: unknown = null;
  let apiStatus = 0;
  try {
    const r = await fetch(PUMP_COIN_API + mint.toBase58(), { headers: { accept: "application/json" } });
    apiStatus = r.status;
    if (r.ok) api = await r.json();
  } catch {
    /* network */
  }
  return { onChain: sigs.length > 0, apiStatus, api };
}

/**
 * pump.fun `collect_creator_fee`: moves the creator vault (creator-fee share of every trade on our coins) to the creator wallet.
 * Simulated first; returns null when the vault is empty or the simulation fails, so a close never stops on it.
 */
export async function collectCreatorFee(conn: Connection, creator: Keypair): Promise<{ sig: string; sol: number } | null> {
  const vault = pda.pumpCreatorVault(creator.publicKey);
  const bal = await conn.getBalance(vault, "confirmed");
  const rentExempt = await conn.getMinimumBalanceForRentExemption(0);
  if (bal <= rentExempt) return null;
  const disc = createHash("sha256").update("global:collect_creator_fee").digest().subarray(0, 8);
  const ix = new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: [
      { pubkey: creator.publicKey, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: pda.pumpEventAuthority(), isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(disc),
  });
  const latest = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: creator.publicKey, recentBlockhash: latest.blockhash, instructions: [ix] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([creator]);
  const sim = await conn.simulateTransaction(tx, { commitment: "confirmed" });
  if (sim.value.err) {
    console.error(`[pump] collect_creator_fee simulation failed: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-3).join(" | ")}`);
    return null;
  }
  const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  await conn.confirmTransaction({ signature: sig, ...latest }, "confirmed");
  return { sig, sol: (bal - rentExempt) / 1e9 };
}
