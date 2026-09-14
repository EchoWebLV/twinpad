import { test } from "node:test";
import assert from "node:assert/strict";
import { withTimeout } from "./activity.js";

test("withTimeout passes a value through when the promise settles in time", async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 50, "x"), 7);
});

test("withTimeout rejects with the label when the promise hangs", async () => {
  const never = new Promise<number>(() => {});
  await assert.rejects(withTimeout(never, 20, "pump.fun holders"), /pump\.fun holders timed out after 20ms/);
});

test("withTimeout keeps the original rejection", async () => {
  await assert.rejects(withTimeout(Promise.reject(new Error("rpc down")), 50, "x"), /rpc down/);
});

test("oneLineSendError folds web3's multi-line simulation error into one line with the failing logs", async () => {
  const { oneLineSendError } = await import("./solana/pump.js");
  const e = Object.assign(new Error("Simulation failed. \nMessage: Transaction simulation failed: Error processing Instruction 3: custom program error: 0x1. \nLogs: \n[...]. \nCatch the `SendTransactionError` and call `getLogs()` on it for full details."), {
    logs: ["Program 11111111111111111111111111111111 invoke [2]", "Transfer: insufficient lamports 4709951, need 32769999", "Program 11111111111111111111111111111111 failed: custom program error: 0x1"],
  });
  const m = oneLineSendError(e);
  assert.ok(!m.includes("\n"));
  assert.ok(m.startsWith("Simulation failed. Message: Transaction simulation failed"), m);
  assert.ok(m.includes("insufficient lamports 4709951, need 32769999"), m);
  assert.equal(oneLineSendError(new Error("plain")), "plain");
});
