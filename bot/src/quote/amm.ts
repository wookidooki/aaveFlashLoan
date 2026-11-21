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

const E18 = 10n ** 18n;

/**
 * Aerodrome / Velodrome v2 stable pool (Pool.sol): k = x^3*y + x*y^3 on reserves scaled to 18
 * decimals, fee taken off the input first. `dec0`/`dec1` are 10**decimals as stored by the pool
 * (Pool.metadata()). Mirrors _getAmountOut/_get_y/_f/_d/_k including their rounding (and _get_y's
 * use of _k, which rescales its already scaled arguments by the token0/token1 decimals).
 */
export function solidlyStableAmountOut(
  amountIn: bigint,
  feeBps: bigint,
  tokenInIs0: boolean,
  reserve0: bigint,
  reserve1: bigint,
  dec0: bigint,
  dec1: bigint,
): bigint {
  amountIn -= (amountIn * feeBps) / 10000n;
  const k = (x: bigint, y: bigint) => {
    const _x = (x * E18) / dec0;
    const _y = (y * E18) / dec1;
    const a = (_x * _y) / E18;
    const b = (_x * _x) / E18 + (_y * _y) / E18;
    return (a * b) / E18;
  };
  const f = (x0: bigint, y: bigint) => {
    const a = (x0 * y) / E18;
    const b = (x0 * x0) / E18 + (y * y) / E18;
    return (a * b) / E18;
  };
  const d = (x0: bigint, y: bigint) => (3n * x0 * ((y * y) / E18)) / E18 + (((x0 * x0) / E18) * x0) / E18;
  const getY = (x0: bigint, xy: bigint, y: bigint): bigint => {
    for (let i = 0; i < 255; i++) {
      const kk = f(x0, y);
      if (kk < xy) {
        let dy = ((xy - kk) * E18) / d(x0, y);
        if (dy === 0n) {
          if (kk === xy) return y;
          if (k(x0, y + 1n) > xy) return y + 1n;
          dy = 1n;
        }
        y = y + dy;
      } else {
        let dy = ((kk - xy) * E18) / d(x0, y);
        if (dy === 0n) {
          if (kk === xy || f(x0, y - 1n) < xy) return y;
          dy = 1n;
        }
        y = y - dy;
      }
    }
    throw new Error("!y");
  };
  const xy = k(reserve0, reserve1);
  const s0 = (reserve0 * E18) / dec0;
  const s1 = (reserve1 * E18) / dec1;
  const [rA, rB] = tokenInIs0 ? [s0, s1] : [s1, s0];
  const inScaled = tokenInIs0 ? (amountIn * E18) / dec0 : (amountIn * E18) / dec1;
  const y = rB - getY(inScaled + rA, xy, rB);
  return (y * (tokenInIs0 ? dec1 : dec0)) / E18;
}
