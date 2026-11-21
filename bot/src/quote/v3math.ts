// Exact bigint port of the Uniswap v3 core math used inside Pool.swap (TickMath, FullMath,
// SqrtPriceMath, SwapMath, TickBitmap.nextInitializedTickWithinOneWord). The same algorithm runs
// in Uniswap v3, SushiSwap v3, PancakeSwap v3, Aerodrome/Velodrome Slipstream and Uniswap v4, so an
// exact-input swap quoted here matches the pool's own result to the last unit, given the same
// state (price, tick, liquidity, fee, and the initialized ticks it crosses).

export const Q96 = 1n << 96n;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

// ---------------------------------------------------------------- FullMath

export function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  return (a * b) / d;
}

export function mulDivRoundingUp(a: bigint, b: bigint, d: bigint): bigint {
  const p = a * b;
  return p / d + (p % d > 0n ? 1n : 0n);
}

function divRoundingUp(a: bigint, b: bigint): bigint {
  return a / b + (a % b > 0n ? 1n : 0n);
}

// ---------------------------------------------------------------- TickMath

const TICK_MAGIC: [number, bigint][] = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
];

export function getSqrtRatioAtTick(tick: number): bigint {
  const absTick = Math.abs(tick);
  if (absTick > MAX_TICK) throw new Error("tick out of range");
  let ratio = absTick & 0x1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  for (const [bit, magic] of TICK_MAGIC) if (absTick & bit) ratio = (ratio * magic) >> 128n;
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

// ---------------------------------------------------------------- SqrtPriceMath

function nextSqrtFromAmount0RoundingUp(sqrtP: bigint, liquidity: bigint, amount: bigint): bigint {
  if (amount === 0n) return sqrtP;
  const numerator1 = liquidity << 96n;
  const product = amount * sqrtP;
  if (product <= MAX_UINT256) {
    const denominator = numerator1 + product;
    if (denominator <= MAX_UINT256 && denominator >= numerator1) return mulDivRoundingUp(numerator1, sqrtP, denominator);
  }
  return divRoundingUp(numerator1, numerator1 / sqrtP + amount);
}

function nextSqrtFromAmount1RoundingDown(sqrtP: bigint, liquidity: bigint, amount: bigint): bigint {
  const quotient = amount <= MAX_UINT160 ? (amount << 96n) / liquidity : mulDiv(amount, Q96, liquidity);
  return sqrtP + quotient;
}

function nextSqrtFromInput(sqrtP: bigint, liquidity: bigint, amountIn: bigint, zeroForOne: boolean): bigint {
  return zeroForOne ? nextSqrtFromAmount0RoundingUp(sqrtP, liquidity, amountIn) : nextSqrtFromAmount1RoundingDown(sqrtP, liquidity, amountIn);
}

export function getAmount0Delta(a: bigint, b: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [lo, hi] = a > b ? [b, a] : [a, b];
  const numerator1 = liquidity << 96n;
  const numerator2 = hi - lo;
  return roundUp ? divRoundingUp(mulDivRoundingUp(numerator1, numerator2, hi), lo) : mulDiv(numerator1, numerator2, hi) / lo;
}

export function getAmount1Delta(a: bigint, b: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [lo, hi] = a > b ? [b, a] : [a, b];
  return roundUp ? mulDivRoundingUp(liquidity, hi - lo, Q96) : mulDiv(liquidity, hi - lo, Q96);
}

// ---------------------------------------------------------------- SwapMath (exact input only)

export function computeSwapStepExactIn(
  sqrtCurrent: bigint,
  sqrtTarget: bigint,
  liquidity: bigint,
  amountRemaining: bigint,
  feePips: bigint,
): { sqrtNext: bigint; amountIn: bigint; amountOut: bigint; feeAmount: bigint } {
  const zeroForOne = sqrtCurrent >= sqrtTarget;
  const lessFee = mulDiv(amountRemaining, 1_000_000n - feePips, 1_000_000n);
  let amountIn = zeroForOne ? getAmount0Delta(sqrtTarget, sqrtCurrent, liquidity, true) : getAmount1Delta(sqrtCurrent, sqrtTarget, liquidity, true);
  const sqrtNext = lessFee >= amountIn ? sqrtTarget : nextSqrtFromInput(sqrtCurrent, liquidity, lessFee, zeroForOne);
  const max = sqrtTarget === sqrtNext;
  let amountOut: bigint;
  if (zeroForOne) {
    if (!max) amountIn = getAmount0Delta(sqrtNext, sqrtCurrent, liquidity, true);
    amountOut = getAmount1Delta(sqrtNext, sqrtCurrent, liquidity, false);
  } else {
    if (!max) amountIn = getAmount1Delta(sqrtCurrent, sqrtNext, liquidity, true);
    amountOut = getAmount0Delta(sqrtCurrent, sqrtNext, liquidity, false);
  }
  const feeAmount = sqrtNext !== sqrtTarget ? amountRemaining - amountIn : mulDivRoundingUp(amountIn, feePips, 1_000_000n - feePips);
  return { sqrtNext, amountIn, amountOut, feeAmount };
}

// ---------------------------------------------------------------- TickBitmap

function msb(x: bigint): number {
  return x.toString(2).length - 1;
}

function lsb(x: bigint): number {
  return msb(x & -x);
}

/** Initialized-tick data for one pool: bitmap words and liquidityNet per initialized tick. */
export interface TickData {
  tickSpacing: number;
  words: Map<number, bigint>; // wordPos -> 256-bit word
  liquidityNet: Map<number, bigint>; // tick -> liquidityNet
}

export class MissingTickData extends Error {}

function nextInitializedTickWithinOneWord(t: TickData, tick: number, lte: boolean): { next: number; initialized: boolean } {
  const s = t.tickSpacing;
  let compressed = Math.trunc(tick / s);
  if (tick < 0 && tick % s !== 0) compressed--;
  if (lte) {
    const wordPos = compressed >> 8;
    const bitPos = ((compressed % 256) + 256) % 256;
    const word = t.words.get(wordPos);
    if (word === undefined) throw new MissingTickData(`word ${wordPos}`);
    const mask = (1n << BigInt(bitPos)) - 1n + (1n << BigInt(bitPos));
    const masked = word & mask;
    const initialized = masked !== 0n;
    return { next: initialized ? (compressed - (bitPos - msb(masked))) * s : (compressed - bitPos) * s, initialized };
  }
  const c1 = compressed + 1;
  const wordPos = c1 >> 8;
  const bitPos = ((c1 % 256) + 256) % 256;
  const word = t.words.get(wordPos);
  if (word === undefined) throw new MissingTickData(`word ${wordPos}`);
  const mask = ~((1n << BigInt(bitPos)) - 1n) & MAX_UINT256;
  const masked = word & mask;
  const initialized = masked !== 0n;
  return { next: initialized ? (c1 + (lsb(masked) - bitPos)) * s : (c1 + (255 - bitPos)) * s, initialized };
}

// ---------------------------------------------------------------- Pool.swap (exact input)

export interface ClState {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  feePips: bigint;
}

/**
 * Exact-input swap through a concentrated-liquidity pool, as Pool.swap computes it with the price
 * limit at the extreme (as the quoters and our receiver use). Throws MissingTickData if the swap
 * walks into a bitmap word that is not cached.
 */
export function swapExactIn(
  s: ClState,
  ticks: TickData,
  zeroForOne: boolean,
  amountIn: bigint,
): { amountOut: bigint; ticksCrossed: number; filled: boolean } {
  const limit = zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;
  let remaining = amountIn;
  let amountOut = 0n;
  let sqrtP = s.sqrtPriceX96;
  let tick = s.tick;
  let liquidity = s.liquidity;
  let crossed = 0;
  while (remaining !== 0n && sqrtP !== limit) {
    let { next, initialized } = nextInitializedTickWithinOneWord(ticks, tick, zeroForOne);
    if (next < MIN_TICK) next = MIN_TICK;
    else if (next > MAX_TICK) next = MAX_TICK;
    const sqrtNext = getSqrtRatioAtTick(next);
    const target = (zeroForOne ? sqrtNext < limit : sqrtNext > limit) ? limit : sqrtNext;
    const step = computeSwapStepExactIn(sqrtP, target, liquidity, remaining, s.feePips);
    remaining -= step.amountIn + step.feeAmount;
    amountOut += step.amountOut;
    sqrtP = step.sqrtNext;
    if (sqrtP === sqrtNext) {
      if (initialized) {
        const net = ticks.liquidityNet.get(next);
        if (net === undefined) throw new MissingTickData(`tick ${next}`);
        liquidity = zeroForOne ? liquidity - net : liquidity + net;
        crossed++;
      }
      tick = zeroForOne ? next - 1 : next;
    } else {
      break; // input exhausted inside this step
    }
  }
  return { amountOut, ticksCrossed: crossed, filled: remaining === 0n };
}
