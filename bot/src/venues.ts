// Venue adapters: verify a venue's contracts, discover pools for a token pair, and quote exact-input
// swaps at a fixed block. Quotes come from each venue's own on-chain quoter or pool math, so swap
// fees and price impact are already inside the quoted output and are never added again as costs.
import { getAddress, parseAbi, zeroAddress, type Address, type PublicClient } from "viem";
import { multicallAt, type CallResult, type CallSpec } from "./chain.ts";
import type { GasModelConfig, VenueConfig } from "./config.ts";
import { v2AmountOut } from "./quote/amm.ts";
import { LEG_KIND } from "./sim/receiver.ts";

const V3_FACTORY = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const CL_TICK_FACTORY = parseAbi(["function getPool(address,address,int24) view returns (address)"]);
const SOLIDLY_FACTORY = parseAbi(["function getPool(address,address,bool) view returns (address)"]);
const V2_FACTORY = parseAbi(["function getPair(address,address) view returns (address)"]);
const QUOTER_FACTORY = parseAbi(["function factory() view returns (address)"]);
const CL_POOL = parseAbi(["function liquidity() view returns (uint128)"]);
const V2_PAIR = parseAbi([
  "function getReserves() view returns (uint112, uint112, uint32)",
  "function token0() view returns (address)",
]);
const SOLIDLY_POOL = parseAbi(["function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)"]);
// QuoterV2 functions are not view on-chain (they revert internally), but are always eth_call'ed.
const QUOTER_V2 = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const SLIPSTREAM_QUOTER = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, int24 tickSpacing, uint160 sqrtPriceLimitX96) params) view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

export interface PoolInfo {
  /** e.g. "uniswap-v3:500" or "aerodrome-v2:volatile" */
  label: string;
  venue: VenueConfig;
  address: Address;
  token0: Address;
  token1: Address;
  /** fee tier, tick spacing or stable flag */
  param: number | boolean;
  legKind: number;
  feeBps: number;
}

export interface PoolSkip {
  label: string;
  pair: string;
  reason: string;
}

export interface VenueCheck {
  ok: boolean;
  reason?: string;
}

/** Contract code exists and the quoter points at the configured factory. */
export async function verifyVenue(client: PublicClient, v: VenueConfig): Promise<VenueCheck> {
  const code = await client.getCode({ address: v.factory });
  if (!code || code === "0x") return { ok: false, reason: `no contract at factory ${v.factory}` };
  if (v.type === "v3" || v.type === "slipstream") {
    const qcode = await client.getCode({ address: v.quoter });
    if (!qcode || qcode === "0x") return { ok: false, reason: `no contract at quoter ${v.quoter}` };
    try {
      const f = await client.readContract({ address: v.quoter, abi: QUOTER_FACTORY, functionName: "factory" });
      if (getAddress(f) !== v.factory) return { ok: false, reason: `quoter.factory() is ${f}, expected ${v.factory}` };
    } catch (e) {
      return { ok: false, reason: `quoter.factory() unreadable` };
    }
  }
  return { ok: true };
}

function sortTokens(a: Address, b: Address): [Address, Address] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

/** Discover pools for one pair on one venue, at a block. Returns pools plus skip records. */
export interface DepthFilter {
  /** Skip pools where either token side is worth less than this (USD). */
  minSideUsd: number;
  /** USD value of `amount` of `token`, or undefined if no price is available. */
  valueUsd: (token: Address, amount: bigint) => number | undefined;
}

