import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAddress, type Address } from "viem";

/** "injected": quote through the CLQuoter code injected by eth_call state override. */
export type QuoterRef = Address | "injected";

export type VenueConfig =
  | { id: string; type: "v3"; callback: "uniswap" | "pancake"; factory: Address; quoter: QuoterRef; fees: number[] }
  | { id: string; type: "slipstream"; callback: "uniswap"; factory: Address; quoter: QuoterRef; tickSpacings: number[] }
  | { id: string; type: "algebra"; factory: Address }
  | { id: string; type: "v2"; factory: Address; feeBps: number }
  | { id: string; type: "solidly"; factory: Address }
  | { id: string; type: "pair-getamountout"; factory: Address }
  | {
      id: string;
      type: "v4";
      poolManager: Address;
      quoter: Address;
      stateView: Address;
      /** asset symbol standing in for native ETH (currency 0x0) */
      nativeAs: string;
      /** hookless (fee, tickSpacing) keys to check */
      keys: [number, number][];
    };

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
  /** WETH unwrap + wrap around a native-ETH v4 leg */
  wrapGas: number;
}

export interface ScanConfig {
  loanSizesUsd: number[];
  /** a trade qualifies when its net after premium, gas and L1 fee is strictly above this (USD) */
  minNetUsd: number;
  /** routes closest to break-even that are re-quoted on every new block between full sweeps */
  hotRoutes: number;
  /** amount ladder (log-spaced, USD) quoted for every route whose best rate could beat break-even */
  sizeSearch: { minUsd: number; maxUsd: number; points: number };
  dailyTargetUsd: number;
  intervalSeconds: number;
  maxRoundTripLossBps: number;
  poolRefreshMinutes: number;
  bestRouteSimulationEveryCycles: number;
  /** USD size of the per-pool marginal-rate probe used for the pruning bound */
  probeUsd: number;
  /** safety margin on the bound: routes within this many bps of covering the premium are quoted in full */
  boundSlackBps: number;
  /** always fully quote this many routes per chain (best marginal product), so reports keep real breakdowns */
  fullQuoteTopRoutes: number;
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
      venues: c.venues.map((v: any) => {
        const addr = (x: string | undefined) => (x && x !== "injected" ? getAddress(x) : x);
        if (v.type === "v4" && !assets[v.nativeAs]) throw new Error(`${name}: ${v.id} nativeAs ${v.nativeAs} missing from "assets"`);
        return { ...v, factory: addr(v.factory), quoter: addr(v.quoter), poolManager: addr(v.poolManager), stateView: addr(v.stateView) };
      }),
      unsupportedVenues: c.unsupportedVenues ?? [],
    });
  }
  if (chains.length === 0) throw new Error("no chains selected");
  return { ...raw, chains } as ScanConfig;
}
