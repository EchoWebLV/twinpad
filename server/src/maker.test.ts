import { test } from "node:test";
import assert from "node:assert/strict";
import { sizeBuy, sizeSell } from "./maker.js";

test("sizeBuy spends the full clip when the wallet can fund it above the floor", () => {
  assert.equal(sizeBuy(0.03, 0.05, 0.003, 0.01), 0.03);
});

test("sizeBuy shrinks a scaled clip to what sits above the floor", () => {
  assert.equal(Number(sizeBuy(0.03, 0.015, 0.003, 0.01).toFixed(6)), 0.012);
});

test("sizeBuy returns 0 under a quarter of the base clip", () => {
  assert.equal(sizeBuy(0.03, 0.005, 0.003, 0.01), 0);
  assert.equal(sizeBuy(0.03, 0.002, 0.003, 0.01), 0);
});

test("sizeSell moves the clip, or the remaining inventory when that is smaller", () => {
  assert.equal(sizeSell(8_700_000, 10_000_000, 2_900_000), 8_700_000);
  assert.equal(sizeSell(8_700_000, 3_777_657, 2_900_000), 3_777_657);
  assert.equal(sizeSell(8_700_000, 500_000, 2_900_000), 0);
});

test("underCeiling admits a clip up to the ceiling and refuses past it", async () => {
  const { underCeiling } = await import("./coin.js");
  assert.equal(underCeiling(0, 25, 300), true);
  assert.equal(underCeiling(275, 25, 300), true); // lands exactly on the ceiling
  assert.equal(underCeiling(280, 25, 300), false);
  assert.equal(underCeiling(300, 25, 300), false);
});
