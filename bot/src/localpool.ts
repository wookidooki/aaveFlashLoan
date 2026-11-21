// Local pool models for exact off-chain quoting. Per block, one batched read (stateReads) gives
// each pool's price/tick/liquidity/fee or reserves; TickCache holds the initialized ticks near the
// current price for concentrated pools. localQuote then reproduces the pool's exact-input swap.
import { parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { multicallAt, type CallResult, type CallSpec } from "./chain.ts";
import { MissingTickData, swapExactIn, type ClState, type TickData } from "./quote/v3math.ts";
import { solidlyStableAmountOut, v2AmountOut } from "./quote/amm.ts";
import type { PoolInfo } from "./venues.ts";

const SLOT0 = parseAbi(["function slot0() view returns (uint160 sqrtPriceX96, int24 tick)"]); // leading fields only
const LIQUIDITY = parseAbi(["function liquidity() view returns (uint128)"]);
const FEE = parseAbi(["function fee() view returns (uint24)"]);
const TICK_SPACING = parseAbi(["function tickSpacing() view returns (int24)"]);
const BITMAP = parseAbi(["function tickBitmap(int16) view returns (uint256)"]);
const TICKS = parseAbi(["function ticks(int24) view returns (uint128 liquidityGross, int128 liquidityNet)"]); // leading fields only
const RESERVES = parseAbi(["function getReserves() view returns (uint112, uint112, uint32)"]);
const GET_AMOUNT_OUT = parseAbi(["function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)"]);
const STATE_VIEW = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
  "function getTickBitmap(bytes32 poolId, int16 wordPos) view returns (uint256)",
  "function getTickLiquidity(bytes32 poolId, int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet)",
]);
const ALGEBRA = parseAbi(["function globalState() view returns (uint160 price)"]);
const SOLIDLY_FEE = parseAbi(["function getFee(address pool, bool stable) view returns (uint256)"]);
const SOLIDLY_META = parseAbi(["function metadata() view returns (uint256 dec0, uint256 dec1, uint256 r0, uint256 r1, bool st, address t0, address t1)"]);

const isV3Like = (p: PoolInfo) => p.venue.type === "v3" || p.venue.type === "slipstream";

/** The per-block reads for one pool (also used to detect which pools changed). */
export function stateReads(p: PoolInfo, probe: (token: Address) => bigint): CallSpec[] {
  const v = p.venue;
  if (v.type === "v4") {
    return [
      { address: v.stateView, abi: STATE_VIEW, functionName: "getSlot0", args: [p.id as Hex] },
      { address: v.stateView, abi: STATE_VIEW, functionName: "getLiquidity", args: [p.id as Hex] },
    ];
  }
  if (v.type === "v2") return [{ address: p.address, abi: RESERVES, functionName: "getReserves" }];
  if (v.type === "solidly" || v.type === "pair-getamountout") {
    const calls: CallSpec[] = [
      { address: p.address, abi: RESERVES, functionName: "getReserves" },
      { address: p.address, abi: GET_AMOUNT_OUT, functionName: "getAmountOut", args: [probe(p.token0), p.token0] },
      { address: p.address, abi: GET_AMOUNT_OUT, functionName: "getAmountOut", args: [probe(p.token1), p.token1] },
    ];
    // Aerodrome/Velodrome v2: per-pool fee in bps from the factory (used for the volatile x*y=k model).
    if (v.type === "solidly") calls.push({ address: v.factory, abi: SOLIDLY_FEE, functionName: "getFee", args: [p.address, p.param as boolean] });
    // Stable pools: token decimals as the pool stores them (10**decimals), for the x^3y+xy^3 curve.
    if (v.type === "solidly" && p.param === true) calls.push({ address: p.address, abi: SOLIDLY_META, functionName: "metadata" });
    return calls;
  }
  if (v.type === "slipstream") {
    return [
      { address: p.address, abi: SLOT0, functionName: "slot0" },
      { address: p.address, abi: LIQUIDITY, functionName: "liquidity" },
      { address: p.address, abi: FEE, functionName: "fee" },
    ];
  }
  if (v.type === "v3") {
    return [
      { address: p.address, abi: SLOT0, functionName: "slot0" },
      { address: p.address, abi: LIQUIDITY, functionName: "liquidity" },
    ];
  }
  return [{ address: p.address, abi: ALGEBRA, functionName: "globalState" }];
}

