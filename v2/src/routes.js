// Turns scanner pools into the Hop structs that FlashArb and ArbQuoter use.
export const KIND = { v2: 0, solidly: 1, v3: 2, cl: 2 };

/** @param {{kind:string,address:string,feeBps?:number}} pool */
export function hop(pool, tokenIn, tokenOut) {
  return {
    kind: KIND[pool.kind],
    pool: pool.address,
    tokenIn,
    tokenOut,
    feeBps: pool.kind === 'v2' ? pool.feeBps : 0,
  };
}
