// Exact integer quote helpers for venues whose math is reproducible off-chain.

/** Uniswap v2 style getAmountOut with the fee in basis points (30 = 0.3%). Matches FlashArbReceiverV3 KIND_V2. */
export function v2AmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const inWithFee = amountIn * (10000n - feeBps);
  return (inWithFee * reserveOut) / (reserveIn * 10000n + inWithFee);
}

/**
 * Aave v3 flash-loan premium, rounded up: ceil(amount * bps / 10000). Observed on Base mainnet at block
 * 60266542: 1000064624 at 5 bps was charged 500033 (half-up rounding would give 500032).
 */
export function aaveV3Premium(amount: bigint, premiumBps: bigint): bigint {
  return (amount * premiumBps + 9999n) / 10000n;
}
