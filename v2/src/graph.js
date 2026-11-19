// Pure math for the fast filter. No network calls here, so it is easy to unit test.
//
// Rates are in raw token units ("wei" of each token). Around a closed loop the units
// cancel, so the product of the rates is the profit multiplier at a very small size:
// product 1.003 = +0.3% before the flash loan fee. Price impact only makes bigger
// trades worse, so a loop with product <= 1 + fee can never be profitable.

const Q96 = 2 ** 96;

/** Marginal rates for a pool, fee included: r01 = token0 -> token1, r10 = token1 -> token0. */
export function edgeRates(pool, st) {
  if (!st) return { r01: 0, r10: 0 };
  if (pool.kind === 'v2' || (pool.kind === 'solidly' && !pool.stable)) {
    const r0 = Number(st.reserve0);
    const r1 = Number(st.reserve1);
    if (!(r0 > 0 && r1 > 0)) return { r01: 0, r10: 0 };
    const keep = 1 - pool.feeBps / 10000;
    return { r01: (r1 / r0) * keep, r10: (r0 / r1) * keep };
  }
  if (pool.kind === 'solidly' && pool.stable) {
    // Stable curve: use small real quotes from the pool (fee included).
    const r01 = st.probeIn0 > 0n && st.probeOut01 > 0n ? Number(st.probeOut01) / Number(st.probeIn0) : 0;
    const r10 = st.probeIn1 > 0n && st.probeOut10 > 0n ? Number(st.probeOut10) / Number(st.probeIn1) : 0;
    return { r01, r10 };
  }
  // v3 / cl
  if (!(st.liquidity > 0n) || !(st.sqrtPriceX96 > 0n)) return { r01: 0, r10: 0 };
  const s = Number(st.sqrtPriceX96) / Q96;
  const p = s * s; // token1 per token0
  const fee = Number(st.fee ?? pool.fee) / 1e6;
  const keep = 1 - fee;
  if (!(p > 0) || !Number.isFinite(p)) return { r01: 0, r10: 0 };
  return { r01: p * keep, r10: (1 / p) * keep };
}

/** Mid price without fee: raw token1 per raw token0. */
export function midPrice(pool, st) {
  const { r01, r10 } = edgeRates(pool, st);
  if (!(r01 > 0 && r10 > 0)) return 0;
  return Math.sqrt(r01 / r10); // the fee cancels out
}

/** Fill a Float64Array with rates: index 2*i = token0->token1, 2*i+1 = token1->token0. */
export function rateTable(pools, states) {
  const rates = new Float64Array(pools.length * 2);
  pools.forEach((p, i) => {
    const { r01, r10 } = edgeRates(p, states.get(p.address));
    rates[2 * i] = r01;
    rates[2 * i + 1] = r10;
  });
  return rates;
}

/**
 * All loops that start and end at a token Aave can lend.
 * Each loop: { start, legs: [{ i, zeroForOne, tokenIn, tokenOut }] }
 */
export function buildCycles(pools, startTokens, maxHops = 3) {
  const adj = new Map();
  const add = (t, e) => (adj.get(t) ?? adj.set(t, []).get(t)).push(e);
  pools.forEach((p, i) => {
    add(p.token0, { i, zeroForOne: true, tokenIn: p.token0, tokenOut: p.token1 });
    add(p.token1, { i, zeroForOne: false, tokenIn: p.token1, tokenOut: p.token0 });
  });
  const cycles = [];
  for (const A of startTokens) {
    for (const e1 of adj.get(A) ?? []) {
      const B = e1.tokenOut;
      for (const e2 of adj.get(B) ?? []) {
        if (e2.i === e1.i) continue;
        if (e2.tokenOut === A) {
          cycles.push({ start: A, legs: [e1, e2] });
          continue;
        }
        if (maxHops < 3) continue;
        const C = e2.tokenOut;
        for (const e3 of adj.get(C) ?? []) {
          if (e3.tokenOut === A) cycles.push({ start: A, legs: [e1, e2, e3] });
        }
      }
    }
  }
  return cycles;
}

