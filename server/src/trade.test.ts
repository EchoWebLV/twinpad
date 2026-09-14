import { test } from "node:test";
import assert from "node:assert/strict";
import { sellAmount } from "./trade.js";

// UNITY's maker held 3263058.761400886380170658 tokens; toFixed(6) rounded that UP to .761401 and the curve's
// transferFrom reverted with ERC20InsufficientBalance, which stranded the close.
const UNITY = 3263058761400886380170658n;

test("sellAmount never exceeds the on-chain balance when selling everything", () => {
  const tokens = Number(UNITY) / 1e18;
  const out = sellAmount(tokens, UNITY);
  assert.ok(out <= UNITY, `${out} > ${UNITY}`);
  assert.ok(UNITY - out < 10n ** 12n, `left ${UNITY - out} wei-units of dust`); // under 0.000001 token stays behind
});

test("sellAmount keeps a partial sell as asked, at 6 decimals", () => {
  assert.equal(sellAmount(1000, 5000n * 10n ** 18n), 1000n * 10n ** 18n);
  assert.equal(sellAmount(0.1234567, 10n ** 18n), 123456n * 10n ** 12n);
});

test("sellAmount clamps a stale over-estimate to what the wallet holds", () => {
  assert.equal(sellAmount(2, 15n * 10n ** 17n), 15n * 10n ** 17n);
});
