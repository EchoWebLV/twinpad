import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Registry } from "./registry.js";
import { newRecord, newRetire, transition, type Quote } from "./record.js";
import { Retirer } from "./retire.js";

const quote: Quote = {
  depositSol: 0.1, depositEth: 0.004, frontSol: 1, frontEth: 0.03, devBuySol: 0.87, boostSol: 0, parityDevBuySol: 0, pumpTokens: 1, ponsEth: 0.01, ponsTokens: 1,
  makerCashEth: 0.01, openingFdv: 100, landing: { pump: 100, pons: 100 }, supplyPct: { pump: 1, pons: 1 }, fx: { SOL: 100, ETH: 2500 },
};
const token = { name: "Doggo", symbol: "DOGGO", description: "d", twitter: "", website: "", telegram: "", imageCid: "i", metadataCid: "m", metadataUri: "u" };
const wallets = { pumpMint: "M", solCreator: "C", solMaker: "K", evmLauncher: "0xL", evmMaker: "0xK", payment: "P", evmPayment: "0xP" };
const policy = { enabled: true, afterMin: 10, minBuyers: 5, minUsd: 100, selldownMin: 45 };

function liveCoin() {
  const registry = new Registry(fs.mkdtempSync(path.join(os.tmpdir(), "retire-")));
  const rec = newRecord({ id: "doggo-ab12", token, devWallet: "D", chain: "sol", wallets, quote, deadlineAt: 10, now: 5 });
  for (const s of ["paid", "approved", "launching", "live"] as const) transition(rec, s, 6);
  rec.launch.launchedAt = 1_000_000;
  rec.retire = newRetire(rec.launch.launchedAt, policy);
  registry.save(rec);
  return { registry, rec };
}

function retirer(registry: Registry, measure: () => Promise<{ outsideBuyers: number; outsideUsd: number } | null>) {
  const calls = { measure: 0, close: 0, mode: [] as string[] };
  const ctx = { cfg: { retire: { enabled: true }, guard: { maxLossUsdPool: 500 } }, registry } as any;
  const coin = { id: "doggo-ab12", maker: { lossUsd: 0, mode: "peg" }, pump: { price: 1 }, pons: { price: 1 } } as any;
  const makers = { setMode: (_id: string, m: string) => calls.mode.push(m) } as any;
  const r = new Retirer(ctx, () => [coin], makers, async () => { calls.close++; }, () => {});
  (r as any).activity = async () => { calls.measure++; const a = await measure(); return a && { ...a, pump: a, pons: a }; };
  return { r, calls };
}

test("a keep verdict is recorded once and the coin is not measured again", async () => {
  const { registry, rec } = liveCoin();
  const { r, calls } = retirer(registry, async () => ({ outsideBuyers: 6, outsideUsd: 900 }));
  const at = rec.retire!.decideAt + 1;
  await r.tick(at);
  await r.tick(at + 30_000);
  const saved = registry.get("doggo-ab12")!;
  assert.equal(calls.measure, 1);
  assert.equal(saved.retire!.evaluated?.verdict, "keep");
  assert.equal(saved.retire!.evaluated?.at, at);
  assert.ok(saved.launch.steps.some((s) => s.name === "exit_evaluated"));
  assert.equal(calls.close, 0);
  assert.deepEqual(calls.mode, []);
});

test("selldown is recorded with its window and the maker switched", async () => {
  const { registry, rec } = liveCoin();
  const { r, calls } = retirer(registry, async () => ({ outsideBuyers: 2, outsideUsd: 30 }));
  const at = rec.retire!.decideAt + 1;
  await r.tick(at);
  const saved = registry.get("doggo-ab12")!;
  assert.equal(saved.retire!.evaluated?.verdict, "selldown");
  assert.equal(saved.retire!.selldownUntil, at + policy.selldownMin * 60_000);
  assert.deepEqual(calls.mode, ["selldown"]);
  assert.equal(calls.close, 0);
});

test("nothing is recorded before decideAt or when the measurement is unknown", async () => {
  const { registry, rec } = liveCoin();
  const { r, calls } = retirer(registry, async () => null);
  await r.tick(rec.retire!.decideAt - 1);
  assert.equal(calls.measure, 0);
  await r.tick(rec.retire!.decideAt + 1);
  assert.equal(calls.measure, 1);
  assert.equal(registry.get("doggo-ab12")!.retire!.evaluated, null);
});
