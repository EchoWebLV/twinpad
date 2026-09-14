import { test } from "node:test";
import assert from "node:assert/strict";
import { pumpLanding, quoteNetForFdv, grossFromNet, buildQuote, sizeFront, parityDevBuySol, affordableBuySol, frontForDevBuy, BUY_FEE_RATE, PUMP_VIRTUAL_SOL, PUMP_VIRTUAL_TOKENS } from "./quote.js";

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
  assert.equal(q.devBuySol, 13.4349); // (13.8 − 0.13) / 1.0175: the buy plus pump.fun + PumpPortal fees fits the front
  assert.ok(Math.abs(q.landing.pump - q.landing.pons) < 1, JSON.stringify(q.landing));
  assert.ok(q.ponsEth > 0 && q.ponsEth <= 0.32);
  assert.ok(Math.abs(q.depositEth - (0.5 * 101) / 2521) < 1e-6, `depositEth ${q.depositEth}`);
  const capped = buildQuote({ ...base, frontEth: 0.02 });
  assert.equal(capped.ponsEth, 0.01);
  assert.ok(capped.landing.pons < capped.landing.pump);
});

test("sizeFront: an equal share per open slot, clamped to [min, max]", () => {
  const min = { sol: 0.6, eth: 0.03 }, max = { sol: 8, eth: 0.1 };
  assert.deepEqual(sizeFront({ sol: 3, eth: 0.15, slots: 3 }, min, max), { sol: 1, eth: 0.05 });
  assert.deepEqual(sizeFront({ sol: 0.2, eth: 0.001, slots: 3 }, min, max), { sol: 0.6, eth: 0.03 }); // pool short: min (preflight refuses)
  assert.deepEqual(sizeFront({ sol: 100, eth: 5, slots: 1 }, min, max), { sol: 8, eth: 0.1 });
  assert.deepEqual(sizeFront({ sol: 100, eth: 5, slots: 0 }, min, max), { sol: 8, eth: 0.1 }); // never divides by zero
  assert.deepEqual(sizeFront({ sol: 5, eth: 5, slots: 1 }, min, { sol: 0.4, eth: 0.1 }), { sol: 0.6, eth: 0.1 }); // max below min: min wins
});

test("parityDevBuySol inverts pumpLanding at the Pons floor", () => {
  const fx = { SOL: 101.5, ETH: 2506 };
  const floorUsd = 1.68 * fx.ETH; // phantom ETH × ETH price
  const gross = parityDevBuySol(floorUsd, fx.SOL);
  assert.ok(gross > 6 && gross < 7.5, `gross ${gross}`);
  assert.ok(Math.abs(pumpLanding(gross).fdvSol * fx.SOL - floorUsd) < 1, `landing ${pumpLanding(gross).fdvSol * fx.SOL}`);
  assert.equal(parityDevBuySol(1000, fx.SOL), 0); // curve already opens above $1k
  assert.equal(parityDevBuySol(0, fx.SOL), 0);
});

test("buildQuote: a deployer boost adds to the dev buy on top of the pool's front", () => {
  const base = {
    depositSol: 0.5, frontSol: 1, frontEth: 0.05, solGasBudget: 0.13, evmMakerCash: 0.01,
    fx: { SOL: 101, ETH: 2521 }, pons: { phantomEth: 1.68, supply: 1e9, feeBps: 100, creatorTaxBps: 200 },
  };
  const plain = buildQuote(base);
  const boosted = buildQuote({ ...base, boostSol: 2 });
  assert.equal(plain.boostSol, 0);
  assert.equal(plain.devBuySol, 0.855);
  assert.equal(boosted.boostSol, 2);
  assert.equal(boosted.devBuySol, 2.8206);
  assert.equal(boosted.frontSol, 1);
  assert.ok(boosted.openingFdv > plain.openingFdv);
  assert.ok(boosted.parityDevBuySol > 6 && boosted.parityDevBuySol === plain.parityDevBuySol);
});

test("affordableBuySol: a 6.644 SOL maker cannot pay for a 6.554 SOL buy (fees), but can for 6.52", () => {
  const max = affordableBuySol(6.644);
  assert.ok(max < 6.554, `max ${max}`);
  assert.ok(max >= 6.51, `max ${max}`);
  assert.ok(Math.abs(max * (1 + BUY_FEE_RATE) + 0.01 - 6.644) < 1e-3);
  assert.equal(affordableBuySol(0.005), 0);
});

test("frontForDevBuy inverts buildQuote's dev buy sizing", () => {
  const front = frontForDevBuy(5, 0.13);
  const q = buildQuote({
    depositSol: 0.5, frontSol: front, frontEth: 0.33, solGasBudget: 0.13, evmMakerCash: 0.01,
    fx: { SOL: 150, ETH: 3000 }, pons: { phantomEth: 1.4, supply: 1e9, feeBps: 100, creatorTaxBps: 0 },
  });
  assert.ok(Math.abs(q.devBuySol - 5) < 1e-3, `devBuy ${q.devBuySol}`);
});