/** Profit multiplier at tiny size, after the flash loan fee. 0.001 = +0.1%. */
export function cycleGap(cycle, rates, premiumBps) {
  let x = 1;
  for (const l of cycle.legs) x *= rates[2 * l.i + (l.zeroForOne ? 0 : 1)];
  return x * (1 - premiumBps / 10000) - 1;
}

/**
 * Best loops first. Only loops with a positive gap after the flash fee.
 * premiumBps: a number, or a function (startToken) => fee in bps for that token.
 */
export function rankCycles(cycles, rates, premiumBps, limit) {
  const out = [];
  let best = -Infinity;
  let bestCycle = null;
  const feeOf = typeof premiumBps === 'function' ? premiumBps : () => premiumBps;
  for (const c of cycles) {
    const gap = cycleGap(c, rates, feeOf(c.start));
    if (gap > best) { best = gap; bestCycle = c; }
    if (gap > 0) out.push({ cycle: c, gap });
  }
  out.sort((a, b) => b.gap - a.gap);
  return { candidates: out.slice(0, limit), bestGap: best, bestCycle, positive: out.length };
}

/** USD price per whole token, from pool prices. Starts from one $1 anchor token. */
export function usdPrices(tokens, pools, states, anchor) {
  const price = new Map([[anchor, 1]]);
  for (let pass = 0; pass < tokens.size; pass++) {
    const best = new Map();
    for (const p of pools) {
      const has0 = price.has(p.token0);
      const has1 = price.has(p.token1);
      if (has0 === has1) continue;
      const m = midPrice(p, states.get(p.address));
      if (!(m > 0)) continue;
      const d0 = tokens.get(p.token0).decimals;
      const d1 = tokens.get(p.token1).decimals;
      const human = m * 10 ** (d0 - d1); // whole token1 per whole token0
      let t, cand, weight;
      if (has1) {
        t = p.token0;
        cand = human * price.get(p.token1);
        weight = (Number(p.bal1 ?? 0n) / 10 ** d1) * price.get(p.token1);
      } else {
        t = p.token1;
        cand = price.get(p.token0) / human;
        weight = (Number(p.bal0 ?? 0n) / 10 ** d0) * price.get(p.token0);
      }
      if (!best.has(t) || weight > best.get(t).weight) best.set(t, { cand, weight });
    }
    if (!best.size) break;
    for (const [t, v] of best) price.set(t, v.cand);
  }
  return price;
}

/** Pool size in USD from token balances. */
export function poolTvlUsd(pool, tokens, prices) {
  const v = (t, bal) => (prices.has(t) ? (Number(bal ?? 0n) / 10 ** tokens.get(t).decimals) * prices.get(t) : 0);
  return v(pool.token0, pool.bal0) + v(pool.token1, pool.bal1);
}

/** Aave v3 flash loan fee (percentMul rounds half up). */
export const flashPremium = (amount, premiumBps) => (amount * BigInt(premiumBps) + 5000n) / 10000n;

// ---------------------------------------------------------------- flash loan sources
// lenders = { aavePremiumBps, aave: Map(asset -> available), morpho: Map(asset -> available) }
// We never borrow more than 95% of what a lender holds.
const usable = (x) => ((x ?? 0n) * 95n) / 100n;

/** Cheapest source that can lend `amount`: Morpho (no fee) first, then Aave. null if none. */
export function pickLender(lenders, asset, amount) {
  if (amount <= usable(lenders.morpho.get(asset))) return { source: 'morpho', premium: 0n };
  if (amount <= usable(lenders.aave.get(asset))) return { source: 'aave', premium: flashPremium(amount, lenders.aavePremiumBps) };
  return null;
}

/** Lowest fee (bps) at which `asset` can be borrowed at all. Infinity if it cannot. */
export function minPremiumBps(lenders, asset) {
  if (usable(lenders.morpho.get(asset)) > 0n) return 0;
  if (usable(lenders.aave.get(asset)) > 0n) return lenders.aavePremiumBps;
  return Infinity;
}

/** Biggest loan of `asset` any source can give. */
export function maxLoan(lenders, asset) {
  const m = usable(lenders.morpho.get(asset));
  const a = usable(lenders.aave.get(asset));
  return m > a ? m : a;
}
