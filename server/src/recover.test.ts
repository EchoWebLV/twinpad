import { test } from "node:test";
import assert from "node:assert/strict";
import { canTopUp } from "./recover.js";

test("top-ups stay under the per-coin cap while the coin still owes the pool", () => {
  assert.equal(canTopUp({ fronted: 8, repaid: 2, topups: 0 }, 0.5, 3), true);
  assert.equal(canTopUp({ fronted: 10.5, repaid: 2, topups: 2.5 }, 0.5, 3), true); // lands exactly on the cap
  assert.equal(canTopUp({ fronted: 11, repaid: 2, topups: 3 }, 0.5, 3), false);
});

test("a coin that has repaid more than it was fronted can be topped up past the cap", () => {
  // TTWIN: 9.9097 fronted (3 of it top-ups), 19.74 repaid — the pool is 9.8 SOL ahead, another 0.5 is not new exposure
  assert.equal(canTopUp({ fronted: 9.9097, repaid: 19.741653, topups: 3 }, 0.5, 3), true);
  // but not when the extra top-up would push the coin back into owing the pool
  assert.equal(canTopUp({ fronted: 9.9, repaid: 10.1, topups: 3 }, 0.5, 3), false);
  assert.equal(canTopUp({ fronted: 9.9, repaid: 10.4, topups: 3 }, 0.5, 3), true);
});