export interface PoolSnapshot {
  pool: PoolInfo;
  /** concentrated pools: state in the pool's own currency order (v4: currency0/currency1) */
  cl?: ClState;
  /** v2 pairs: reserves in token order */
  reserves?: [bigint, bigint];
  /** probe outputs for getAmountOut pools (marginal rate only) */
  probeOut?: [bigint, bigint];
  /** Aerodrome/Velodrome v2 fee in bps (factory.getFee) */
  solidlyFeeBps?: bigint;
  /** Aerodrome/Velodrome v2 stable pools: [10**decimals0, 10**decimals1] */
  solidlyDecimals?: [bigint, bigint];
  ok: boolean;
}

export function parseSnapshot(p: PoolInfo, res: CallResult[]): PoolSnapshot {
  if (res.some((r) => !r.ok)) return { pool: p, ok: false };
  const val = (i: number) => (res[i] as { ok: true; value: any }).value;
  const v = p.venue;
  if (v.type === "v4") {
    const [sqrt, tick, protocolFee, lpFee] = val(0) as [bigint, number, number, number];
    // v4: swap fee = protocolFee + lpFee - protocolFee * lpFee / 1e6 (direction-specific protocol fee
    // is applied per swap in localQuote; here the LP part is kept and protocol fees stored separately)
    return { pool: p, ok: true, cl: { sqrtPriceX96: sqrt, tick: Number(tick), liquidity: BigInt(val(1)), feePips: BigInt(lpFee), protocolFee: Number(protocolFee) } as ClState & { protocolFee: number } };
  }
  if (isV3Like(p)) {
    const [sqrt, tick] = val(0) as [bigint, number];
    const fee = v.type === "slipstream" ? BigInt(val(2)) : BigInt(Number(p.param));
    return { pool: p, ok: true, cl: { sqrtPriceX96: sqrt, tick: Number(tick), liquidity: BigInt(val(1)), feePips: fee } };
  }
  if (v.type === "v2") {
    const [r0, r1] = val(0) as [bigint, bigint];
    return { pool: p, ok: true, reserves: [BigInt(r0), BigInt(r1)] };
  }
  if (v.type === "solidly" || v.type === "pair-getamountout") {
    const [r0, r1] = val(0) as [bigint, bigint];
    return {
      pool: p,
      ok: true,
      reserves: [BigInt(r0), BigInt(r1)],
      probeOut: [BigInt(val(1)), BigInt(val(2))],
      solidlyFeeBps: v.type === "solidly" ? BigInt(val(3)) : undefined,
      solidlyDecimals: v.type === "solidly" && p.param === true ? [BigInt(val(4)[0]), BigInt(val(4)[1])] : undefined,
    };
  }
  return { pool: p, ok: true };
}

/** For v4, the pool's currency0 in logical (ERC20) terms; for everything else token0. */
function logicalCurrency0(p: PoolInfo): Address {
  if (p.venue.type !== "v4") return p.token0;
  const key = p.v4Key!;
  return key.currency0 === zeroAddress ? (p.token0 === key.currency1 ? p.token1 : p.token0) : key.currency0;
}

/** v4 swap fee for a direction: protocolFee + lpFee - protocolFee * lpFee / 1e6 (Uniswap v4 ProtocolFeeLibrary). */
function v4Fee(lpFee: bigint, protocolFee: number, zeroForOne: boolean): bigint {
  const pf = BigInt(zeroForOne ? protocolFee & 0xfff : protocolFee >> 12);
  return pf === 0n ? lpFee : pf + lpFee - (pf * lpFee) / 1_000_000n;
}

// ---------------------------------------------------------------- marginal rates

/**
 * Marginal (best possible) rates from a snapshot, in raw token units: r01 = token1 out per token0 in,
 * r10 = token0 out per token1 in. getAmountOut pools use their $1 probe output (a bound for every
 * size >= $1). Undefined when there is no local model (Algebra) or the read failed.
 */
