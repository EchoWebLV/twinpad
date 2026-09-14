import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Registry } from "./registry.js";
import { breakerContribution, createOperatorLaunch, shapeQuote, validateOperatorInput, type ShapeInputs } from "./operator.js";
import { TOTAL_SUPPLY, PUMP_VIRTUAL_SOL, PUMP_VIRTUAL_TOKENS } from "./quote.js";

const PONS = { phantomEth: 1.68, supply: 1e9, feeBps: 100, creatorTaxBps: 200 };
const base = (over: Partial<ShapeInputs> = {}): ShapeInputs => ({
  lockPct: 15, bundleSol: 19.46, ponsEth: 0.5284, cashSol: 2, cashEth: 0.07, maxLossUsd: 500,
  fx: { SOL: 102.8, ETH: 2532 }, pons: PONS, solGasBudget: 0.13, evmMakerCash: 0.01, launcherEth: 0.0125, ...over,
});

test("shape: the lock takes exactly lockPct of supply on both curves, the peg buys after it", () => {
  const s = shapeQuote(base());
  assert.equal(s.lock.tokens, 150_000_000);
  // net SOL that moves 150M tokens out of the fresh pump.fun curve
  const net = (PUMP_VIRTUAL_SOL * PUMP_VIRTUAL_TOKENS) / (PUMP_VIRTUAL_TOKENS - 150e6) - PUMP_VIRTUAL_SOL;
  assert.ok(Math.abs(s.lock.sol - net) < 1e-4, `lock sol ${s.lock.sol} vs ${net}`);
  assert.ok(s.lock.solGross > s.lock.sol && s.lock.fundSol > s.lock.solGross);
  const netEth = (150e6 * 1.68) / (1e9 - 150e6);
  assert.ok(Math.abs(s.lock.eth - netEth) < 1e-4, `lock eth ${s.lock.eth} vs ${netEth}`);
  assert.ok(s.lock.ethGross > s.lock.eth);
  // pump.fun after lock + $2k: maker holds ~30% and the fdv is above the lock-only level
  assert.ok(s.pump.supplyPct > 25 && s.pump.supplyPct < 40, `pump pct ${s.pump.supplyPct}`);
  assert.ok(s.pump.fdv > 8000 && s.pump.fdv < 11000, `pump fdv ${s.pump.fdv}`);
  // the operator's parity ETH lands Pons within 1% of pump.fun
  const t = shapeQuote(base({ ponsEth: s.pons.parityEth }));
  assert.ok(t.gapPct < 1, `gap ${t.gapPct}%`);
  // pool need = maker fronts + lock funds + launcher
  assert.ok(Math.abs(s.pool.sol - (s.pump.makerFrontSol + s.lock.fundSol)) < 1e-6);
  assert.ok(Math.abs(s.pool.eth - (s.pons.makerFrontEth + s.lock.fundEth + 0.0125)) < 1e-6);
});

test("shape: zero lock is the plain two-sided open", () => {
  const s = shapeQuote(base({ lockPct: 0 }));
  assert.equal(s.lock.tokens, 0);
  assert.equal(s.lock.fundSol, 0);
  assert.equal(s.lock.fundEth, 0);
  assert.equal(s.pool.sol, s.pump.makerFrontSol);
});

test("validateOperatorInput: bounds and defaults", () => {
  const v = validateOperatorInput({ lockPct: "15", bundleSol: "19.46", ponsEth: "0.5", cashSol: "", cashEth: "0.05" });
  assert.deepEqual(v, { lockPct: 15, bundleSol: 19.46, ponsEth: 0.5, cashSol: 0, cashEth: 0.05, maxLossUsd: null, wallets: null });
  assert.throws(() => validateOperatorInput({ lockPct: 50, bundleSol: 1, ponsEth: 0.1 }), /lockPct max 40/);
  assert.throws(() => validateOperatorInput({ bundleSol: 0, ponsEth: 0.1 }), /bundleSol must be above 0/);
  assert.throws(() => validateOperatorInput({ bundleSol: 1, ponsEth: 0 }), /ponsEth must be above 0/);
  assert.throws(() => validateOperatorInput({ bundleSol: 1, ponsEth: 0.1, maxLossUsd: -5 }), /maxLossUsd/);
  assert.equal(validateOperatorInput({ bundleSol: 1, ponsEth: 0.1, maxLossUsd: "500" }).maxLossUsd, 500);
});

