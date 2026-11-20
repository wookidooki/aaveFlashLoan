// Venue adapters: verify a venue's contracts, discover pools for a token pair, and quote exact-input
// swaps at a fixed block. Quotes come from each venue's own on-chain quoter or pool math (or the
// injected CLQuoter, which runs the pool's real swap), so swap fees and price impact are already
// inside the quoted output and are never added again as costs.
import { decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { RPC_CONCURRENCY, cappedMulticallAt, mapLimit, multicallAt, shortError, type CallResult, type CallSpec } from "./chain.ts";

/** Per-quote gas cap: real quotes use ~0.1-1.8M; anything above this is a size the pool cannot carry. */
export const QUOTE_GAS_CAP = 5_000_000n;
import type { GasModelConfig, VenueConfig } from "./config.ts";
import { v2AmountOut } from "./quote/amm.ts";
import { LEG_KIND, clQuoterArtifact, encodeV4LegData, v4PoolId, type V4PoolKey } from "./sim/receiver.ts";

const V3_FACTORY = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const CL_TICK_FACTORY = parseAbi(["function getPool(address,address,int24) view returns (address)"]);
const SOLIDLY_FACTORY = parseAbi(["function getPool(address,address,bool) view returns (address)"]);
const V2_FACTORY = parseAbi(["function getPair(address,address) view returns (address)"]);
const ALGEBRA_FACTORY = parseAbi(["function poolByPair(address,address) view returns (address)"]);
const QUOTER_FACTORY = parseAbi(["function factory() view returns (address)"]);
const POOL_MANAGER_REF = parseAbi(["function poolManager() view returns (address)"]);
const CL_POOL = parseAbi(["function liquidity() view returns (uint128)"]);
const V2_PAIR = parseAbi(["function getReserves() view returns (uint112, uint112, uint32)"]);
const STATE_VIEW = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
]);
const POOL_GET_AMOUNT_OUT = parseAbi(["function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)"]);
// Quoter functions are not view on-chain (they revert internally), but are always eth_call'ed.
const QUOTER_V2 = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const SLIPSTREAM_QUOTER = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, int24 tickSpacing, uint160 sqrtPriceLimitX96) params) view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const V4_QUOTER = parseAbi([
  "function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) view returns (uint256 amountOut, uint256 gasEstimate)",
  "error NotEnoughLiquidity(bytes32 poolId)",
  "error UnexpectedRevertBytes(bytes revertData)",
]);
const ERC20_BAL = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** Where the injected CLQuoter's code is placed via state override (never deployed). */
export const INJECTED_QUOTER: Address = "0x5115000000000000000000000000000000000001";

