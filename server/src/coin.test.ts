import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CoinState } from "./coin.js";
import type { SideState } from "./prices.js";

const side = (fdv: number): SideState => ({ chain: "", venue: "", kind: "curve", phase: "curve", phaseLabel: "", fdv, price: 1, quoteSymbol: "SOL", quoteDepth: 0, progress: 0, realQuote: 0, at: 0 } as unknown as SideState);

test("gap, snapshot and persistence per coin", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coin-"));
  const pair = { pumpMint: "M", ponsToken: "0xT", ponsCurve: "0xC", launchedAt: 1, name: "Doggo", symbol: "DOGGO" };
  const meta = { name: "Doggo", symbol: "DOGGO", image: "i", twitter: "", website: "", description: "d" };
  const c = new CoinState(dir, "doggo-ab12", 0.05, pair, meta);
  c.pump = side(100);
  c.pons = side(110);
  assert.deepEqual(c.gap(), { gap: 0.1, expensive: "pons" });
  c.pushPoint();
  c.persist();
  const s = c.snapshot("1h");
  assert.equal(s.status, "live");
  assert.equal(s.coin.id, "doggo-ab12");
  assert.equal(s.inBand, false);
  assert.ok(fs.existsSync(path.join(dir, "state", "doggo-ab12.json")));
  const again = new CoinState(dir, "doggo-ab12", 0.05, pair, meta);
  assert.equal(again.series.length, 1);
  assert.equal(c.summary().maker, "off");
});

test("bought inventory is booked at cost per side, released by sells, never negative, and survives a restart", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { CoinState } = await import("./coin.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coin-bought-"));
  const pair = { pumpMint: "m", ponsToken: "0x0000000000000000000000000000000000000001", ponsCurve: "0x0000000000000000000000000000000000000002", launchedAt: 1, name: "n", symbol: "s" };
  const meta = { name: "n", symbol: "s", image: "", twitter: "", website: "", description: "" };
  const c = new CoinState(dir, "c1", 0.05, pair, meta);
  c.noteBuy("pons", 25); c.noteBuy("pons", 24.5); c.noteSell("pons", 10);
  c.noteSell("pump", 999);
  assert.deepEqual(c.maker.bought, { pumpUsd: 0, ponsUsd: 39.5 });
  assert.equal(c.underCeiling("pons", 25, 300), true);
  assert.equal(c.underCeiling("pons", 25, 60), false);
  c.persist();
  const again = new CoinState(dir, "c1", 0.05, pair, meta);
  assert.deepEqual(again.maker.bought, { pumpUsd: 0, ponsUsd: 39.5 });
  fs.rmSync(dir, { recursive: true, force: true });
});
