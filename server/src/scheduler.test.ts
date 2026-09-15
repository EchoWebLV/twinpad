import { test } from "node:test";
import assert from "node:assert/strict";
import { plan } from "./scheduler.js";
import { newRecord, transition, type LaunchRecord } from "./record.js";

const quote = { depositSol: 0.5, depositEth: 0.02, frontSol: 1, frontEth: 0.03, devBuySol: 0.87, boostSol: 0, parityDevBuySol: 0, pumpTokens: 1, ponsEth: 0.01, ponsTokens: 1, makerCashEth: 0.02, openingFdv: 1, landing: { pump: 1, pons: 1 }, supplyPct: { pump: 1, pons: 1 }, fx: { SOL: 1, ETH: 1 } };
const mk = (id: string, status: LaunchRecord["status"], createdAt = 0) => {
  const r = newRecord({ id, now: createdAt, deadlineAt: 1000, devWallet: "D", chain: "sol" as const, quote,
    token: { name: "A", symbol: "A", description: "d", twitter: "", website: "", telegram: "", imageCid: "i", metadataCid: "m", metadataUri: "u" },
    wallets: { pumpMint: "M", solCreator: "C", solMaker: "K", evmLauncher: "0xL", evmMaker: "0xK", payment: "P", evmPayment: "0xP" } });
  const path: Record<string, LaunchRecord["status"][]> = { paid: ["paid"], approved: ["paid", "approved"], launching: ["paid", "approved", "launching"], live: ["paid", "approved", "launching", "live"] };
  for (const s of path[status] ?? []) transition(r, s, createdAt);
  return r;
};

test("auto-approve when enabled and below the maker cap", () => {
  const acts = plan([mk("a", "paid")], { autoApprove: true, maxLiveMakers: 1 });
  assert.deepEqual(acts, [{ type: "approve", id: "a" }, { type: "launch", id: "a" }]);
});

test("no auto-approve when disabled or cap reached", () => {
  assert.deepEqual(plan([mk("a", "paid")], { autoApprove: false, maxLiveMakers: 5 }), []);
  assert.deepEqual(plan([mk("a", "paid"), mk("b", "live")], { autoApprove: true, maxLiveMakers: 1 }), []);
});

test("launch oldest approved, one at a time", () => {
  const acts = plan([mk("new", "approved", 5), mk("old", "approved", 1)], { autoApprove: false, maxLiveMakers: 5 });
  assert.deepEqual(acts, [{ type: "launch", id: "old" }]);
  assert.deepEqual(plan([mk("a", "approved"), mk("b", "launching")], { autoApprove: false, maxLiveMakers: 5 }), []);
});

test("failed launches are re-queued after the backoff, up to autoRetries, never while paused", () => {
  const f = mk("f", "launching", 0);
  transition(f, "failed", 100);
  const cfg = { autoApprove: false, maxLiveMakers: 5, autoRetries: 2, retryBackoffMs: 1000 };
  assert.deepEqual(plan([f], cfg, 500), []);
  assert.deepEqual(plan([f], cfg, 1100), [{ type: "retry", id: "f" }]);
  assert.deepEqual(plan([f], { ...cfg, paused: true }, 1100), []);
  f.launch.retries = 2;
  assert.deepEqual(plan([f], cfg, 1100), []);
});

test("nothing is approved, launched or retried while launches are closed", () => {
  const f = mk("f", "launching", 0);
  transition(f, "failed", 100);
  const cfg = { autoApprove: true, maxLiveMakers: 5, autoRetries: 2, retryBackoffMs: 0, closed: true };
  assert.deepEqual(plan([mk("a", "paid"), mk("b", "approved"), f], cfg, 1100), []);
  assert.deepEqual(plan([mk("a", "paid")], { ...cfg, closed: false }), [{ type: "approve", id: "a" }, { type: "launch", id: "a" }]);
});
