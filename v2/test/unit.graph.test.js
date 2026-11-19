// Offline unit tests for the fast-filter math. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgeRates, midPrice, buildCycles, cycleGap, rankCycles, rateTable, usdPrices, poolTvlUsd, flashPremium, pickLender, minPremiumBps, maxLoan } from '../src/graph.js';

const close = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} != ${b}`);
const Q96 = 2n ** 96n;

test('v2 rates include the fee', () => {
  const { r01, r10 } = edgeRates({ kind: 'v2', feeBps: 30 }, { reserve0: 1000n, reserve1: 2000n });
  close(r01, 2 * 0.997);
  close(r10, 0.5 * 0.997);
});

test('solidly volatile uses x*y=k with its own fee; stable uses probe quotes', () => {
  close(edgeRates({ kind: 'solidly', stable: false, feeBps: 5 }, { reserve0: 100n, reserve1: 100n }).r01, 0.9995);
  const st = { probeIn0: 1000n, probeOut01: 999n, probeIn1: 1000n, probeOut10: 998n };
  const r = edgeRates({ kind: 'solidly', stable: true }, st);
  close(r.r01, 0.999);
  close(r.r10, 0.998);
});

test('v3 rates come from sqrtPriceX96 and fee', () => {
  // price 4 token1 per token0 -> sqrtPrice 2
  const st = { sqrtPriceX96: 2n * Q96, liquidity: 10n ** 18n, fee: 500 };
  const { r01, r10 } = edgeRates({ kind: 'v3', fee: 500 }, st);
  close(r01, 4 * 0.9995);
  close(r10, 0.25 * 0.9995);
  close(midPrice({ kind: 'v3', fee: 500 }, st), 4);
});

test('pools with no liquidity or no state give rate 0', () => {
  assert.deepEqual(edgeRates({ kind: 'v3', fee: 500 }, { sqrtPriceX96: Q96, liquidity: 0n }), { r01: 0, r10: 0 });
  assert.deepEqual(edgeRates({ kind: 'v2', feeBps: 30 }, undefined), { r01: 0, r10: 0 });
  assert.deepEqual(edgeRates({ kind: 'v2', feeBps: 30 }, { reserve0: 0n, reserve1: 5n }), { r01: 0, r10: 0 });
});

// Tokens A < B < C (address order decides token0/token1)
const A = '0xA', B = '0xB', C = '0xC';
const pools = [
  { address: 'p0', kind: 'v2', feeBps: 30, token0: A, token1: B },
  { address: 'p1', kind: 'v2', feeBps: 30, token0: A, token1: B },
  { address: 'p2', kind: 'v2', feeBps: 30, token0: B, token1: C },
  { address: 'p3', kind: 'v2', feeBps: 30, token0: A, token1: C },
];

test('buildCycles finds every 2-swap and 3-swap loop from the start token', () => {
  assert.equal(buildCycles(pools, [A], 2).length, 2); // p0->p1, p1->p0
  const all = buildCycles(pools, [A], 3);
  // 2 two-swap loops + A-B(x2)-C-A (2) + A-C-B-A(x2) (2)
  assert.equal(all.length, 6);
  for (const c of all) {
    assert.equal(c.legs[0].tokenIn, A);
    assert.equal(c.legs.at(-1).tokenOut, A);
    c.legs.forEach((l, i) => i && assert.equal(l.tokenIn, c.legs[i - 1].tokenOut));
  }
});

test('cycleGap and rankCycles find the loop with a price gap', () => {
  // p0: 1 A = 2 B. p1: 1 A = 2.2 B (B is cheap on p1). Buy B on p1, sell on p0.
  const states = new Map([
    ['p0', { reserve0: 1000n, reserve1: 2000n }],
    ['p1', { reserve0: 1000n, reserve1: 2200n }],
    ['p2', { reserve0: 1000n, reserve1: 1000n }],
    ['p3', { reserve0: 1000n, reserve1: 1000n }],
  ]);
  const rates = rateTable(pools, states);
  const cycles = buildCycles(pools, [A], 2);
  const { candidates, bestGap } = rankCycles(cycles, rates, 5, 10);
  assert.equal(candidates.length, 1);
  const expected = 2.2 * 0.997 * (1 / 2) * 0.997 * (1 - 0.0005) - 1;
  close(candidates[0].gap, expected);
  close(bestGap, expected);
  assert.equal(candidates[0].cycle.legs[0].i, 1); // starts on the cheap pool
  close(cycleGap(candidates[0].cycle, rates, 5), expected);
});

test('usdPrices derives prices from a $1 anchor and pool sizes', () => {
  const USDC = '0x1', WETH = '0x2', X = '0x3';
  const tokens = new Map([[USDC, { decimals: 6 }], [WETH, { decimals: 18 }], [X, { decimals: 18 }]]);
  const ps = [
    // 1 WETH = 2000 USDC (token0 = USDC)
    { address: 'a', kind: 'v2', feeBps: 30, token0: USDC, token1: WETH, bal0: 2_000_000n * 10n ** 6n, bal1: 1000n * 10n ** 18n },
    // small pool with a bad price, must lose to the big one
    { address: 'b', kind: 'v2', feeBps: 30, token0: USDC, token1: WETH, bal0: 1000n * 10n ** 6n, bal1: 1n * 10n ** 18n },
    // 1 WETH = 4 X
    { address: 'c', kind: 'v2', feeBps: 30, token0: WETH, token1: X, bal0: 10n ** 20n, bal1: 4n * 10n ** 20n },
  ];
  const states = new Map(ps.map((p) => [p.address, { reserve0: p.bal0, reserve1: p.bal1 }]));
  const prices = usdPrices(tokens, ps, states, USDC);
  close(prices.get(WETH), 2000, 1e-9);
  close(prices.get(X), 500, 1e-9);
  close(poolTvlUsd(ps[0], tokens, prices), 4_000_000, 1e-9);
});

test('flash loan fee matches Aave rounding (up), as seen on-chain', () => {
  assert.equal(flashPremium(1_000_000n, 5), 500n);
  assert.equal(flashPremium(1_000_100n, 5), 501n); // on-chain: 501
  assert.equal(flashPremium(999n, 5), 1n); // on-chain: 1
});

test('rankCycles keeps each loop once, even if it can start from several tokens', () => {
  const states = new Map([
    ['p0', { reserve0: 1000n, reserve1: 2000n }],
    ['p1', { reserve0: 1000n, reserve1: 2200n }],
    ['p2', { reserve0: 1000n, reserve1: 1000n }],
    ['p3', { reserve0: 1000n, reserve1: 1000n }],
  ]);
  const rates = rateTable(pools, states);
  const cycles = buildCycles(pools, [A, B], 2); // A->B->A and B->A->B are the same loop
  const { candidates, positive } = rankCycles(cycles, rates, 0, 10);
  assert.equal(positive, 2);
  assert.equal(candidates.length, 1);
});

test('pickLender uses Morpho (no fee) when it has enough, else Aave, else nothing', () => {
  // Aave fee rounds up, so even 960 units pays 1 unit at 5 bps.
  const lenders = { aavePremiumBps: 5, aave: new Map([['X', 10_000n], ['Y', 10_000n]]), morpho: new Map([['X', 1_000n]]) };
  assert.deepEqual(pickLender(lenders, 'X', 900n), { source: 'morpho', premium: 0n }); // <= 95% of 1000
  assert.deepEqual(pickLender(lenders, 'X', 960n), { source: 'aave', premium: 1n }); // too big for Morpho
  assert.deepEqual(pickLender(lenders, 'X', 9_000n), { source: 'aave', premium: 5n });
  assert.equal(pickLender(lenders, 'X', 9_600n), null); // more than 95% of Aave
  assert.equal(pickLender(lenders, 'Z', 1n), null);
  assert.equal(minPremiumBps(lenders, 'X'), 0);
  assert.equal(minPremiumBps(lenders, 'Y'), 5);
  assert.equal(minPremiumBps(lenders, 'Z'), Infinity);
  assert.equal(maxLoan(lenders, 'X'), 9_500n);
});

test('rankCycles uses the fee of each start token', () => {
  const states = new Map([
    ['p0', { reserve0: 1000n, reserve1: 2000n }],
    ['p1', { reserve0: 10000n, reserve1: 20127n }], // tiny gap: about +0.03% after swap fees
    ['p2', { reserve0: 1000n, reserve1: 1000n }],
    ['p3', { reserve0: 1000n, reserve1: 1000n }],
  ]);
  const rates = rateTable(pools, states);
  const cycles = buildCycles(pools, [A], 2);
  assert.equal(rankCycles(cycles, rates, () => 0, 10).candidates.length, 1); // no fee: profitable
  assert.equal(rankCycles(cycles, rates, () => 5, 10).candidates.length, 0); // 0.05% fee kills it
});
