// Encoding/decoding for FlashArbReceiverV3 simulate(), shared by tests and the scanner.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeErrorResult, encodeAbiParameters, encodeFunctionData, keccak256, type Abi, type Address, type Hex } from "viem";

export const LEG_KIND = { clUniswapCallback: 0, clPancakeCallback: 1, v2: 2, solidly: 3, clAlgebra: 4, v4: 5 } as const;

export interface LegArg {
  kind: number;
  pool: Address;
  tokenIn: Address;
  tokenOut: Address;
  feeBps: number;
  minOut: bigint;
  /** abi.encode(PoolKey, weth) for Uniswap v4 legs; "0x" otherwise */
  data: Hex;
}

const RECEIVERS = {
  aave: "FlashArbReceiverV3",
  morpho: "FlashArbReceiverMorpho",
} as const;

const cached = new Map<string, { abi: Abi; deployedBytecode: Hex }>();
/**
 * Compiled receiver for a lender (run `npm run compile` first). Both share ArbReceiverBase, so
 * run/simulate encoding and error decoding are identical; only the deployed code differs.
 */
export function receiverArtifact(lender: keyof typeof RECEIVERS = "aave"): { abi: Abi; deployedBytecode: Hex } {
  const name = RECEIVERS[lender];
  if (!cached.has(name)) {
    const path = fileURLToPath(new URL(`../../artifacts/contracts/live/${name}.sol/${name}.json`, import.meta.url));
    if (!existsSync(path)) throw new Error(`${name} artifact missing: run \`npm run compile\` in bot/ first`);
    const j = JSON.parse(readFileSync(path, "utf8"));
    cached.set(name, { abi: j.abi, deployedBytecode: j.deployedBytecode });
  }
  return cached.get(name)!;
}

export function encodeRun(fn: "run" | "simulate", asset: Address, amount: bigint, legs: LegArg[], minSurplus: bigint): Hex {
  return encodeFunctionData({ abi: receiverArtifact().abi, functionName: fn, args: [asset, amount, legs, minSurplus] });
}

export interface SimulationOutcome {
  ok: boolean;
  gasUsed: bigint;
  profit: bigint;
  /** Decoded inner revert, e.g. "InsufficientProceeds(proceeds=..., required=...)". */
  reason: string;
  /** Proceeds of the final leg when the inner revert was InsufficientProceeds. */
  proceeds?: bigint;
}

function describeInner(reason: Hex): { text: string; proceeds?: bigint } {
  if (reason === "0x" || reason.length < 10) return { text: "empty revert" };
  try {
    const d = decodeErrorResult({ abi: receiverArtifact().abi, data: reason });
    const args = (d.args ?? []).map((a) => String(a)).join(", ");
    return { text: `${d.errorName}(${args})`, proceeds: d.errorName === "InsufficientProceeds" ? (d.args![0] as bigint) : undefined };
  } catch {
    try {
      const d = decodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ name: "m", type: "string" }] }], data: reason });
      return { text: `Error("${d.args[0]}")` };
    } catch {
      return { text: `raw ${reason.slice(0, 74)}` };
    }
  }
}

/** Decode the revert data returned by simulate(). Throws if it is not a SimulationResult. */
export function decodeSimulation(data: Hex): SimulationOutcome {
  const d = decodeErrorResult({ abi: receiverArtifact().abi, data });
  if (d.errorName !== "SimulationResult") {
    throw new Error(`simulate() reverted outside the simulation wrapper: ${describeInner(data).text}`);
  }
  const [ok, gasUsed, profit, reason] = d.args as [boolean, bigint, bigint, Hex];
  const inner = ok ? { text: "" } : describeInner(reason);
  return { ok, gasUsed, profit, reason: inner.text, proceeds: inner.proceeds };
}

/** Pull revert data out of a viem error (walks the cause chain). */
export function revertData(err: unknown): Hex | undefined {
  let e: any = err;
  for (let i = 0; e && i < 8; i++) {
    const data = e.data?.data ?? e.data;
    if (typeof data === "string" && data.startsWith("0x")) return data as Hex;
    e = e.cause;
  }
  return undefined;
}

// ---------------------------------------------------------------- Uniswap v4 leg data

export interface V4PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

const POOL_KEY_TUPLE = {
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
} as const;

/** Leg.data for KIND_V4: abi.encode(PoolKey, weth). */
export function encodeV4LegData(key: V4PoolKey, weth: Address): Hex {
  return encodeAbiParameters([POOL_KEY_TUPLE, { type: "address" }], [key, weth]);
}

/** v4 PoolId = keccak256(abi.encode(PoolKey)). */
export function v4PoolId(key: V4PoolKey): Hex {
  return keccak256(encodeAbiParameters([POOL_KEY_TUPLE], [key]));
}

// ---------------------------------------------------------------- injected CL quoter

const QUOTER_ARTIFACT = fileURLToPath(new URL("../../artifacts/contracts/live/CLQuoter.sol/CLQuoter.json", import.meta.url));
let cachedQuoter: { abi: Abi; deployedBytecode: Hex } | undefined;
export function clQuoterArtifact(): { abi: Abi; deployedBytecode: Hex } {
  if (!cachedQuoter) {
    if (!existsSync(QUOTER_ARTIFACT)) throw new Error("CLQuoter artifact missing: run `npm run compile` in bot/ first");
    const j = JSON.parse(readFileSync(QUOTER_ARTIFACT, "utf8"));
    cachedQuoter = { abi: j.abi, deployedBytecode: j.deployedBytecode };
  }
  return cachedQuoter;
}

const CAPPED_ARTIFACT = fileURLToPath(new URL("../../artifacts/contracts/live/CappedMulticall.sol/CappedMulticall.json", import.meta.url));
let cachedCapped: { abi: Abi; deployedBytecode: Hex } | undefined;
export function cappedMulticallArtifact(): { abi: Abi; deployedBytecode: Hex } {
  if (!cachedCapped) {
    if (!existsSync(CAPPED_ARTIFACT)) throw new Error("CappedMulticall artifact missing: run `npm run compile` in bot/ first");
    const j = JSON.parse(readFileSync(CAPPED_ARTIFACT, "utf8"));
    cachedCapped = { abi: j.abi, deployedBytecode: j.deployedBytecode };
  }
  return cachedCapped;
}
