import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Registry } from "./registry.js";
import { newRecord, transition, publicRecord, type Quote } from "./record.js";

const quote: Quote = {
  depositSol: 0.1, depositEth: 0.004, frontSol: 1, frontEth: 0.03, devBuySol: 0.87, boostSol: 0, parityDevBuySol: 0, pumpTokens: 1, ponsEth: 0.01, ponsTokens: 1,
  makerCashEth: 0.01, openingFdv: 100, landing: { pump: 100, pons: 100 }, supplyPct: { pump: 1, pons: 1 }, fx: { SOL: 100, ETH: 2500 },
};
const token = { name: "Doggo", symbol: "DOGGO", description: "d", twitter: "", website: "", telegram: "", imageCid: "i", metadataCid: "m", metadataUri: "u" };
const wallets = { pumpMint: "M", solCreator: "C", evmLauncher: "0xL", evmMaker: "0xK", payment: "P", evmPayment: "0xP" };

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
}

test("newId is symbol-xxxx", () => {
  const r = new Registry(tmp());
  assert.match(r.newId("DoGgO!"), /^doggo-[a-z0-9]{4}$/);
});

test("save/load round-trips and keys are private", () => {
  const dir = tmp();
  const r = new Registry(dir);
  const rec = newRecord({ id: "doggo-ab12", token, devWallet: "H6CS", chain: "sol", wallets, quote, deadlineAt: 10, now: 5 });
  r.save(rec);
  r.saveKeys("doggo-ab12", { mint: [1], solCreator: [2], payment: [3], evmLauncher: "0x01", evmMaker: "0x02" });
  const again = new Registry(dir);
  assert.equal(again.get("doggo-ab12")?.status, "awaiting_deposit");
  assert.deepEqual(again.keys("doggo-ab12").mint, [1]);
  assert.equal(fs.statSync(path.join(dir, "launches", "doggo-ab12", "keys.json")).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(publicRecord(rec)).includes("keys"));
});

test("transition enforces the state machine", () => {
  const rec = newRecord({ id: "a-0000", token, devWallet: "D", chain: "sol", wallets, quote, deadlineAt: 10, now: 5 });
  transition(rec, "paid", 6);
  assert.throws(() => transition(rec, "live", 7), /paid → live/);
  transition(rec, "approved", 7);
  transition(rec, "launching", 8);
  transition(rec, "failed", 9);
  transition(rec, "approved", 10);
  assert.equal(rec.launch.steps.at(-1)?.name, "status:approved");
});

test("list filters by status, newest first", () => {
  const r = new Registry(tmp());
  for (const [id, t] of [["a-0001", 1], ["b-0002", 2]] as const) {
    r.save(newRecord({ id, token, devWallet: "D", chain: "sol", wallets, quote, deadlineAt: 10, now: t }));
  }
  assert.deepEqual(r.list().map((x) => x.id), ["b-0002", "a-0001"]);
  assert.equal(r.list({ status: ["paid"] }).length, 0);
});
