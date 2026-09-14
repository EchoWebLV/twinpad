import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "./payments.js";
import { migrateRecord, newRecord } from "./record.js";

const quote = { depositSol: 0.5, depositEth: 0.02, frontSol: 1, frontEth: 0.03, devBuySol: 0.87, boostSol: 0, parityDevBuySol: 0, pumpTokens: 1, ponsEth: 0.01, ponsTokens: 1, makerCashEth: 0.02, openingFdv: 1, landing: { pump: 1, pons: 1 }, supplyPct: { pump: 1, pons: 1 }, fx: { SOL: 1, ETH: 1 } };
const rec = () => newRecord({
  id: "a-0000", now: 0, deadlineAt: 1000, devWallet: "DEV", chain: "sol" as const, quote,
  token: { name: "A", symbol: "A", description: "d", twitter: "", website: "", telegram: "", imageCid: "i", metadataCid: "m", metadataUri: "u" },
  wallets: { pumpMint: "M", solCreator: "C", solMaker: "K", evmLauncher: "0xL", evmMaker: "0xK", payment: "PAY", evmPayment: "0xP" },
});
const ethRec = () => newRecord({
  id: "b-0000", now: 0, deadlineAt: 1000, devWallet: "0xAbC0000000000000000000000000000000000001", chain: "eth" as const, quote,
  token: { name: "B", symbol: "B", description: "d", twitter: "", website: "", telegram: "", imageCid: "i", metadataCid: "m", metadataUri: "u" },
  wallets: { pumpMint: "M", solCreator: "C", solMaker: "K", evmLauncher: "0xL", evmMaker: "0xK", payment: "PAY", evmPayment: "0xP" },
});

test("exact payment from the dev wallet marks paid", () => {
  const r = rec();
  const out = reconcile(r, [{ sig: "s1", from: "DEV", amount: 0.5, at: 10 }], 20);
  assert.equal(r.status, "paid");
  assert.equal(r.payment.paidAt, 20);
  assert.equal(r.payment.from, "DEV");
  assert.deepEqual(out.refunds, []);
});

test("partial then top-up, overpaid is recorded", () => {
  const r = rec();
  reconcile(r, [{ sig: "s1", from: "DEV", amount: 0.2, at: 10 }], 11);
  assert.equal(r.status, "awaiting_deposit");
  reconcile(r, [{ sig: "s1", from: "DEV", amount: 0.2, at: 10 }, { sig: "s2", from: "DEV", amount: 0.4, at: 12 }], 13);
  assert.equal(r.status, "paid");
  assert.equal(r.payment.txs.length, 2);
  assert.ok(Math.abs(r.payment.overpaid - 0.1) < 1e-9);
});

test("foreign payment is refunded and does not count", () => {
  const r = rec();
  const out = reconcile(r, [{ sig: "f1", from: "OTHER", amount: 0.5, at: 10 }], 11);
  assert.equal(r.status, "awaiting_deposit");
  assert.equal(r.payment.foreign.length, 1);
  assert.deepEqual(out.refunds, [{ to: "OTHER", amount: 0.5, sig: "f1", reason: "foreign" }]);
  assert.deepEqual(reconcile(r, [{ sig: "f1", from: "OTHER", amount: 0.5, at: 10 }], 12).refunds, []);
});

test("payment after the deadline is late and refunded", () => {
  const r = rec();
  const out = reconcile(r, [{ sig: "l1", from: "DEV", amount: 0.5, at: 2000 }], 2001);
  assert.equal(r.status, "awaiting_deposit");
  assert.equal(r.payment.txs[0].late, true);
  assert.equal(out.refunds[0].reason, "late");
});

test("eth record: required is depositEth, payment address is the EVM one, sender match is case-insensitive", () => {
  const r = ethRec();
  assert.equal(r.payment.chain, "eth");
  assert.equal(r.payment.unit, "ETH");
  assert.equal(r.payment.required, 0.02);
  assert.equal(r.payment.address, "0xP");
  const out = reconcile(r, [{ sig: "0xh1", from: "0xabc0000000000000000000000000000000000001", amount: 0.02, at: 10 }], 20);
  assert.equal(r.status, "paid");
  assert.deepEqual(out.refunds, []);
});

test("old SOL-only records migrate to the chain-aware shape", () => {
  const old = JSON.parse(JSON.stringify(rec())) as Record<string, unknown>;
  old.payment = { address: "PAY", requiredSol: 0.5, receivedSol: 0.5, paidAt: 5, from: "DEV", expectedFrom: "DEV", overpaidSol: 0, deadlineAt: 1000, toPoolTx: null, txs: [{ tx: "s1", from: "DEV", sol: 0.5, at: 1, late: false }], foreign: [] };
  old.refund = { sol: 0.1, paidSol: 0.5, txs: ["r1"] };
  delete (old.wallets as Record<string, unknown>).evmPayment;
  delete (old.quote as Record<string, unknown>).depositEth;
  const m = migrateRecord(old);
  assert.equal(m.payment.chain, "sol");
  assert.equal(m.payment.required, 0.5);
  assert.equal(m.payment.received, 0.5);
  assert.equal(m.payment.txs[0].amount, 0.5);
  assert.deepEqual(m.payment.claimed, []);
  assert.equal(m.refund.amount, 0.1);
  assert.equal(m.refund.paid, 0.5);
  assert.equal(m.wallets.evmPayment, "");
  assert.equal(m.quote.depositEth, 0);
});
