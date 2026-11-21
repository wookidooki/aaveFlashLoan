// Properties of the Aerodrome/Velodrome v2 stable-curve port (exact equality with the live pools'
// getAmountOut is checked by `npm run verify-local`).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { solidlyStableAmountOut } from "../src/quote/amm.ts";

const E6 = 10n ** 6n;
const E18 = 10n ** 18n;

describe("Solidly stable curve", () => {
  it("a balanced 6/18-decimal pool trades close to 1:1, minus the fee", () => {
    const r0 = 5_000_000n * E6; // 5M of a 6-decimal stablecoin
    const r1 = 5_000_000n * E18; // 5M of an 18-decimal stablecoin
    const out = solidlyStableAmountOut(1000n * E6, 5n, true, r0, r1, E6, E18);
    const rate = Number(out) / 1e18 / 1000;
    assert.ok(rate < 0.9995 && rate > 0.9994, `rate ${rate}`);
    const back = solidlyStableAmountOut(1000n * E18, 5n, false, r0, r1, E6, E18);
    assert.ok(Number(back) / 1e6 / 1000 < 0.9995);
  });

  it("output grows with input, but the rate never improves with size", () => {
    const r0 = 2_000_000n * E18, r1 = 3_000_000n * E18;
    let prevOut = 0n, prevRate = Infinity;
    for (const a of [1n, 100n, 10_000n, 500_000n]) {
      const out = solidlyStableAmountOut(a * E18, 1n, true, r0, r1, E18, E18);
      const rate = Number(out) / Number(a * E18);
      assert.ok(out > prevOut);
      assert.ok(rate <= prevRate * (1 + 1e-12), `size ${a}: ${rate} > ${prevRate}`);
      prevOut = out;
      prevRate = rate;
    }
  });
});
