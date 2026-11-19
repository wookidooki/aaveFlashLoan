// Scanner settings. Each one can be changed with an environment variable (see .env.example).
const num = (name, def) => (process.env[name] !== undefined && process.env[name] !== '' ? Number(process.env[name]) : def);
const bool = (name, def) => (process.env[name] !== undefined ? ['1', 'true', 'yes'].includes(process.env[name].toLowerCase()) : def);

export const SETTINGS = {
  chains: (process.env.CHAINS || 'base,arbitrum').split(',').map((s) => s.trim()).filter(Boolean),
  pollMs: num('POLL_MS', 500), // how often to check each chain for a new block
  maxHops: num('MAX_HOPS', 3), // 2 = A->B->A, 3 = also A->B->C->A
  minPoolTvlUsd: num('MIN_POOL_TVL_USD', 25000), // ignore pools smaller than this
  topCandidates: num('TOP_CANDIDATES', 30), // how many best loops to quote exactly per block
  tradeSizesUsd: (process.env.TRADE_SIZES_USD || '100,500,2000,10000,50000,200000').split(',').map(Number),
  minProfitUsd: num('MIN_PROFIT_USD', 0.5), // after Aave fee and gas
  poolRefreshMin: num('POOL_REFRESH_MIN', 15), // re-read pool sizes and Aave liquidity
  discoveryMaxAgeHours: num('DISCOVERY_MAX_AGE_HOURS', 12),
  statusEverySec: num('STATUS_EVERY_SEC', 30),

  // Live trading. OFF unless LIVE=true and PRIVATE_KEY and FLASH_ARB_<CHAIN> are set.
  live: bool('LIVE', false),
  maxGasUsdPerTrade: num('MAX_GAS_USD_PER_TRADE', 0.5),
  maxGasUsdPerDay: num('MAX_GAS_USD_PER_DAY', 5),
  maxFailsInARow: num('MAX_FAILS_IN_A_ROW', 5),
  minProfitShare: num('MIN_PROFIT_SHARE', 0.5), // on-chain guard: revert if profit < this share of the simulated profit
  tipProfitShare: num('TIP_PROFIT_SHARE', 0.3), // share of expected profit paid as priority fee, to be early in the block
  pauseMinAfterFails: num('PAUSE_MIN_AFTER_FAILS', 30), // pause this long after MAX_FAILS_IN_A_ROW failures
};