test("breakerContribution: an operator coin only counts the loss past its own cap", () => {
  assert.equal(breakerContribution(120, null), 120);
  assert.equal(breakerContribution(-30, null), 0);
  assert.equal(breakerContribution(400, 500), 0);
  assert.equal(breakerContribution(650, 500), 150);
  assert.equal(breakerContribution(null, 500), 0);
});

test("createOperatorLaunch: pinned, keyed with lock wallets, approved with nothing owed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "op-"));
  const registry = new Registry(dir);
  const png = "data:image/png;base64," + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(16)]).toString("base64");
  const pins: string[] = [];
  const { rec, shape } = await createOperatorLaunch(
    {
      registry, now: () => 1_000, publicUrl: "https://twinpad.one",
      pin: { file: async (_p, name) => { pins.push(name); return "imgcid"; }, json: async (_j, name) => { pins.push(name); return "metacid"; } },
      shape: async (op) => { const inputs = base(op); return { shape: shapeQuote(inputs), inputs }; },
    },
    { name: "Op Coin", symbol: "opc", description: "operator", imageDataUrl: png, lockPct: 15, bundleSol: 19.46, ponsEth: 0.5284, cashSol: 2, cashEth: 0.07, maxLossUsd: 500 },
  );
  assert.equal(rec.status, "approved");
  assert.equal(rec.approval.status, "approved");
  assert.equal(rec.payment.required, 0);
  assert.equal(rec.payment.toPoolTx, "none");
  assert.equal(rec.operator?.lockPct, 15);
  assert.equal(rec.operator?.maxLossUsd, 500);
  assert.equal(rec.quote.devBuySol, 19.46);
  assert.equal(rec.quote.ponsEth, 0.5284);
  assert.equal(rec.front.sol, shape.pump.makerFrontSol);
  assert.equal(rec.front.eth, shape.pons.makerFrontEth);
  assert.ok(rec.wallets.solLock && rec.wallets.evmLock);
  const keys = registry.keys(rec.id);
  assert.equal(keys.solLock?.length, 64);
  assert.match(keys.evmLock ?? "", /^0x[0-9a-f]{64}$/);
  assert.deepEqual(pins, ["OPC.png", "OPC-metadata.json"]);
  assert.equal(rec.token.website, `https://twinpad.one/coin/${rec.id}`);
  assert.equal(TOTAL_SUPPLY, 1e9);
});

test("recovery keep: an operator coin's cash reserve sits on top of the keep level", async () => {
  const { Recovery } = await import("./recover.js");
  const { CoinState } = await import("./coin.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keep-"));
  const cfg = { maker: { minSol: 0.05, minEth: 0.003, maxClipUsd: 25 }, recover: { keepClips: 4 } } as never;
  const rec = new Recovery({ cfg } as never);
  const pair = { pumpMint: "m", ponsToken: "t", ponsCurve: "c", launchedAt: 0, name: "n", symbol: "s" };
  const meta = { name: "n", symbol: "s", image: "", twitter: "", website: "", description: "" };
  const c = new CoinState(dir, "x", 0.05, pair, meta);
  c.fx = { SOL: 100, ETH: 2500 };
  const plain = rec.keep(c);
  c.keepExtra = { sol: 2, eth: 0.07 };
  const withCash = rec.keep(c);
  assert.ok(Math.abs(withCash.sol - plain.sol - 2) < 1e-9);
  assert.ok(Math.abs(withCash.eth - plain.eth - 0.07) < 1e-9);
});
