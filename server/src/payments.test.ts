import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "./payments.js";
import { newRecord } from "./record.js";

const quote = { depositSol: 0.5, frontSol: 1, frontEth: 0.03, devBuySol: 0.87, pumpTokens: 1, ponsEth: 0.01, ponsTokens: 1, makerCashEth: 0.02, openingFdv: 1, landing: { pump: 1, pons: 1 }, supplyPct: { pump: 1, pons: 1 }, fx: { SOL: 1, ETH: 1 } };
const rec = () => newRecord({
  id: "a-0000", now: 0, deadlineAt: 1000, devWallet: "DEV", quote,
  token: { name: "A", symbol: "A", description: "d", twitter: "", website: "", telegram: "", imageCid: "i", metadataCid: "m", metadataUri: "u" },
  wallets: { pumpMint: "M", solCreator: "C", evmLauncher: "0xL", evmMaker: "0xK", payment: "PAY" },
});

test("exact payment from the dev wallet marks paid", () => {
  const r = rec();
  const out = reconcile(r, [{ sig: "s1", from: "DEV", sol: 0.5, at: 10 }], 20);
  assert.equal(r.status, "paid");
  assert.equal(r.payment.paidAt, 20);
  assert.equal(r.payment.from, "DEV");
  assert.deepEqual(out.refunds, []);
});

test("partial then top-up, overpaid is recorded", () => {
  const r = rec();
  reconcile(r, [{ sig: "s1", from: "DEV", sol: 0.2, at: 10 }], 11);
  assert.equal(r.status, "awaiting_deposit");
  reconcile(r, [{ sig: "s1", from: "DEV", sol: 0.2, at: 10 }, { sig: "s2", from: "DEV", sol: 0.4, at: 12 }], 13);
  assert.equal(r.status, "paid");
  assert.equal(r.payment.txs.length, 2);
  assert.ok(Math.abs(r.payment.overpaidSol - 0.1) < 1e-9);
});

test("foreign payment is refunded and does not count", () => {
  const r = rec();
  const out = reconcile(r, [{ sig: "f1", from: "OTHER", sol: 0.5, at: 10 }], 11);
  assert.equal(r.status, "awaiting_deposit");
  assert.equal(r.payment.foreign.length, 1);
  assert.deepEqual(out.refunds, [{ to: "OTHER", sol: 0.5, sig: "f1", reason: "foreign" }]);
  assert.deepEqual(reconcile(r, [{ sig: "f1", from: "OTHER", sol: 0.5, at: 10 }], 12).refunds, []);
});

test("payment after the deadline is late and refunded", () => {
  const r = rec();
  const out = reconcile(r, [{ sig: "l1", from: "DEV", sol: 0.5, at: 2000 }], 2001);
  assert.equal(r.status, "awaiting_deposit");
  assert.equal(r.payment.txs[0].late, true);
  assert.equal(out.refunds[0].reason, "late");
});
