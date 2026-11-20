// Aave v3 market state, read at the cycle's block: premium, per-asset flash-loan availability,
// available liquidity and oracle price. The market's own registry is the source of truth.
import { getAddress, parseAbi, type Address, type PublicClient } from "viem";
import { multicallAt, type CallSpec } from "./chain.ts";

const PROVIDER_ABI = parseAbi([
  "function getPool() view returns (address)",
  "function getPoolDataProvider() view returns (address)",
  "function getPriceOracle() view returns (address)",
]);
const POOL_ABI = parseAbi([
  "function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)",
  "function getVirtualUnderlyingBalance(address) view returns (uint128)",
]);
const DATA_ABI = parseAbi([
  "function getAllReservesTokens() view returns ((string symbol, address tokenAddress)[])",
  "function getFlashLoanEnabled(address) view returns (bool)",
  "function getPaused(address) view returns (bool)",
  "function getReserveConfigurationData(address) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)",
  "function getReserveTokensAddresses(address) view returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress)",
]);
const ORACLE_ABI = parseAbi(["function getAssetPrice(address) view returns (uint256)", "function BASE_CURRENCY_UNIT() view returns (uint256)"]);
export const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

export interface AaveMarket {
  pool: Address;
  dataProvider: Address;
  oracle: Address;
  /** Aave asset symbol by address, from getAllReservesTokens(). */
  reserves: Map<Address, string>;
  aTokens: Map<Address, Address>;
}

export async function loadMarket(client: PublicClient, provider: Address): Promise<AaveMarket> {
  const [pool, dataProvider, oracle] = await Promise.all(
    (["getPool", "getPoolDataProvider", "getPriceOracle"] as const).map((fn) =>
      client.readContract({ address: provider, abi: PROVIDER_ABI, functionName: fn }),
    ),
  );
  const list = await client.readContract({ address: dataProvider, abi: DATA_ABI, functionName: "getAllReservesTokens" });
  const reserves = new Map<Address, string>(list.map((r) => [getAddress(r.tokenAddress), r.symbol]));
  const aTokens = new Map<Address, Address>();
  for (const asset of reserves.keys()) {
    const [a] = await client.readContract({ address: dataProvider, abi: DATA_ABI, functionName: "getReserveTokensAddresses", args: [asset] });
    aTokens.set(asset, getAddress(a));
  }
  return { pool: getAddress(pool), dataProvider: getAddress(dataProvider), oracle: getAddress(oracle), reserves, aTokens };
}

export interface AssetState {
  address: Address;
  isReserve: boolean;
  flashEnabled: boolean;
  active: boolean;
  paused: boolean;
  frozen: boolean;
  /** min(virtual underlying balance, aToken's underlying balance) when both are readable. */
  availableLiquidity: bigint;
  /** USD price with 8 decimals from the Aave oracle (0n if not a reserve). */
  priceUsd8: bigint;
}

export interface MarketState {
  premiumBps: bigint;
  assets: Map<Address, AssetState>;
}

export async function readMarketState(
  client: PublicClient,
  market: AaveMarket,
  assets: Address[],
  blockNumber: bigint,
): Promise<MarketState> {
  const calls: CallSpec[] = [{ address: market.pool, abi: POOL_ABI, functionName: "FLASHLOAN_PREMIUM_TOTAL" }];
  const reserveAssets = assets.filter((a) => market.reserves.has(a));
  for (const a of reserveAssets) {
    calls.push(
      { address: market.dataProvider, abi: DATA_ABI, functionName: "getFlashLoanEnabled", args: [a] },
      { address: market.dataProvider, abi: DATA_ABI, functionName: "getPaused", args: [a] },
      { address: market.dataProvider, abi: DATA_ABI, functionName: "getReserveConfigurationData", args: [a] },
      { address: market.pool, abi: POOL_ABI, functionName: "getVirtualUnderlyingBalance", args: [a] },
      { address: a, abi: ERC20_ABI, functionName: "balanceOf", args: [market.aTokens.get(a)!] },
      { address: market.oracle, abi: ORACLE_ABI, functionName: "getAssetPrice", args: [a] },
    );
  }
  const res = await multicallAt(client, calls, blockNumber);
  if (!res[0].ok) throw new Error(`premium read failed: ${res[0].error}`);
  const state: MarketState = { premiumBps: BigInt(res[0].value), assets: new Map() };
  let i = 1;
  for (const a of reserveAssets) {
    const [flash, paused, conf, virt, held, price] = res.slice(i, i + 6);
    i += 6;
    const confV = conf.ok ? (conf.value as readonly unknown[]) : undefined;
    const virtual = virt.ok ? BigInt(virt.value) : undefined;
    const aBal = held.ok ? BigInt(held.value) : undefined;
    const available = virtual !== undefined && aBal !== undefined ? (virtual < aBal ? virtual : aBal) : (virtual ?? aBal ?? 0n);
    state.assets.set(a, {
      address: a,
      isReserve: true,
      flashEnabled: flash.ok ? Boolean(flash.value) : false,
      paused: paused.ok ? Boolean(paused.value) : true,
      active: confV ? Boolean(confV[8]) : false,
      frozen: confV ? Boolean(confV[9]) : true,
      availableLiquidity: available,
      priceUsd8: price.ok ? BigInt(price.value) : 0n,
    });
  }
  for (const a of assets) {
    if (!state.assets.has(a)) {
      state.assets.set(a, { address: a, isReserve: false, flashEnabled: false, active: false, paused: false, frozen: false, availableLiquidity: 0n, priceUsd8: 0n });
    }
  }
  return state;
}

/** Why an asset cannot be flash-borrowed right now, or undefined if it can. */
export function borrowBlocker(s: AssetState | undefined): string | undefined {
  if (!s || !s.isReserve) return "not an Aave reserve on this market";
  if (!s.active) return "Aave reserve inactive";
  if (s.paused) return "Aave reserve paused";
  if (!s.flashEnabled) return "flash loans disabled for this reserve";
  if (s.priceUsd8 === 0n) return "no Aave oracle price";
  return undefined;
}
