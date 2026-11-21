// Local marginal rates from pool state, so a block can be screened with ONE batched read instead of
// quoting every route. A pool's marginal rate is the output per unit of input for an infinitesimal
// trade: spot price x (1 - fee). For exact-input swaps the realised rate at any size is never
// better, so rate(first leg) x rate(second leg) bounds a route's round-trip rate from above.
import { parseAbi, type Address, type Hex } from "viem";
import type { CallResult, CallSpec } from "./chain.ts";
import type { PoolInfo } from "./venues.ts";

const SLOT0 = parseAbi(["function slot0() view returns (uint160 sqrtPriceX96)"]); // first word only
const FEE = parseAbi(["function fee() view returns (uint24)"]);
const RESERVES = parseAbi(["function getReserves() view returns (uint112, uint112, uint32)"]);
const GET_AMOUNT_OUT = parseAbi(["function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)"]);
const STATE_VIEW = parseAbi(["function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)"]);
const Q96 = 2 ** 96;

export interface PoolStateReads {
  pool: PoolInfo;
  calls: CallSpec[];
}

/** Calls that capture a pool's state (also used to detect which pools changed in a block). */
export function stateCalls(p: PoolInfo, probe: (token: Address) => bigint): PoolStateReads {
  const v = p.venue;
  if (v.type === "v4") return { pool: p, calls: [{ address: v.stateView, abi: STATE_VIEW, functionName: "getSlot0", args: [p.id as Hex] }] };
  if (v.type === "v2") return { pool: p, calls: [{ address: p.address, abi: RESERVES, functionName: "getReserves" }] };
  if (v.type === "solidly" || v.type === "pair-getamountout") {
    return {
      pool: p,
      calls: [
        { address: p.address, abi: RESERVES, functionName: "getReserves" },
        { address: p.address, abi: GET_AMOUNT_OUT, functionName: "getAmountOut", args: [probe(p.token0), p.token0] },
        { address: p.address, abi: GET_AMOUNT_OUT, functionName: "getAmountOut", args: [probe(p.token1), p.token1] },
      ],
    };
  }
  if (v.type === "slipstream") {
    return { pool: p, calls: [{ address: p.address, abi: SLOT0, functionName: "slot0" }, { address: p.address, abi: FEE, functionName: "fee" }] };
  }
  if (v.type === "v3") return { pool: p, calls: [{ address: p.address, abi: SLOT0, functionName: "slot0" }] };
  // Algebra: fee layout differs between deployments; detect changes from its price only and let the
  // route be quoted (no local rate).
  return { pool: p, calls: [{ address: p.address, abi: parseAbi(["function globalState() view returns (uint160 price)"]), functionName: "globalState" }] };
}

/**
 * Marginal rates in raw token units: r01 = token1 out per token0 in, r10 = token0 out per token1 in.
 * Undefined when the state could not be read or the venue has no local model.
 */
export function marginalRates(p: PoolInfo, res: CallResult[], probe: (token: Address) => bigint): { r01: number; r10: number } | undefined {
  if (res.some((r) => !r.ok)) return undefined;
  const v = p.venue;
  const pips = (x: number) => 1 - x / 1e6;
  if (v.type === "v3" || v.type === "slipstream") {
    const sqrt = Number((res[0] as any).value) / Q96;
    const price = sqrt * sqrt; // token1 per token0
    const fee = v.type === "slipstream" ? Number((res[1] as any).value) : Number(p.param);
    return price > 0 ? { r01: price * pips(fee), r10: (1 / price) * pips(fee) } : undefined;
  }
  if (v.type === "v4") {
    const [sqrtP, , protocolFee, lpFee] = (res[0] as any).value as [bigint, number, number, number];
    const sqrt = Number(sqrtP) / Q96;
    const price = sqrt * sqrt;
    // protocolFee packs the zeroForOne fee in the low 12 bits and oneForZero in the high 12 bits;
    // the swap fee is protocolFee + lpFee - protocolFee * lpFee / 1e6.
    const total = (pf: number) => pf + Number(lpFee) - (pf * Number(lpFee)) / 1e6;
    const pf01 = Number(protocolFee) & 0xfff;
    const pf10 = Number(protocolFee) >> 12;
    if (!(price > 0)) return undefined;
    const c01 = price * pips(total(pf01)); // currency1 per currency0
    const c10 = (1 / price) * pips(total(pf10));
    // Map pool currencies to the logical (sorted ERC20) tokens; native ETH (0x0) is the WETH side.
    const key = p.v4Key!;
    const c0Logical = key.currency0 === "0x0000000000000000000000000000000000000000" ? (p.token0 === key.currency1 ? p.token1 : p.token0) : key.currency0;
    return c0Logical === p.token0 ? { r01: c01, r10: c10 } : { r01: c10, r10: c01 };
  }
  if (v.type === "v2") {
    const [r0, r1] = (res[0] as any).value as [bigint, bigint];
    const f = 1 - v.feeBps / 1e4;
    return r0 > 0n && r1 > 0n ? { r01: (Number(r1) / Number(r0)) * f, r10: (Number(r0) / Number(r1)) * f } : undefined;
  }
  if (v.type === "solidly" || v.type === "pair-getamountout") {
    const o0 = Number((res[1] as any).value);
    const o1 = Number((res[2] as any).value);
    const a0 = Number(probe(p.token0));
    const a1 = Number(probe(p.token1));
    return o0 > 0 && o1 > 0 ? { r01: o0 / a0, r10: o1 / a1 } : undefined;
  }
  return undefined;
}

/** Rate for swapping tokenIn -> the other token of the pool. */
export function rateFor(p: PoolInfo, rates: { r01: number; r10: number }, tokenIn: Address): number {
  return tokenIn === p.token0 ? rates.r01 : rates.r10;
}
