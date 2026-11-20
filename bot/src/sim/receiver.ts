// Encoding/decoding for FlashArbReceiverV3 simulate(), shared by tests and the scanner.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeErrorResult, encodeFunctionData, type Abi, type Address, type Hex } from "viem";

export const LEG_KIND = { clUniswapCallback: 0, clPancakeCallback: 1, v2: 2, solidly: 3 } as const;

export interface LegArg {
  kind: number;
  pool: Address;
  tokenIn: Address;
  tokenOut: Address;
  feeBps: number;
  minOut: bigint;
}

const ARTIFACT = fileURLToPath(new URL("../../artifacts/contracts/live/FlashArbReceiverV3.sol/FlashArbReceiverV3.json", import.meta.url));

let cached: { abi: Abi; deployedBytecode: Hex } | undefined;
/** Compiled receiver (run `npm run compile` first). */
export function receiverArtifact(): { abi: Abi; deployedBytecode: Hex } {
  if (!cached) {
    if (!existsSync(ARTIFACT)) throw new Error("FlashArbReceiverV3 artifact missing: run `npm run compile` in bot/ first");
    const j = JSON.parse(readFileSync(ARTIFACT, "utf8"));
    cached = { abi: j.abi, deployedBytecode: j.deployedBytecode };
  }
  return cached;
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
