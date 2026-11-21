// Unit tests for the bigint port of the Uniswap v3 core math (live equality with on-chain quoters is
// checked by `npm run verify-local`).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_SQRT_RATIO,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MIN_TICK,
  Q96,
  getAmount0Delta,
  getAmount1Delta,
  getSqrtRatioAtTick,
  swapExactIn,
  type TickData,
} from "../src/quote/v3math.ts";

describe("v3 math", () => {
  it("getSqrtRatioAtTick matches the TickMath boundary constants", () => {
    assert.equal(getSqrtRatioAtTick(0), Q96);
    assert.equal(getSqrtRatioAtTick(MIN_TICK), MIN_SQRT_RATIO);
    assert.equal(getSqrtRatioAtTick(MAX_TICK), MAX_SQRT_RATIO);
    // Uniswap v3 TickMath test vectors
    assert.equal(getSqrtRatioAtTick(50), 79426470787362580746886972461n);
    assert.equal(getSqrtRatioAtTick(-50), 79030349367926598376800521322n);
  });

  it("getSqrtRatioAtTick is increasing and sqrt(p(t)) * sqrt(p(-t)) = 1 within rounding", () => {
    let prev = 0n;
    for (const t of [-887272, -500000, -60, -1, 0, 1, 60, 500000, 887272]) {
      const s = getSqrtRatioAtTick(t);
      assert.ok(s > prev);
      prev = s;
    }
    for (const t of [1, 60, 10000, 200000]) {
      const prod = getSqrtRatioAtTick(t) * getSqrtRatioAtTick(-t);
      const rel = Number(prod - Q96 * Q96) / Number(Q96 * Q96);
      assert.ok(Math.abs(rel) < 1e-15, `t=${t}: ${rel}`);
    }
  });

  it("amount deltas round in the pool's favour", () => {
    const a = getSqrtRatioAtTick(-100);
    const b = getSqrtRatioAtTick(100);
    const L = 10n ** 18n;
    assert.ok(getAmount0Delta(a, b, L, true) - getAmount0Delta(a, b, L, false) <= 1n);
    assert.ok(getAmount1Delta(a, b, L, true) - getAmount1Delta(a, b, L, false) <= 1n);
  });

  it("a swap inside one range equals the closed form x*y=k on virtual reserves (no fee)", () => {
    const L = 10n ** 24n;
    const sqrtP = Q96; // price 1
    const ticks: TickData = { tickSpacing: 60, words: new Map([[-1, 0n], [0, 0n]]), liquidityNet: new Map() };
    const amountIn = 10n ** 18n;
    const r = swapExactIn({ sqrtPriceX96: sqrtP, tick: 0, liquidity: L, feePips: 0n }, ticks, true, amountIn);
    // virtual reserves x = y = L at price 1: out = y * in / (x + in), rounded down by the pool
    const expected = (L * amountIn) / (L + amountIn);
    assert.ok(r.filled);
    assert.ok(expected - r.amountOut <= 1n, `got ${r.amountOut}, expected about ${expected}`);
  });

  it("crossing an initialized tick applies its liquidityNet", () => {
    const L = 10n ** 20n;
    // Tick spacing 1; initialized tick at -10 (bit 246 of word -1). Crossing it downwards subtracts
    // liquidityNet, so a net of -L doubles the liquidity below it.
    const words = new Map<number, bigint>([[-1, 1n << 246n], [0, 0n]]);
    const ticks: TickData = { tickSpacing: 1, words, liquidityNet: new Map([[-10, -L]]) };
    const state = { sqrtPriceX96: Q96, tick: 0, liquidity: L, feePips: 0n };
    // Input needed to reach tick -10 at liquidity L, then some more below it.
    const toTick = getAmount0Delta(getSqrtRatioAtTick(-10), Q96, L, true);
    const extra = 10n ** 15n;
    const r = swapExactIn(state, ticks, true, toTick + extra);
    assert.equal(r.ticksCrossed, 1);
    assert.ok(r.filled);
    // Output = output down to tick -10 plus the extra input swapped at doubled liquidity, which
    // moves the price less (and so yields more) than at the original liquidity.
    const outToTick = getAmount1Delta(getSqrtRatioAtTick(-10), Q96, L, false);
    const single = swapExactIn({ ...state, liquidity: L }, { tickSpacing: 1, words: new Map([[-1, 0n], [0, 0n]]), liquidityNet: new Map() }, true, toTick + extra);
    assert.ok(r.amountOut > outToTick);
    assert.ok(r.amountOut > single.amountOut, "doubled liquidity past the tick gives a better fill");
  });
});
