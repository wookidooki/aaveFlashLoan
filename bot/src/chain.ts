// Read-only RPC access. No wallet clients and no private keys exist anywhere in the scanner.
import {
  createPublicClient,
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  fallback,
  http,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { cappedMulticallArtifact } from "./sim/receiver.ts";
import type { ChainConfig } from "./config.ts";

export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

export function makeClient(chain: ChainConfig): PublicClient {
  return createPublicClient({
    // viem caches eth_blockNumber for the polling interval (4 s) by default; block-by-block work needs it fresh.
    cacheTime: 0,
    transport: fallback(
      chain.rpcUrls.map((url) => http(url, { timeout: 20_000, retryCount: 2, retryDelay: 400 })),
      { rank: false },
    ),
  }) as PublicClient;
}

export interface CallSpec {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

export type CallResult = { ok: true; value: any } | { ok: false; error: string };

/**
 * Multicall3 aggregate3 at a fixed block, allowFailure per call. Every quote for a cycle uses the
 * same block number so all routes on a chain are compared against identical state.
 */
export async function multicallAt(
  client: PublicClient,
  calls: CallSpec[],
  blockNumber: bigint,
  chunk = 40,
): Promise<CallResult[]> {
  const chunks: CallSpec[][] = [];
  for (let i = 0; i < calls.length; i += chunk) chunks.push(calls.slice(i, i + chunk));
  const results = await mapLimit(chunks, RPC_CONCURRENCY, (c) => runChunk(client, c, blockNumber));
  return results.flat();
}

/** Parallel eth_calls per chain; kept small to stay within public RPC rate limits. */
export const RPC_CONCURRENCY = 4;

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Where the CappedMulticall code is placed via state override (never deployed). */
export const CAPPED_MULTICALL: Address = "0x5115000000000000000000000000000000000002";

const KNOWN_INNER_ERRORS = parseAbi([
  "error NotEnoughLiquidity(bytes32 poolId)",
  "error PriceLimitAlreadyExceeded(uint160 sqrtPriceCurrentX96, uint160 sqrtPriceLimitX96)",
  "error PriceLimitOutOfBounds(uint160 sqrtPriceLimitX96)",
  "error PoolNotInitialized()",
  "error WrappedError(address target, bytes4 selector, bytes reason, bytes details)",
]);

/** Human-readable revert reason for a call's return data, unwrapping V4Quoter's UnexpectedRevertBytes. */
export function describeRevert(abi: Abi, data: Hex): string {
  if (!data || data === "0x") return "reverted without data";
  try {
    const d = decodeErrorResult({ abi, data });
    if (d.errorName === "UnexpectedRevertBytes") {
      const inner = (d.args as readonly Hex[])[0];
      if (!inner || inner === "0x") return "UnexpectedRevertBytes -> pool swap reverted without data";
      try {
        return `UnexpectedRevertBytes -> ${decodeErrorResult({ abi: KNOWN_INNER_ERRORS, data: inner }).errorName}`;
      } catch {
        return `UnexpectedRevertBytes -> ${inner.slice(0, 10)}`;
      }
    }
    if (d.errorName === "Error") return `Error("${String((d.args as readonly unknown[])[0]).slice(0, 80)}")`;
    return d.errorName;
  } catch {
    try {
      return decodeErrorResult({ abi: KNOWN_INNER_ERRORS, data }).errorName;
    } catch {
      return `unknown error ${data.slice(0, 10)}`;
    }
  }
}

/**
 * Like multicallAt, but every call runs through CappedMulticall (injected by state override) with
 * a per-call gas cap, so a pathological quote fails fast instead of timing out the whole eth_call.
 */
export async function cappedMulticallAt(
  client: PublicClient,
  calls: CallSpec[],
  blockNumber: bigint,
  gasCap: bigint,
  chunk = 10,
): Promise<CallResult[]> {
  const art = cappedMulticallArtifact();
  const run = async (slice: CallSpec[]): Promise<CallResult[]> => {
    try {
      const { data } = await client.call({
        to: CAPPED_MULTICALL,
        data: encodeFunctionData({
          abi: art.abi,
          functionName: "run",
          args: [slice.map((c) => ({ target: c.address, data: encodeFunctionData(c as any) })), gasCap],
        }),
        blockNumber,
        stateOverride: [{ address: CAPPED_MULTICALL, code: art.deployedBytecode }],
      });
      const rows = decodeFunctionResult({ abi: art.abi, functionName: "run", data: data! }) as readonly {
        success: boolean;
        outOfBudget: boolean;
        gasUsed: bigint;
        ret: Hex;
      }[];
      return rows.map((r, i) => {
        const c = slice[i];
        if (r.outOfBudget) return { ok: false, error: "batch gas budget exhausted" };
        if (!r.success) {
          // Quoters catch their inner swap's out-of-gas and re-revert ("Unexpected error"), so judge
          // by gas consumed, not by the return data.
          if (r.gasUsed >= (gasCap * 63n) / 64n) {
            return { ok: false, error: `needs more than ${gasCap / 1_000_000n}M gas (crosses too many ticks at this size)` };
          }
          return { ok: false, error: describeRevert(c.abi, r.ret) };
        }
        try {
          return { ok: true, value: decodeFunctionResult({ abi: c.abi, functionName: c.functionName, data: r.ret } as any) };
        } catch (e) {
          return { ok: false, error: `undecodable result: ${shortError(e)}` };
        }
      });
    } catch (e) {
      if (!isRpcLevel(e)) return slice.map(() => ({ ok: false, error: shortError(e) }));
      rpcRejections.count++;
      rpcRejections.lastDetail = String((e as any)?.details ?? (e as any)?.shortMessage ?? "").slice(0, 200);
      if (slice.length === 1) return [{ ok: false, error: `rpc rejected: ${rpcRejections.lastDetail}` }];
      const mid = Math.ceil(slice.length / 2);
      return [...(await run(slice.slice(0, mid))), ...(await run(slice.slice(mid)))];
    }
  };
  const chunks: CallSpec[][] = [];
  for (let i = 0; i < calls.length; i += chunk) chunks.push(calls.slice(i, i + chunk));
  return (await mapLimit(chunks, RPC_CONCURRENCY, run)).flat();
}

/** RPC-level rejections (not contract reverts) seen so far, for the activity log. */
export const rpcRejections: { count: number; lastDetail?: string } = { count: 0 };

/** True when the node rejected the request itself (anywhere in the cause chain), not a contract revert. */
function isRpcLevel(e: unknown): boolean {
  let cur: any = e;
  for (let i = 0; cur && i < 10; i++) {
    const name = cur.name ?? "";
    if (/ContractFunctionRevertedError/.test(name)) return false;
    if (/RpcError|HttpRequestError|TimeoutError|RpcRequestError/.test(name)) return true;
    if (typeof cur.code === "number" && cur.code <= -32000 && cur.code >= -32700) return true;
    cur = cur.cause;
  }
  return false;
}

/**
 * One aggregate3 eth_call. If the node rejects the whole call (gas cap, size or rate limit), every
 * entry fails with the same RPC error; split the chunk and retry so one heavy quote cannot hide
 * the rest. Contract reverts are per-call and are returned as they are.
 */
async function runChunk(client: PublicClient, slice: CallSpec[], blockNumber: bigint): Promise<CallResult[]> {
  let res: any[];
  try {
    res = (await client.multicall({
      contracts: slice as any,
      allowFailure: true,
      blockNumber,
      multicallAddress: MULTICALL3,
      batchSize: 0,
    })) as any[];
  } catch (e) {
    res = slice.map(() => ({ status: "failure", error: e }));
  }
  const allRpc = res.length > 0 && res.every((r) => r.status === "failure" && isRpcLevel(r.error));
  if (allRpc) {
    rpcRejections.count++;
    rpcRejections.lastDetail = String((res[0].error as any)?.details ?? (res[0].error as any)?.shortMessage ?? "").slice(0, 200);
    if (slice.length > 1) {
      const mid = Math.ceil(slice.length / 2);
      return [...(await runChunk(client, slice.slice(0, mid), blockNumber)), ...(await runChunk(client, slice.slice(mid), blockNumber))];
    }
    return [{ ok: false, error: `rpc rejected: ${rpcRejections.lastDetail || shortError(res[0].error)}` }];
  }
  return res.map((r) => (r.status === "success" ? { ok: true, value: r.result } : { ok: false, error: shortError(r.error) }));
}

export function shortError(e: unknown): string {
  const msg = String((e as any)?.shortMessage ?? (e as any)?.message ?? String(e)).split("\n")[0];
  // viem puts a decoded revert reason on a nested cause; surface it instead of the generic header.
  let cur: any = e;
  for (let i = 0; cur && i < 8; i++) {
    if (typeof cur.reason === "string" && cur.reason) return `${msg.replace(/ with the following reason:$/, "")}: ${cur.reason}`.slice(0, 200);
    if (cur.data?.errorName) return `${msg.replace(/ with the following reason:$/, "")}: ${cur.data.errorName}`.slice(0, 200);
    if (typeof cur.signature === "string") return `${msg.replace(/ with the following signature:$/, "")}: unknown error ${cur.signature}`.slice(0, 200);
    cur = cur.cause;
  }
  return msg.slice(0, 200);
}

export async function rawCall(
  client: PublicClient,
  args: { from: Address; to: Address; data: Hex; blockNumber: bigint; stateOverride?: unknown; gas?: bigint },
): Promise<{ ok: true; data: Hex } | { ok: false; revertData?: Hex; error: string }> {
  try {
    const r = await client.request({
      method: "eth_call",
      params: [
        { from: args.from, to: args.to, data: args.data, gas: args.gas ? `0x${args.gas.toString(16)}` : undefined },
        `0x${args.blockNumber.toString(16)}`,
        args.stateOverride ?? {},
      ],
    } as any);
    return { ok: true, data: r as Hex };
  } catch (e: any) {
    let cur = e;
    for (let i = 0; cur && i < 8; i++) {
      const d = cur.data?.data ?? cur.data;
      if (typeof d === "string" && d.startsWith("0x")) return { ok: false, revertData: d as Hex, error: shortError(e) };
      cur = cur.cause;
    }
    return { ok: false, error: shortError(e) };
  }
}
