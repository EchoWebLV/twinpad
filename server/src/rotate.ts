import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { ATA_PROGRAM, SYSTEM_PROGRAM, mintTokenProgram, pda } from "./solana/pump.js";
import { step, type LaunchRecord } from "./record.js";
import type { Registry } from "./registry.js";

/** SOL left on the creator wallet after a rotation: fee money for the creator-fee claim at close. */
export const CREATOR_KEEP_SOL = 0.01;
const TX_FEE_LAMPORTS = 10_000;

export interface RotatePlan {
  /** raw token amount (base units) on the creator's ATA */
  tokens: bigint;
  /** creator wallet lamports */
  lamports: number;
  /** rent the creator pays for the maker's ATA when it does not exist yet */
  ataRent: number;
}

/**
 * One transaction, signed by the creator: create the maker's ATA if needed, move every token, then move
 * the SOL above CREATOR_KEEP_SOL (minus the rent and fee this tx costs). Empty when nothing is worth moving.
 */
export function buildRotateTx(creator: PublicKey, maker: PublicKey, mint: PublicKey, tokenProgram: PublicKey, plan: RotatePlan): { tx: Transaction; sol: number } {
  const tx = new Transaction();
  if (plan.tokens > 0n) {
    const from = pda.ata(creator, mint, tokenProgram);
    const to = pda.ata(maker, mint, tokenProgram);
    if (plan.ataRent > 0) {
      tx.add(new TransactionInstruction({
        programId: ATA_PROGRAM,
        keys: [
          { pubkey: creator, isSigner: true, isWritable: true },
          { pubkey: to, isSigner: false, isWritable: true },
          { pubkey: maker, isSigner: false, isWritable: false },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
          { pubkey: tokenProgram, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([1]), // CreateIdempotent
      }));
    }
    const data = Buffer.alloc(9);
    data[0] = 3; // SPL Token: Transfer
    data.writeBigUInt64LE(plan.tokens, 1);
    tx.add(new TransactionInstruction({
      programId: tokenProgram,
      keys: [
        { pubkey: from, isSigner: false, isWritable: true },
        { pubkey: to, isSigner: false, isWritable: true },
        { pubkey: creator, isSigner: true, isWritable: false },
      ],
      data,
    }));
  }
  const lamports = plan.lamports - Math.round(CREATOR_KEEP_SOL * LAMPORTS_PER_SOL) - plan.ataRent - TX_FEE_LAMPORTS;
  const sol = lamports > 0 ? lamports / LAMPORTS_PER_SOL : 0;
  if (lamports > 0) tx.add(SystemProgram.transfer({ fromPubkey: creator, toPubkey: maker, lamports }));
  return { tx, sol };
}

/**
 * Move a live coin's Solana maker off its pump.fun creator wallet (launches from before the creator/maker split).
 * The new key is written to keys.json before anything moves, so a crash mid-way is finished by running it again:
 * the record still names the creator as maker until the transfer has confirmed. The caller parks the maker first.
 */
export async function rotateSolMaker(conn: Connection, registry: Registry, rec: LaunchRecord) {
  const keys = registry.keys(rec.id);
  const creator = Keypair.fromSecretKey(Uint8Array.from(keys.solCreator));
  let maker = keys.solMaker ? Keypair.fromSecretKey(Uint8Array.from(keys.solMaker)) : null;
  if (!maker || maker.publicKey.equals(creator.publicKey)) {
    maker = Keypair.generate();
    registry.saveKeys(rec.id, { ...keys, solMaker: Array.from(maker.secretKey) });
  }
  const mint = new PublicKey(rec.launch.pumpMint!);
  const tokenProgram = await mintTokenProgram(conn, mint);
  const bal = await conn.getTokenAccountBalance(pda.ata(creator.publicKey, mint, tokenProgram), "confirmed").catch(() => null);
  const tokens = BigInt(bal?.value.amount ?? "0");
  const toExists = tokens > 0n && (await conn.getAccountInfo(pda.ata(maker.publicKey, mint, tokenProgram), "confirmed")) !== null;
  const ataRent = tokens > 0n && !toExists ? await conn.getMinimumBalanceForRentExemption(165) : 0;
  const lamports = await conn.getBalance(creator.publicKey, "confirmed");
  const { tx, sol } = buildRotateTx(creator.publicKey, maker.publicKey, mint, tokenProgram, { tokens, lamports, ataRent });
  let sig: string | null = null;
  if (tx.instructions.length > 0) sig = await sendAndConfirmTransaction(conn, tx, [creator], { commitment: "confirmed" });
  const now = Date.now();
  rec.wallets.solMaker = maker.publicKey.toBase58();
  step(rec, "maker_rotated_sol", now, { from: creator.publicKey.toBase58(), to: rec.wallets.solMaker, tokens: Number(bal?.value.uiAmountString ?? 0), sol, tx: sig });
  registry.save(rec);
  console.log(`[rotate ${rec.id}] Solana maker is now ${rec.wallets.solMaker}: ${bal?.value.uiAmountString ?? 0} tokens + ${sol.toFixed(4)} SOL moved off the creator ${sig ?? "(nothing to move)"}`);
  return { maker: rec.wallets.solMaker, creator: creator.publicKey.toBase58(), tokens: Number(bal?.value.uiAmountString ?? 0), sol, tx: sig };
}
