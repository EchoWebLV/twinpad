import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { buildRotateTx, CREATOR_KEEP_SOL } from "./rotate.js";
import { TOKEN_PROGRAM, ATA_PROGRAM } from "./solana/pump.js";

const creator = Keypair.generate().publicKey, maker = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;

test("rotate tx creates the ATA, moves every token and the SOL above the keep", () => {
  const { tx, sol } = buildRotateTx(creator, maker, mint, TOKEN_PROGRAM, { tokens: 123_456_789n, lamports: 1 * LAMPORTS_PER_SOL, ataRent: 2_039_280 });
  assert.equal(tx.instructions.length, 3);
  assert.ok(tx.instructions[0].programId.equals(ATA_PROGRAM));
  assert.ok(tx.instructions[1].programId.equals(TOKEN_PROGRAM));
  assert.equal(tx.instructions[1].data[0], 3);
  assert.equal(tx.instructions[1].data.readBigUInt64LE(1), 123_456_789n);
  assert.equal(Math.round(sol * LAMPORTS_PER_SOL), LAMPORTS_PER_SOL - CREATOR_KEEP_SOL * LAMPORTS_PER_SOL - 2_039_280 - 10_000);
});

test("rotate tx skips the ATA when it exists and the SOL when nothing is above the keep", () => {
  const { tx, sol } = buildRotateTx(creator, maker, mint, TOKEN_PROGRAM, { tokens: 5n, lamports: 5_000_000, ataRent: 0 });
  assert.equal(tx.instructions.length, 1);
  assert.equal(sol, 0);
});

test("rotate tx is empty with no tokens and no spare SOL", () => {
  const { tx } = buildRotateTx(creator, maker, mint, TOKEN_PROGRAM, { tokens: 0n, lamports: 0, ataRent: 0 });
  assert.equal(tx.instructions.length, 0);
});
