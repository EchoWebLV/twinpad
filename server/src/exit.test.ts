import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, lossUsd } from "./exit.js";
import { newRetire } from "./record.js";

const policy = { afterMin: 10, minBuyers: 5, minUsd: 100, selldownMin: 45 };
const T0 = 1_000_000;
const min = (n: number) => T0 + n * 60_000;

test("waits before decideAt and when activity is unknown", () => {
  const r = newRetire(T0, policy);
  assert.equal(decide(r, { outsideBuyers: 0, outsideUsd: 0 }, min(9)), "wait");
  assert.equal(decide(r, null, min(11)), "wait");
});

test("keeps when either bar is met", () => {
  const r = newRetire(T0, policy);
  assert.equal(decide(r, { outsideBuyers: 5, outsideUsd: 10 }, min(10)), "keep");
  assert.equal(decide(r, { outsideBuyers: 1, outsideUsd: 100 }, min(10)), "keep");
});

test("full close at zero buyers, selldown otherwise", () => {
  const r = newRetire(T0, policy);
  assert.equal(decide(r, { outsideBuyers: 0, outsideUsd: 0 }, min(10)), "full");
  assert.equal(decide(r, { outsideBuyers: 2, outsideUsd: 40 }, min(10)), "selldown");
});

test("selldown finishes at selldownUntil; evaluated verdicts are sticky", () => {
  const r = newRetire(T0, policy);
  r.evaluated = { at: min(10), outsideBuyers: 2, outsideUsd: 40, verdict: "selldown" };
  r.selldownUntil = min(55);
  assert.equal(decide(r, { outsideBuyers: 9, outsideUsd: 900 }, min(30)), "selldown");
  assert.equal(decide(r, null, min(55)), "finish");
  r.evaluated.verdict = "keep";
  assert.equal(decide(r, { outsideBuyers: 0, outsideUsd: 0 }, min(99)), "keep");
});

test("operator keep and a started full close win", () => {
  const r = newRetire(T0, policy);
  r.keep = true;
  assert.equal(decide(r, { outsideBuyers: 0, outsideUsd: 0 }, min(20)), "keep");
  const f = newRetire(T0, policy);
  f.mode = "full";
  assert.equal(decide(f, null, min(1)), "full");
});

test("lossUsd is fronted value minus held value", () => {
  const fx = { SOL: 100, ETH: 2000 };
  const inv = { solana: { sol: 0.5, tokens: 1000 }, evm: { eth: 0.01, tokens: 0, escrowEth: 0.005 } };
  // tokens: 1000 × $0.02 = $20; sol $50; eth $20 + escrow $10 → held $100; fronted 1 SOL + 0.05 ETH = $200
  assert.equal(lossUsd({ sol: 1, eth: 0.05 }, inv, { pump: 0.02, pons: 0.01 }, fx), 100);
});