export function marginalFromSnapshot(snap: PoolSnapshot | undefined, probe: (t: Address) => bigint): { r01: number; r10: number } | undefined {
  if (!snap?.ok) return undefined;
  const p = snap.pool;
  if (snap.cl) {
    const sqrt = Number(snap.cl.sqrtPriceX96) / 2 ** 96;
    const price = sqrt * sqrt; // currency1 per currency0
    if (!(price > 0)) return undefined;
    const fee = (zf: boolean) =>
      Number(p.venue.type === "v4" ? v4Fee(snap.cl!.feePips, (snap.cl as any).protocolFee ?? 0, zf) : snap.cl!.feePips) / 1e6;
    const c01 = price * (1 - fee(true));
    const c10 = (1 / price) * (1 - fee(false));
    return logicalCurrency0(p) === p.token0 ? { r01: c01, r10: c10 } : { r01: c10, r10: c01 };
  }
  if (p.venue.type === "v2" && snap.reserves) {
    const [r0, r1] = snap.reserves;
    const f = 1 - p.venue.feeBps / 1e4;
    return r0 > 0n && r1 > 0n ? { r01: (Number(r1) / Number(r0)) * f, r10: (Number(r0) / Number(r1)) * f } : undefined;
  }
  if (snap.probeOut) {
    const [o0, o1] = snap.probeOut;
    return o0 > 0n && o1 > 0n ? { r01: Number(o0) / Number(probe(p.token0)), r10: Number(o1) / Number(probe(p.token1)) } : undefined;
  }
  return undefined;
}

/** Errors that mean "no exact local answer here, ask the RPC" rather than "this size cannot work". */
const FALLBACK = /no tick data|leaves cached tick range|no local model|stable-curve|no state/;

/** A LocalQuoter (scanner.ts) over this block's snapshots and the tick cache. */
export function makeLocalQuoter(snaps: Map<string, PoolSnapshot>, ticks: TickCache, v2Gas: bigint, only: boolean) {
  return {
    only,
    quote: (req: { pool: PoolInfo; tokenIn: Address; amountIn: bigint }) => {
      const q = localQuote(snaps.get(req.pool.id), ticks, req.tokenIn, req.amountIn, v2Gas);
      return "error" in q ? { error: q.error, fallback: FALLBACK.test(q.error) } : q;
    },
  };
}

// ---------------------------------------------------------------- tick cache

const WORDS_EACH_SIDE = 3;

interface CachedTicks extends TickData {
  centerWord: number;
  fetchedAt: number;
  block: bigint;
}

export class TickCache {
  private cache = new Map<string, CachedTicks>();
  private inflight = new Map<string, Promise<void>>();

  get(id: string): CachedTicks | undefined {
    return this.cache.get(id);
  }

  /** Fetch bitmap words around `tick` and the liquidityNet of every initialized tick in them, at `block`. */
  async fetch(client: PublicClient, p: PoolInfo, tick: number, block: bigint): Promise<void> {
    if (this.inflight.has(p.id)) return this.inflight.get(p.id);
    const job = (async () => {
      const spacing = p.venue.type === "v4" ? p.v4Key!.tickSpacing : await this.spacing(client, p, block);
      let compressed = Math.trunc(tick / spacing);
      if (tick < 0 && tick % spacing !== 0) compressed--;
      const center = compressed >> 8;
      const wordPositions = Array.from({ length: 2 * WORDS_EACH_SIDE + 1 }, (_, i) => center - WORDS_EACH_SIDE + i);
      const bitmapCalls: CallSpec[] = wordPositions.map((w) =>
        p.venue.type === "v4"
          ? { address: p.venue.stateView, abi: STATE_VIEW, functionName: "getTickBitmap", args: [p.id as Hex, w] }
          : { address: p.address, abi: BITMAP, functionName: "tickBitmap", args: [w] },
      );
      const words = await multicallAt(client, bitmapCalls, block, 50);
      const wordMap = new Map<number, bigint>();
      const initTicks: number[] = [];
      words.forEach((r, i) => {
        if (!r.ok) return;
        const word = BigInt(r.value);
        wordMap.set(wordPositions[i], word);
        for (let bit = 0; bit < 256; bit++) if ((word >> BigInt(bit)) & 1n) initTicks.push(((wordPositions[i] << 8) + bit) * spacing);
      });
      const tickCalls: CallSpec[] = initTicks.map((t) =>
        p.venue.type === "v4"
          ? { address: p.venue.stateView, abi: STATE_VIEW, functionName: "getTickLiquidity", args: [p.id as Hex, t] }
          : { address: p.address, abi: TICKS, functionName: "ticks", args: [t] },
      );
      const tickRes = initTicks.length ? await multicallAt(client, tickCalls, block, 80) : [];
      const net = new Map<number, bigint>();
      tickRes.forEach((r, i) => {
        if (r.ok) net.set(initTicks[i], BigInt((r.value as readonly [bigint, bigint])[1]));
      });
      this.cache.set(p.id, { tickSpacing: spacing, words: wordMap, liquidityNet: net, centerWord: center, fetchedAt: Date.now(), block });
    })();
    this.inflight.set(p.id, job);
    try {
      await job;
    } finally {
      this.inflight.delete(p.id);
    }
  }