const ERC20_BAL = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export async function discoverPools(
  client: PublicClient,
  v: VenueConfig,
  a: Address,
  b: Address,
  pairName: string,
  blockNumber: bigint,
  depth?: DepthFilter,
): Promise<{ pools: PoolInfo[]; skips: PoolSkip[] }> {
  const [t0, t1] = sortTokens(a, b);
  const candidates: { label: string; param: number | boolean; call: CallSpec }[] = [];
  if (v.type === "v3") {
    for (const fee of v.fees) {
      candidates.push({ label: `${v.id}:${fee}`, param: fee, call: { address: v.factory, abi: V3_FACTORY, functionName: "getPool", args: [t0, t1, fee] } });
    }
  } else if (v.type === "slipstream") {
    for (const ts of v.tickSpacings) {
      candidates.push({ label: `${v.id}:ts${ts}`, param: ts, call: { address: v.factory, abi: CL_TICK_FACTORY, functionName: "getPool", args: [t0, t1, ts] } });
    }
  } else if (v.type === "solidly") {
    for (const stable of [false, true]) {
      candidates.push({
        label: `${v.id}:${stable ? "stable" : "volatile"}`,
        param: stable,
        call: { address: v.factory, abi: SOLIDLY_FACTORY, functionName: "getPool", args: [t0, t1, stable] },
      });
    }
  } else {
    candidates.push({ label: `${v.id}`, param: v.feeBps, call: { address: v.factory, abi: V2_FACTORY, functionName: "getPair", args: [t0, t1] } });
  }

  const res = await multicallAt(client, candidates.map((c) => c.call), blockNumber);
  const pools: PoolInfo[] = [];
  const skips: PoolSkip[] = [];
  const found: { c: (typeof candidates)[number]; address: Address }[] = [];
  res.forEach((r, i) => {
    const c = candidates[i];
    if (!r.ok) skips.push({ label: c.label, pair: pairName, reason: `pool lookup failed: ${r.error}` });
    else if (getAddress(r.value) === zeroAddress) skips.push({ label: c.label, pair: pairName, reason: "pool does not exist" });
    else found.push({ c, address: getAddress(r.value) });
  });

  // Liveness: concentrated pools need in-range liquidity; v2/solidly need non-empty reserves.
  const live = await multicallAt(
    client,
    found.map(({ address }) =>
      v.type === "v3" || v.type === "slipstream"
        ? { address, abi: CL_POOL, functionName: "liquidity" }
        : { address, abi: V2_PAIR, functionName: "getReserves" },
    ),
    blockNumber,
  );
  const balances = depth
    ? await multicallAt(
        client,
        found.flatMap(({ address }) => [
          { address: t0, abi: ERC20_BAL, functionName: "balanceOf", args: [address] },
          { address: t1, abi: ERC20_BAL, functionName: "balanceOf", args: [address] },
        ]),
        blockNumber,
      )
    : [];
  found.forEach(({ c, address }, i) => {
    const r = live[i];
    if (!r.ok) return skips.push({ label: c.label, pair: pairName, reason: `liveness read failed: ${r.error}` });
    const empty = v.type === "v3" || v.type === "slipstream" ? BigInt(r.value) === 0n : BigInt(r.value[0]) === 0n || BigInt(r.value[1]) === 0n;
    if (empty) return skips.push({ label: c.label, pair: pairName, reason: "no active liquidity" });
    if (depth) {
      const b0 = balances[2 * i];
      const b1 = balances[2 * i + 1];
      const v0 = b0.ok ? depth.valueUsd(t0, BigInt(b0.value)) : undefined;
      const v1 = b1.ok ? depth.valueUsd(t1, BigInt(b1.value)) : undefined;
      if (v0 !== undefined && v1 !== undefined && Math.min(v0, v1) < depth.minSideUsd) {
        const held = `$${Math.round(v0).toLocaleString()} / $${Math.round(v1).toLocaleString()}`;
        return skips.push({ label: c.label, pair: pairName, reason: `too shallow: holds ${held}, below the smallest loan ($${depth.minSideUsd.toLocaleString()})` });
      }
    }
    pools.push({
      label: c.label,
      venue: v,
      address,
      token0: t0,
      token1: t1,
      param: c.param,
      legKind:
        v.type === "v2" ? LEG_KIND.v2 : v.type === "solidly" ? LEG_KIND.solidly : v.callback === "pancake" ? LEG_KIND.clPancakeCallback : LEG_KIND.clUniswapCallback,
      feeBps: v.type === "v2" ? v.feeBps : 0,
    });
  });
  return { pools, skips };
}