export interface PoolInfo {
  /** Unique pool identity: the pool address, or the PoolId for Uniswap v4. */
  id: string;
  /** e.g. "uniswap-v3:500", "aerodrome-v2:volatile", "uniswap-v4:500/10:ETH" */
  label: string;
  venue: VenueConfig;
  /** Address the receiver calls: the pool, or the v4 PoolManager. */
  address: Address;
  /** Logical (ERC20) tokens, sorted; WETH stands in for native ETH. */
  token0: Address;
  token1: Address;
  /** fee tier, tick spacing, stable flag or v4 fee */
  param: number | boolean;
  legKind: number;
  feeBps: number;
  /** Leg.data for the receiver ("0x" except v4). */
  legData: Hex;
  v4Key?: V4PoolKey;
  /** v4 pool trades native ETH (WETH is unwrapped/wrapped around the swap). */
  native?: boolean;
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

async function hasCode(client: PublicClient, a: Address) {
  const code = await client.getCode({ address: a });
  return !!code && code !== "0x";
}

/** Contracts exist and quoters / views point at the configured factory or PoolManager. */
export async function verifyVenue(client: PublicClient, v: VenueConfig): Promise<VenueCheck> {
  if (v.type === "v4") {
    for (const [what, a] of [["poolManager", v.poolManager], ["quoter", v.quoter], ["stateView", v.stateView]] as const) {
      if (!(await hasCode(client, a))) return { ok: false, reason: `no contract at ${what} ${a}` };
    }
    for (const [what, a] of [["quoter", v.quoter], ["stateView", v.stateView]] as const) {
      try {
        const pm = await client.readContract({ address: a, abi: POOL_MANAGER_REF, functionName: "poolManager" });
        if (getAddress(pm) !== v.poolManager) return { ok: false, reason: `${what}.poolManager() is ${pm}, expected ${v.poolManager}` };
      } catch {
        return { ok: false, reason: `${what}.poolManager() unreadable` };
      }
    }
    return { ok: true };
  }
  if (!(await hasCode(client, v.factory))) return { ok: false, reason: `no contract at factory ${v.factory}` };
  if ((v.type === "v3" || v.type === "slipstream") && v.quoter !== "injected") {
    if (!(await hasCode(client, v.quoter))) return { ok: false, reason: `no contract at quoter ${v.quoter}` };
    try {
      const f = await client.readContract({ address: v.quoter, abi: QUOTER_FACTORY, functionName: "factory" });
      if (getAddress(f) !== v.factory) return { ok: false, reason: `quoter.factory() is ${f}, expected ${v.factory}` };
    } catch {
      return { ok: false, reason: `quoter.factory() unreadable` };
    }
  }
  return { ok: true };
}

function sortTokens(a: Address, b: Address): [Address, Address] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

export interface DepthFilter {
  /** Skip pools where either token side is worth less than this (USD). */
  minSideUsd: number;
  /** USD value of `amount` of `token`, or undefined if no price is available. */
  valueUsd: (token: Address, amount: bigint) => number | undefined;
}

function shallow(depth: DepthFilter | undefined, t0: Address, a0: bigint | undefined, t1: Address, a1: bigint | undefined): string | undefined {
  if (!depth || a0 === undefined || a1 === undefined) return undefined;
  const v0 = depth.valueUsd(t0, a0);
  const v1 = depth.valueUsd(t1, a1);
  if (v0 === undefined || v1 === undefined || Math.min(v0, v1) >= depth.minSideUsd) return undefined;
  return `too shallow: holds $${Math.round(v0).toLocaleString()} / $${Math.round(v1).toLocaleString()}, below the smallest loan ($${depth.minSideUsd.toLocaleString()})`;
}

const isCL = (v: VenueConfig) => v.type === "v3" || v.type === "slipstream" || v.type === "algebra";

function legKindFor(v: VenueConfig): number {
  switch (v.type) {
    case "v2":
      return LEG_KIND.v2;
    case "solidly":
    case "pair-getamountout":
      return LEG_KIND.solidly;
    case "algebra":
      return LEG_KIND.clAlgebra;
    case "v4":
      return LEG_KIND.v4;
    case "v3":
      return v.callback === "pancake" ? LEG_KIND.clPancakeCallback : LEG_KIND.clUniswapCallback;
    default:
      return LEG_KIND.clUniswapCallback;
  }
}

/** Discover pools for one pair on one venue, at a block. Returns pools plus skip records. */
export async function discoverPools(
  client: PublicClient,
  v: VenueConfig,
  a: Address,
  b: Address,
  pairName: string,
  blockNumber: bigint,
  depth?: DepthFilter,
  weth?: Address,
): Promise<{ pools: PoolInfo[]; skips: PoolSkip[] }> {
  if (v.type === "v4") return discoverV4(client, v, a, b, pairName, blockNumber, depth, weth);
  const [t0, t1] = sortTokens(a, b);
  const candidates: { label: string; param: number | boolean; call: CallSpec }[] = [];
  if (v.type === "v3") {
    for (const fee of v.fees) candidates.push({ label: `${v.id}:${fee}`, param: fee, call: { address: v.factory, abi: V3_FACTORY, functionName: "getPool", args: [t0, t1, fee] } });
  } else if (v.type === "slipstream") {
    for (const ts of v.tickSpacings) candidates.push({ label: `${v.id}:ts${ts}`, param: ts, call: { address: v.factory, abi: CL_TICK_FACTORY, functionName: "getPool", args: [t0, t1, ts] } });
  } else if (v.type === "solidly") {
    for (const stable of [false, true]) {
      candidates.push({ label: `${v.id}:${stable ? "stable" : "volatile"}`, param: stable, call: { address: v.factory, abi: SOLIDLY_FACTORY, functionName: "getPool", args: [t0, t1, stable] } });
    }
  } else if (v.type === "algebra") {
    candidates.push({ label: v.id, param: 0, call: { address: v.factory, abi: ALGEBRA_FACTORY, functionName: "poolByPair", args: [t0, t1] } });
  } else {
    candidates.push({ label: v.id, param: v.type === "v2" ? v.feeBps : 0, call: { address: v.factory, abi: V2_FACTORY, functionName: "getPair", args: [t0, t1] } });
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

  // Liveness: concentrated pools need in-range liquidity; pair pools need non-empty reserves.
  const live = await multicallAt(
    client,
    found.map(({ address }) => (isCL(v) ? { address, abi: CL_POOL, functionName: "liquidity" } : { address, abi: V2_PAIR, functionName: "getReserves" })),
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
    const empty = isCL(v) ? BigInt(r.value) === 0n : BigInt(r.value[0]) === 0n || BigInt(r.value[1]) === 0n;
    if (empty) return skips.push({ label: c.label, pair: pairName, reason: "no active liquidity" });
    const b0 = balances[2 * i];
    const b1 = balances[2 * i + 1];
    const tooShallow = depth ? shallow(depth, t0, b0?.ok ? BigInt(b0.value) : undefined, t1, b1?.ok ? BigInt(b1.value) : undefined) : undefined;
    if (tooShallow) return skips.push({ label: c.label, pair: pairName, reason: tooShallow });
    pools.push({
      id: address,
      label: c.label,
      venue: v,
      address,
      token0: t0,
      token1: t1,
      param: c.param,
      legKind: legKindFor(v),
      feeBps: v.type === "v2" ? v.feeBps : 0,
      legData: "0x",
    });
  });
  return { pools, skips };
}

const Q96 = 2n ** 96n;

/**
 * Uniswap v4: pools live in the PoolManager and are identified by PoolKey. Only hookless pools at
 * the configured (fee, tickSpacing) combinations are considered. When one side of the pair is the
 * chain's wrapped native token, the native-ETH pool (currency 0x0) is checked as well. Depth uses
 * the in-range virtual reserves L/sqrtP and L*sqrtP, since the singleton holds every pool's tokens.
 */
async function discoverV4(
  client: PublicClient,
  v: Extract<VenueConfig, { type: "v4" }>,
  a: Address,
  b: Address,
  pairName: string,
  blockNumber: bigint,
  depth?: DepthFilter,
  weth?: Address,
): Promise<{ pools: PoolInfo[]; skips: PoolSkip[] }> {
  const [t0, t1] = sortTokens(a, b);
  const options = (t: Address) => (weth && t === weth ? [t, zeroAddress] : [t]);
  const candidates: { label: string; key: V4PoolKey; native: boolean }[] = [];
  for (const ca of options(a)) {
    for (const cb of options(b)) {
      const [c0, c1] = sortTokens(ca as Address, cb as Address);
      const native = c0 === zeroAddress;
      for (const [fee, tickSpacing] of v.keys) {
        candidates.push({
          label: `${v.id}:${fee}/${tickSpacing}${native ? ":ETH" : ""}`,
          key: { currency0: c0, currency1: c1, fee, tickSpacing, hooks: zeroAddress },
          native,
        });
      }
    }
  }
  const ids = candidates.map((c) => v4PoolId(c.key));
  const res = await multicallAt(
    client,
    ids.flatMap((id) => [
      { address: v.stateView, abi: STATE_VIEW, functionName: "getSlot0", args: [id] },
      { address: v.stateView, abi: STATE_VIEW, functionName: "getLiquidity", args: [id] },
    ]),
    blockNumber,
  );
  const pools: PoolInfo[] = [];
  const skips: PoolSkip[] = [];
  const logical = (c: Address) => (c === zeroAddress ? weth! : c);
  candidates.forEach((c, i) => {
    const s0 = res[2 * i];
    const liq = res[2 * i + 1];
    if (!s0.ok || !liq.ok) return skips.push({ label: c.label, pair: pairName, reason: `state read failed: ${!s0.ok ? s0.error : (liq as any).error}` });
    const sqrtP = BigInt((s0.value as readonly unknown[])[0] as bigint);
    const L = BigInt(liq.value);
    if (sqrtP === 0n) return skips.push({ label: c.label, pair: pairName, reason: "pool does not exist (hookless key not initialized)" });
    if (L === 0n) return skips.push({ label: c.label, pair: pairName, reason: "no active liquidity" });
    const virt0 = (L * Q96) / sqrtP;
    const virt1 = (L * sqrtP) / Q96;
    const tooShallow = shallow(depth, logical(c.key.currency0), virt0, logical(c.key.currency1), virt1);
    if (tooShallow) return skips.push({ label: c.label, pair: pairName, reason: tooShallow.replace("holds", "in-range virtual reserves") });
    pools.push({
      id: ids[i],
      label: c.label,
      venue: v,
      address: v.poolManager,
      token0: t0,
      token1: t1,
      param: c.key.fee,
      legKind: LEG_KIND.v4,
      feeBps: 0,
      legData: encodeV4LegData(c.key, weth ?? zeroAddress),
      v4Key: c.key,
      native: c.native,
    });
  });
  return { pools, skips };
}

export interface Quote {
  amountOut: bigint;
  /** swap gas: quoter estimate (or measured by the injected quoter), configured constant otherwise */
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

type QuoteResult = Quote | { error: string };

/**
 * Quote many exact-input swaps at one block. v2 pairs are computed locally from reserves read at
 * the same block (exact integer math); everything else is an eth_call to the venue's quoter, the
 * pool's getAmountOut, or the injected CLQuoter.
 */
export async function quoteMany(
  client: PublicClient,
  reqs: QuoteRequest[],
  v2Reserves: V2Reserves,
  gasModel: GasModelConfig,
  blockNumber: bigint,
): Promise<QuoteResult[]> {
  const out: QuoteResult[] = new Array(reqs.length);
  const remote: { i: number; call: CallSpec }[] = [];
  const injected: number[] = [];
  reqs.forEach((q, i) => {
    const v = q.pool.venue;
    if (v.type === "v2") {
      const r = v2Reserves.get(q.pool.address);
      if (!r) return (out[i] = { error: "reserves unavailable" });
      const [rIn, rOut] = q.tokenIn === q.pool.token0 ? r : [r[1], r[0]];
      const amountOut = v2AmountOut(q.amountIn, rIn, rOut, BigInt(v.feeBps));
      out[i] = amountOut > 0n ? { amountOut, gas: BigInt(gasModel.v2SwapGas) } : { error: "zero output" };
    } else if (v.type === "solidly" || v.type === "pair-getamountout") {
      remote.push({ i, call: { address: q.pool.address, abi: POOL_GET_AMOUNT_OUT, functionName: "getAmountOut", args: [q.amountIn, q.tokenIn] } });
    } else if (v.type === "v4") {
      const key = q.pool.v4Key!;
      // In a native-ETH pool the only ERC20 currency is currency1; WETH in means ETH in.
      const cIn = q.pool.native && q.tokenIn !== key.currency1 ? zeroAddress : q.tokenIn;
      remote.push({
        i,
        call: {
          address: v.quoter,
          abi: V4_QUOTER,
          functionName: "quoteExactInputSingle",
          args: [{ poolKey: key, zeroForOne: cIn === key.currency0, exactAmount: q.amountIn, hookData: "0x" }],
        },
      });
    } else if (v.type === "algebra" || v.quoter === "injected") {
      injected.push(i);
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

  // Each quote runs with its own gas cap, so one heavy quote cannot starve or time out the rest.
  const res: CallResult[] = remote.length ? await cappedMulticallAt(client, remote.map((r) => r.call), blockNumber, QUOTE_GAS_CAP) : [];
  // Only quotes that never ran (batch budget, RPC rejection) are retried on their own.
  const retryable = res.map((r, k) => (!r.ok && /budget exhausted|rpc rejected/.test(r.error) ? k : -1)).filter((k) => k >= 0);
  if (retryable.length) {
    const retry = await cappedMulticallAt(client, retryable.map((k) => remote[k].call), blockNumber, QUOTE_GAS_CAP, 1);
    retryable.forEach((k, j) => (res[k] = retry[j]));
  }
  remote.forEach(({ i }, k) => {
    const r = res[k];
    const q = reqs[i];
    const v = q.pool.venue;
    if (!r.ok) return (out[i] = { error: `quote reverted: ${r.error}` });
    let amountOut: bigint;
    let gas: bigint;
    if (v.type === "solidly" || v.type === "pair-getamountout") {
      amountOut = BigInt(r.value);
      gas = BigInt(gasModel.solidlySwapGas);
    } else if (v.type === "v4") {
      const [o, g] = r.value as [bigint, bigint];
      amountOut = o;
      gas = g + (q.pool.native ? BigInt(gasModel.wrapGas) : 0n);
    } else {
      const [o, , , g] = r.value as [bigint, bigint, number, bigint];
      amountOut = o;
      gas = g;
    }
    out[i] = amountOut > 0n ? { amountOut, gas } : { error: "zero output" };
  });

  if (injected.length) {
    const results = await injectedQuotes(client, injected.map((i) => reqs[i]), blockNumber);
    injected.forEach((i, k) => (out[i] = results[k]));
  }
  return out;
}

/** Quote CL pools through the CLQuoter code injected by state override, in chunks, retrying alone. */
async function injectedQuotes(client: PublicClient, reqs: QuoteRequest[], blockNumber: bigint): Promise<QuoteResult[]> {
  const art = clQuoterArtifact();
  const asReq = (q: QuoteRequest) => ({ pool: q.pool.address, zeroForOne: q.tokenIn === q.pool.token0, amountIn: q.amountIn });
  const run = async (slice: QuoteRequest[]): Promise<QuoteResult[]> => {
    try {
      const { data } = await client.call({
        to: INJECTED_QUOTER,
        data: encodeFunctionData({ abi: art.abi, functionName: "quoteMany", args: [slice.map(asReq), QUOTE_GAS_CAP] }),
        blockNumber,
        stateOverride: [{ address: INJECTED_QUOTER, code: art.deployedBytecode }],
      });
      const rows = decodeFunctionResult({ abi: art.abi, functionName: "quoteMany", data: data! }) as readonly { ok: boolean; amountOut: bigint; gasUsed: bigint }[];
      return rows.map((r) => (r.ok && r.amountOut > 0n ? { amountOut: r.amountOut, gas: r.gasUsed } : { error: "pool swap did not fill the exact input" }));
    } catch (e) {
      if (slice.length === 1) return [{ error: `injected quote failed: ${shortError(e)}` }];
      const mid = Math.ceil(slice.length / 2);
      return [...(await run(slice.slice(0, mid))), ...(await run(slice.slice(mid)))];
    }
  };
  const chunks: QuoteRequest[][] = [];
  for (let i = 0; i < reqs.length; i += 10) chunks.push(reqs.slice(i, i + 10));
  const out: QuoteResult[] = (await mapLimit(chunks, RPC_CONCURRENCY, run)).flat();
  // A quote starved of gas inside the batch reports a failed fill; confirm failures alone.
  const failedIdx = out.map((r, k) => ("error" in r ? k : -1)).filter((k) => k >= 0);
  const alone = await mapLimit(failedIdx, RPC_CONCURRENCY, (k) => run([reqs[k]]));
  failedIdx.forEach((k, j) => {
    const [r] = alone[j];
    out[k] = "error" in r ? { error: `${r.error} (also alone)` } : r;
  });
  return out;
}
