import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAddress, type Address } from "viem";

export type VenueConfig =
  | { id: string; type: "v3"; callback: "uniswap" | "pancake"; factory: Address; quoter: Address; fees: number[] }
  | { id: string; type: "slipstream"; callback: "uniswap"; factory: Address; quoter: Address; tickSpacings: number[] }
  | { id: string; type: "v2"; factory: Address; feeBps: number }
  | { id: string; type: "solidly"; factory: Address };

export interface ChainConfig {
  name: string;
  enabled: boolean;
  chainId: number;
  rpcUrls: string[];
  aavePoolAddressesProvider: Address;
  l1FeeModel: "arbitrum-nodeinterface" | "opstack-gaspriceoracle" | "none";
  gasToken: string;
  assets: Record<string, Address>;
  pairs: [string, string][];
  venues: VenueConfig[];
  unsupportedVenues: { id: string; reason: string }[];
}

export interface GasModelConfig {
  txBaseGas: number;
  flashLoanOverheadGas: number;
  perLegOverheadGas: number;
  v2SwapGas: number;
  solidlySwapGas: number;
}

export interface ScanConfig {
  loanSizesUsd: number[];
  benchmarkNetUsd: number;
  dailyTargetUsd: number;
  intervalSeconds: number;
  maxRoundTripLossBps: number;
  poolRefreshMinutes: number;
  bestRouteSimulationEveryCycles: number;
  gasModel: GasModelConfig;
  chains: ChainConfig[];
}

export const DEFAULT_CONFIG_PATH = fileURLToPath(new URL("../config/scan.json", import.meta.url));

export function loadConfig(path = DEFAULT_CONFIG_PATH, onlyChains?: string[]): ScanConfig {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const chains: ChainConfig[] = [];
  for (const [name, c] of Object.entries<any>(raw.chains)) {
    if (onlyChains && !onlyChains.includes(name)) continue;
    if (!onlyChains && c.enabled === false) continue;
    const assets: Record<string, Address> = {};
    for (const [sym, addr] of Object.entries<string>(c.assets)) assets[sym] = getAddress(addr);
    for (const [a, b] of c.pairs) {
      if (!assets[a] || !assets[b]) throw new Error(`${name}: pair ${a}/${b} references an asset missing from "assets"`);
    }
    if (!assets[c.gasToken]) throw new Error(`${name}: gasToken ${c.gasToken} missing from "assets"`);
    chains.push({
      name,
      enabled: c.enabled !== false,
      chainId: c.chainId,
      rpcUrls: c.rpcUrls,
      aavePoolAddressesProvider: getAddress(c.aavePoolAddressesProvider),
      l1FeeModel: c.l1FeeModel ?? "none",
      gasToken: c.gasToken,
      assets,
      pairs: c.pairs,
      venues: c.venues.map((v: any) => ({
        ...v,
        factory: getAddress(v.factory),
        ...(v.quoter ? { quoter: getAddress(v.quoter) } : {}),
      })),
      unsupportedVenues: c.unsupportedVenues ?? [],
    });
  }
  if (chains.length === 0) throw new Error("no chains selected");
  return { ...raw, chains } as ScanConfig;
}
