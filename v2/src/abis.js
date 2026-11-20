import { parseAbi } from 'viem';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const loadArtifact = (name) => JSON.parse(fs.readFileSync(path.join(root, 'artifacts', `${name}.json`), 'utf8'));

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
]);
export const wethAbi = parseAbi(['function deposit() payable']);

export const v2FactoryAbi = parseAbi(['function getPair(address,address) view returns (address)']);
export const solidlyFactoryAbi = parseAbi([
  'function getPool(address,address,bool) view returns (address)',
  'function getFee(address,bool) view returns (uint256)',
]);
export const v3FactoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
export const clFactoryAbi = parseAbi(['function getPool(address,address,int24) view returns (address)']);

export const v2PairAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function swap(uint256,uint256,address,bytes)',
]);
export const solidlyPoolAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint256,uint256,uint256)',
  'function getAmountOut(uint256,address) view returns (uint256)',
  'function stable() view returns (bool)',
]);
// slot0 differs between Uniswap, PancakeSwap and Aerodrome CL. Only the first field
// (sqrtPriceX96) is the same, so only that one is decoded.
export const v3PoolAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96)',
]);

export const aavePoolAbi = parseAbi([
  'function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)',
  'function getConfiguration(address) view returns (uint256)',
  'function getReserveData(address) view returns ((uint256 data) configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt)',
]);
