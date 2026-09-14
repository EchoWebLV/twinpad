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
