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
