// verify-local: local exact quotes vs the venues' own quoters, at one block. Pool state and tick data
// are read at that same block, so every supported quote must match to the last unit.
import type { Address } from "viem";
import { multicallAt } from "./chain.ts";
import { TickCache, localQuote, parseSnapshot, stateReads, type PoolSnapshot } from "./localpool.ts";
import type { Scanner } from "./scanner.ts";
import { quoteMany, readV2Reserves, type QuoteRequest } from "./venues.ts";

export interface VerifyRow {
  venue: string;
  exact: number;
  mismatch: number;
  maxDiffBps: number;
  localUnavailable: Record<string, number>;
  rpcFailed: number;
}

export async function verifyLocal(scanner: Scanner, chain: string, sizesUsd = [1, 75, 1000, 10000]): Promise<{ block: bigint; rows: VerifyRow[]; examples: string[] }> {
  const rt = await scanner.runtime(chain);
  const block = (await rt.client.getBlockNumber()) - 1n;
  const probe = (t: Address) => 10n ** BigInt(rt.decimals.get(t) ?? 18);
  const reads = rt.pools.map((p) => stateReads(p, probe));
  const res = await multicallAt(rt.client, reads.flat(), block, 60);
  const snaps = new Map<string, PoolSnapshot>();
  let k = 0;
  rt.pools.forEach((p, i) => {
    snaps.set(p.id, parseSnapshot(p, res.slice(k, k + reads[i].length)));
    k += reads[i].length;
  });
  const ticks = new TickCache();
  for (const p of rt.pools) {
    const s = snaps.get(p.id);
    if (s?.cl) await ticks.fetch(rt.client, p, s.cl.tick, block);
  }
  const price = (t: Address) => Number(rt.cache!.market.assets.get(t)?.priceUsd8 ?? 0n) / 1e8;
  const reqs: (QuoteRequest & { venue: string })[] = [];
  for (const p of rt.pools) {
    for (const [tin, tout] of [
      [p.token0, p.token1],
      [p.token1, p.token0],
    ] as const) {
      const px = price(tin);
      if (!px) continue;
      const dec = rt.decimals.get(tin)!;
      for (const usd of sizesUsd) {
        reqs.push({ pool: p, tokenIn: tin, tokenOut: tout, amountIn: BigInt(Math.round((usd / px) * 10 ** Math.min(dec, 12))) * 10n ** BigInt(Math.max(0, dec - 12)), venue: p.venue.type === "v4" ? `${p.venue.id}${p.native ? " (ETH)" : ""}` : p.venue.id });
      }
    }
  }
  const v2 = await readV2Reserves(rt.client, rt.pools, block);
  const rpc = await quoteMany(rt.client, reqs, v2, scanner.cfg.gasModel, block);
  const rows = new Map<string, VerifyRow>();
  const examples: string[] = [];
  reqs.forEach((q, i) => {
    const row = rows.get(q.venue) ?? { venue: q.venue, exact: 0, mismatch: 0, maxDiffBps: 0, localUnavailable: {}, rpcFailed: 0 };
    rows.set(q.venue, row);
    const r = rpc[i];
    const l = localQuote(snaps.get(q.pool.id), ticks, q.tokenIn, q.amountIn, 60_000n);
    if ("error" in l) {
      row.localUnavailable[l.error] = (row.localUnavailable[l.error] ?? 0) + 1;
      return;
    }
    if ("error" in r) {
      row.rpcFailed++;
      return;
    }
    if (l.amountOut === r.amountOut) row.exact++;
    else {
      row.mismatch++;
      const bps = (Math.abs(Number(l.amountOut - r.amountOut)) / Number(r.amountOut)) * 1e4;
      row.maxDiffBps = Math.max(row.maxDiffBps, bps);
      if (examples.length < 8) examples.push(`${q.pool.label} in ${q.amountIn}: local ${l.amountOut} vs rpc ${r.amountOut}`);
    }
  });
  return { block, rows: [...rows.values()], examples };
}
