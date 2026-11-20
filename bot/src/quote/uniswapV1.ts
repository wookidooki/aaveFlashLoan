// Exact integer re-implementation of the historical Uniswap v1 exchange pricing
// (../contracts/uniswap_exchange_custom.vy:108-113, getInputPrice). Vyper's `/` on uint256 is
// floor division, which is what bigint `/` does for non-negative operands.

export function getInputPrice(inputAmount: bigint, inputReserve: bigint, outputReserve: bigint): bigint {
  if (inputReserve <= 0n || outputReserve <= 0n) throw new Error("empty reserve");
  const inputAmountWithFee = inputAmount * 997n;
  const numerator = inputAmountWithFee * outputReserve;
  const denominator = inputReserve * 1000n + inputAmountWithFee;
  return numerator / denominator;
}

export interface V1PoolState {
  ethReserve: bigint; // exchange ETH balance (wei)
  tokenReserve: bigint; // exchange token balance
}

/** Mirrors the Aave v1 snapshot's fee: floor(amount / 100) (LendingPool.sol:632). */
export function aaveV1Fee(amount: bigint): bigint {
  return amount / 100n;
}

export interface V1RoundTripQuote {
  amount: bigint;
  fee: bigint;
  ethOut: bigint;
  tokensOut: bigint;
  /** tokensOut - amount - fee; negative means the trade loses. */
  profit: bigint;
}

/**
 * Quote TOKEN -> ETH on `first`, then ETH -> TOKEN on `second`, using the first swap's output
 * as the second swap's input. Same ordered pair and amount as FixtureArbReceiver.execute().
 * tokenToEthInput reads (token balance, ETH balance) before the swap; ethToTokenInput reads the
 * ETH reserve *before* the incoming ETH (self.balance - eth_sold), i.e. the pre-trade balance.
 */
export function quoteV1RoundTrip(amount: bigint, first: V1PoolState, second: V1PoolState): V1RoundTripQuote {
  const fee = aaveV1Fee(amount);
  const ethOut = getInputPrice(amount, first.tokenReserve, first.ethReserve);
  const tokensOut = getInputPrice(ethOut, second.ethReserve, second.tokenReserve);
  return { amount, fee, ethOut, tokensOut, profit: tokensOut - amount - fee };
}
