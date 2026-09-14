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
