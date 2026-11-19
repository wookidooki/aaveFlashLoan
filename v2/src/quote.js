// Exact quotes and full trade simulation, both free (eth_call with state override).
import { encodeFunctionData, decodeFunctionResult, encodeDeployData, decodeErrorResult, getAddress } from 'viem';
import { loadArtifact } from './abis.js';
import { hop } from './routes.js';
import { flashPremium } from './graph.js';

const ArbQuoter = loadArtifact('ArbQuoter');
const FlashArb = loadArtifact('FlashArb');

// Dummy addresses used only inside eth_call. Nothing is deployed there.
const QUOTER_AT = getAddress('0x00000000000000000000000000000000ab0e7e01');
const SIM_ARB_AT = getAddress('0x00000000000000000000000000000000ab0e7e02');
export const SIM_OWNER = getAddress('0x00000000000000000000000000000000ab0e7e03');

// Quote calls that failed as a whole (RPC error, gas limit, ...). Shown in the status line.
export const quoteErrors = { count: 0, last: '' };

export function routeHops(cycle, pools) {
  return cycle.legs.map((l) => hop(pools[l.i], l.tokenIn, l.tokenOut));
}

// Max swaps quoted in one eth_call. A big v3 swap that crosses many ticks can cost
// ~500k gas, so 40 swaps stays under the 25M gas we ask for.
const MAX_SWAPS_PER_CALL = 40;
const QUOTE_GAS = 25_000_000n;

async function quoteChunk(client, routes, amounts, blockNumber) {
  try {
    const { data } = await client.call({
      to: QUOTER_AT,
      data: encodeFunctionData({ abi: ArbQuoter.abi, functionName: 'quote', args: [routes, amounts] }),
      stateOverride: [{ address: QUOTER_AT, code: ArbQuoter.deployedBytecode }],
      gas: QUOTE_GAS,
      blockNumber,
    });
    return decodeFunctionResult({ abi: ArbQuoter.abi, functionName: 'quote', data });
  } catch (e) {
    // Too much work for one call: split it in half and try again.
    const swaps = routes.reduce((n, r, i) => n + r.length * amounts[i].length, 0);
    if (swaps > 1) {
      if (routes.length > 1) {
        const h = Math.ceil(routes.length / 2);
        const [x, y] = await Promise.all([
          quoteChunk(client, routes.slice(0, h), amounts.slice(0, h), blockNumber),
          quoteChunk(client, routes.slice(h), amounts.slice(h), blockNumber),
        ]);
        return [...x, ...y];
      }
      const h = Math.ceil(amounts[0].length / 2);
      if (amounts[0].length > 1) {
        const [x, y] = await Promise.all([
          quoteChunk(client, routes, [amounts[0].slice(0, h)], blockNumber),
          quoteChunk(client, routes, [amounts[0].slice(h)], blockNumber),
        ]);
        return [[...x[0], ...y[0]]];
      }
    }
    quoteErrors.count++;
    quoteErrors.last = `${(e.shortMessage || e.message || '').split('\n')[0]} ${e.details ?? ''}`.slice(0, 160);
    return amounts.map((x) => x.map(() => 0n));
  }
}

/** Quote routes at several sizes each. Returns outs[i][j] (0n = failed). */
export async function quoteRoutes(client, routes, amounts, blockNumber) {
  const jobs = [];
  let start = 0;
  let swaps = 0;
  for (let i = 0; i <= routes.length; i++) {
    const w = i < routes.length ? routes[i].length * amounts[i].length : 0;
    if (i === routes.length || (swaps + w > MAX_SWAPS_PER_CALL && i > start)) {
      if (i > start) jobs.push(quoteChunk(client, routes.slice(start, i), amounts.slice(start, i), blockNumber));
      start = i;
      swaps = 0;
    }
    swaps += w;
  }
  return (await Promise.all(jobs)).flat();
}

/** Finds the best trade size for each candidate loop: coarse grid, then a finer pass. */
export async function bestSizes(client, items, premiumBps, blockNumber) {
  // items: [{ hops, sizes: bigint[] }]
  const first = await quoteRoutes(client, items.map((x) => x.hops), items.map((x) => x.sizes), blockNumber);
  const pick = (sizes, outs) => {
    let best = { amount: 0n, out: 0n, profit: -1n, idx: -1 };
    sizes.forEach((s, j) => {
      if (!outs[j]) return;
      const p = outs[j] - s - flashPremium(s, premiumBps);
      if (p > best.profit) best = { amount: s, out: outs[j], profit: p, idx: j };
    });
    return best;
  };
  const coarse = items.map((x, i) => pick(x.sizes, first[i]));

  // Refine only loops that made money on the coarse grid.
  const refineIdx = coarse.map((b, i) => (b.profit > 0n ? i : -1)).filter((i) => i >= 0);
  if (!refineIdx.length) return coarse;
  const refineSizes = refineIdx.map((i) => {
    const s = items[i].sizes;
    const j = coarse[i].idx;
    const lo = j > 0 ? s[j - 1] : s[j] / 2n;
    const hi = j < s.length - 1 ? s[j + 1] : s[j] * 2n;
    const mid = coarse[i].amount;
    return [lo + (mid - lo) / 3n, lo + ((mid - lo) * 2n) / 3n, mid + (hi - mid) / 3n, mid + ((hi - mid) * 2n) / 3n].filter((x) => x > 0n);
  });
  const second = await quoteRoutes(client, refineIdx.map((i) => items[i].hops), refineSizes, blockNumber);
  refineIdx.forEach((i, k) => {
    const b = pick(refineSizes[k], second[k]);
    if (b.profit > coarse[i].profit) coarse[i] = b;
  });
  return coarse;
}

let runtimeCache = new Map();

/** FlashArb runtime code with owner = SIM_OWNER, made by a free eth_call of the constructor. */
async function simRuntime(client, aavePool) {
  if (runtimeCache.has(aavePool)) return runtimeCache.get(aavePool);
  const { data } = await client.call({
    account: SIM_OWNER,
    data: encodeDeployData({ abi: FlashArb.abi, bytecode: FlashArb.bytecode, args: [aavePool] }),
  });
  runtimeCache.set(aavePool, data);
  return data;
}

/**
 * Runs the whole trade (Aave flash loan + all swaps + repay) inside eth_call.
 * This is the same code that would run on-chain. Returns { ok, profit, reason }.
 */
export async function simulateArb(client, aavePool, asset, amount, hops, blockNumber) {
  const code = await simRuntime(client, aavePool);
  try {
    const { data } = await client.call({
      account: SIM_OWNER,
      to: SIM_ARB_AT,
      data: encodeFunctionData({ abi: FlashArb.abi, functionName: 'startArb', args: [asset, amount, hops, 0n] }),
      stateOverride: [{ address: SIM_ARB_AT, code }],
      gas: 8_000_000n,
      blockNumber,
    });
    const profit = decodeFunctionResult({ abi: FlashArb.abi, functionName: 'startArb', data });
    return { ok: true, profit };
  } catch (e) {
    return { ok: false, profit: 0n, reason: revertReason(e) };
  }
}

export function revertReason(e) {
  let c = e;
  while (c) {
    if (typeof c.data === 'string' && c.data.startsWith('0x') && c.data.length >= 10) {
      try {
        return decodeErrorResult({ abi: FlashArb.abi, data: c.data }).errorName;
      } catch {
        return `revert ${c.data.slice(0, 10)}`;
      }
    }
    c = c.cause;
  }
  return (e.shortMessage || e.message || 'unknown').split('\n')[0].slice(0, 80);
}