  private spacings = new Map<string, number>();
  private async spacing(client: PublicClient, p: PoolInfo, block: bigint): Promise<number> {
    if (!this.spacings.has(p.id)) {
      const s = await client.readContract({ address: p.address, abi: TICK_SPACING, functionName: "tickSpacing", blockNumber: block });
      this.spacings.set(p.id, Number(s));
    }
    return this.spacings.get(p.id)!;
  }

  /** Whether the cache for a pool needs a refresh: missing, old, or price moved far from its center. */
  stale(p: PoolInfo, tick: number, maxAgeMs: number): boolean {
    const c = this.cache.get(p.id);
    if (!c) return true;
    if (Date.now() - c.fetchedAt > maxAgeMs) return true;
    let compressed = Math.trunc(tick / c.tickSpacing);
    if (tick < 0 && tick % c.tickSpacing !== 0) compressed--;
    return Math.abs((compressed >> 8) - c.centerWord) >= WORDS_EACH_SIDE - 1;
  }
}

// ---------------------------------------------------------------- local quote

export type LocalQuote = { amountOut: bigint; gas: bigint } | { error: string; needsTicks?: boolean };

/**
 * Exact-input quote computed locally. Concentrated pools: Pool.swap math over cached ticks (gas:
 * 90k + 25k per initialized tick crossed). v2 pairs: exact getAmountOut. Other venues: no local model.
 */
export function localQuote(snap: PoolSnapshot | undefined, ticks: TickCache, tokenIn: Address, amountIn: bigint, v2Gas: bigint): LocalQuote {
  if (!snap?.ok) return { error: "no state" };
  const p = snap.pool;
  if (snap.cl) {
    const t = ticks.get(p.id);
    if (!t) return { error: "no tick data", needsTicks: true };
    const zeroForOne = tokenIn === logicalCurrency0(p);
    const state =
      p.venue.type === "v4"
        ? { ...snap.cl, feePips: v4Fee(snap.cl.feePips, (snap.cl as any).protocolFee ?? 0, zeroForOne) }
        : snap.cl;
    try {
      const r = swapExactIn(state, t, zeroForOne, amountIn);
      if (!r.filled) return { error: "pool cannot fill this size" };
      return { amountOut: r.amountOut, gas: 90_000n + 25_000n * BigInt(r.ticksCrossed) + (p.native ? 30_000n : 0n) };
    } catch (e) {
      if (e instanceof MissingTickData) return { error: "swap leaves cached tick range", needsTicks: true };
      throw e;
    }
  }
  if (p.venue.type === "v2" && snap.reserves) {
    const [r0, r1] = snap.reserves;
    const out = tokenIn === p.token0 ? v2AmountOut(amountIn, r0, r1, BigInt(p.venue.feeBps)) : v2AmountOut(amountIn, r1, r0, BigInt(p.venue.feeBps));
    return out > 0n ? { amountOut: out, gas: v2Gas } : { error: "zero output" };
  }
  // Aerodrome/Velodrome v2 volatile pools (Pool.getAmountOut): amountIn -= amountIn * fee / 10000,
  // then x*y=k on reserves. Stable pools: x^3y+xy^3 (solidlyStableAmountOut).
  if (p.venue.type === "solidly" && p.param === false && snap.reserves && snap.solidlyFeeBps !== undefined) {
    const [r0, r1] = snap.reserves;
    const [rIn, rOut] = tokenIn === p.token0 ? [r0, r1] : [r1, r0];
    const net = amountIn - (amountIn * snap.solidlyFeeBps) / 10_000n;
    const out = (net * rOut) / (rIn + net);
    return out > 0n ? { amountOut: out, gas: 90_000n } : { error: "zero output" };
  }
  if (p.venue.type === "solidly" && p.param === true && snap.reserves && snap.solidlyFeeBps !== undefined && snap.solidlyDecimals) {
    const [r0, r1] = snap.reserves;
    try {
      const out = solidlyStableAmountOut(amountIn, snap.solidlyFeeBps, tokenIn === p.token0, r0, r1, ...snap.solidlyDecimals);
      return out > 0n ? { amountOut: out, gas: 110_000n } : { error: "zero output" };
    } catch {
      return { error: "pool cannot fill this size" };
    }
  }
  return { error: p.venue.type === "solidly" ? "stable-curve pool without state (RPC quote)" : "no local model for this venue" };
}