export interface Quote {
  amountOut: bigint;
  /** swap gas: quoter estimate for CL venues, configured constant otherwise */
  gas: bigint;
}

/** Per-cycle cached v2 reserves keyed by pair address (token0-ordered). */
export type V2Reserves = Map<Address, [bigint, bigint]>;

export async function readV2Reserves(client: PublicClient, pools: PoolInfo[], blockNumber: bigint): Promise<V2Reserves> {
  const v2 = pools.filter((p) => p.venue.type === "v2");
  const res = await multicallAt(client, v2.map((p) => ({ address: p.address, abi: V2_PAIR, functionName: "getReserves" })), blockNumber);
  const m: V2Reserves = new Map();
  v2.forEach((p, i) => {
    const r = res[i];
    if (r.ok) m.set(p.address, [BigInt(r.value[0]), BigInt(r.value[1])]);
  });
  return m;
}

export interface QuoteRequest {
  pool: PoolInfo;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
}

/**
 * Quote many exact-input swaps at one block. v2 pairs are computed locally from reserves read at
 * the same block (exact integer math); everything else is an eth_call to the venue's quoter/pool.
 */
export async function quoteMany(
  client: PublicClient,
  reqs: QuoteRequest[],
  v2Reserves: V2Reserves,
  gasModel: GasModelConfig,
  blockNumber: bigint,
): Promise<(Quote | { error: string })[]> {
  const out: (Quote | { error: string })[] = new Array(reqs.length);
  const remote: { i: number; call: CallSpec }[] = [];
  reqs.forEach((q, i) => {
    const v = q.pool.venue;
    if (v.type === "v2") {
      const r = v2Reserves.get(q.pool.address);
      if (!r) return (out[i] = { error: "reserves unavailable" });
      const [rIn, rOut] = q.tokenIn === q.pool.token0 ? r : [r[1], r[0]];
      const amountOut = v2AmountOut(q.amountIn, rIn, rOut, BigInt(v.feeBps));
      out[i] = amountOut > 0n ? { amountOut, gas: BigInt(gasModel.v2SwapGas) } : { error: "zero output" };
    } else if (v.type === "solidly") {
      remote.push({ i, call: { address: q.pool.address, abi: SOLIDLY_POOL, functionName: "getAmountOut", args: [q.amountIn, q.tokenIn] } });
    } else if (v.type === "slipstream") {
      remote.push({
        i,
        call: { address: v.quoter, abi: SLIPSTREAM_QUOTER, functionName: "quoteExactInputSingle", args: [{ tokenIn: q.tokenIn, tokenOut: q.tokenOut, amountIn: q.amountIn, tickSpacing: q.pool.param, sqrtPriceLimitX96: 0n }] },
      });
    } else {
      remote.push({
        i,
        call: { address: v.quoter, abi: QUOTER_V2, functionName: "quoteExactInputSingle", args: [{ tokenIn: q.tokenIn, tokenOut: q.tokenOut, amountIn: q.amountIn, fee: q.pool.param, sqrtPriceLimitX96: 0n }] },
      });
    }
  });
  const res: CallResult[] = remote.length ? await multicallAt(client, remote.map((r) => r.call), blockNumber, 10) : [];
  remote.forEach(({ i }, k) => {
    const r = res[k];
    const v = reqs[i].pool.venue;
    if (!r.ok) return (out[i] = { error: `quote reverted: ${r.error}` });
    if (v.type === "solidly") {
      const amountOut = BigInt(r.value);
      out[i] = amountOut > 0n ? { amountOut, gas: BigInt(gasModel.solidlySwapGas) } : { error: "zero output" };
    } else {
      const [amountOut, , , gasEstimate] = r.value as [bigint, bigint, number, bigint];
      out[i] = amountOut > 0n ? { amountOut, gas: BigInt(gasEstimate) } : { error: "zero output" };
    }
  });
  return out;
}
