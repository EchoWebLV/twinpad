import { test } from "node:test";
import assert from "node:assert/strict";

process.env.POOL_SOL_KEY = "x".repeat(88);
process.env.ADMIN_TOKEN = "secret-token";
process.env.DEPOSIT_SOL = "0.1";
process.env.FRONT_SOL = "13.8";
process.env.AUTO_APPROVE = "false";
process.env.POOL_MIN_SOL = "5";
const { config, redactedConfig } = await import("./config.js");

test("launch section reads env with defaults", () => {
  assert.equal(config.launch.depositSol, 0.1);
  assert.equal(config.launch.frontSol, 13.8);
  assert.equal(config.launch.autoApprove, false);
  assert.equal(config.pool.minSol, 5);
});

test("redactedConfig never contains secrets", () => {
  const s = JSON.stringify(redactedConfig());
  assert.ok(!s.includes("x".repeat(88)));
  assert.ok(!s.includes("secret-token"));
  assert.match(s, /set \(88 chars\)/);
});
