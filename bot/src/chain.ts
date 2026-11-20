// Read-only RPC access. No wallet clients and no private keys exist anywhere in the scanner.
import { createPublicClient, fallback, http, type Abi, type Address, type Hex, type PublicClient } from "viem";
import type { ChainConfig } from "./config.ts";

export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

export function makeClient(chain: ChainConfig): PublicClient {
  return createPublicClient({
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
  const out: CallResult[] = [];
  for (let i = 0; i < calls.length; i += chunk) out.push(...(await runChunk(client, calls.slice(i, i + chunk), blockNumber)));
  return out;
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
