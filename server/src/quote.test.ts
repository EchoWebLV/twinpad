import { test } from "node:test";
import assert from "node:assert/strict";
import { pumpLanding, quoteNetForFdv, grossFromNet, buildQuote, PUMP_VIRTUAL_SOL, PUMP_VIRTUAL_TOKENS } from "./quote.js";

test("pumpLanding: 13.687 SOL lands near TWINE's observed opening (≈ 59 SOL fdv, ~33 % of supply)", () => {
  const l = pumpLanding(13.687, 0);
  assert.ok(Math.abs(l.fdvSol - 59.5) < 1.5, `fdv ${l.fdvSol}`);
  assert.ok(Math.abs(l.tokens / 1e9 - 0.336) < 0.01, `tokens ${l.tokens}`);
});

test("quoteNetForFdv is the inverse of a constant-product buy", () => {
  const Q = PUMP_VIRTUAL_SOL, T = PUMP_VIRTUAL_TOKENS;
  const net = 5;
  const fdvAfter = ((Q + net) ** 2 / (Q * T)) * 1e9;
  assert.ok(Math.abs(quoteNetForFdv(Q, T, 1e9, fdvAfter) - net) < 1e-9);
  assert.equal(quoteNetForFdv(Q, T, 1e9, 1), 0);
});

test("grossFromNet adds fee and tax", () => {
  assert.ok(Math.abs(grossFromNet(0.97, 100, 200) - 1) < 1e-12);
});

test("buildQuote lands both sides at the same fdv when ETH allows, else caps", () => {
  const base = {
    depositSol: 0.5, frontSol: 13.8, frontEth: 0.33, solGasBudget: 0.13, evmMakerCash: 0.01,
    fx: { SOL: 101, ETH: 2521 }, pons: { phantomEth: 2, supply: 1e9, feeBps: 100, creatorTaxBps: 200 },
  };
  const q = buildQuote(base);
  assert.equal(q.devBuySol, 13.67);
  assert.ok(Math.abs(q.landing.pump - q.landing.pons) < 1, JSON.stringify(q.landing));
  assert.ok(q.ponsEth > 0 && q.ponsEth <= 0.32);
  assert.ok(Math.abs(q.depositEth - (0.5 * 101) / 2521) < 1e-6, `depositEth ${q.depositEth}`);
  const capped = buildQuote({ ...base, frontEth: 0.02 });
  assert.equal(capped.ponsEth, 0.01);
  assert.ok(capped.landing.pons < capped.landing.pump);
});
