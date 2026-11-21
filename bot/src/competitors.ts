// Competitor analysis (read-only): who already runs the round trips this bot targets, how often,
// how fast, and for how much. Looks back over recent blocks on one chain:
//   1. Swap events on every pool the scanner watches (and our Uniswap v4 pools via the PoolManager).
//   2. A transaction that swaps the same token pair through two or more of those pools is counted
//      as an arbitrage round trip (the exact trade class the scanner evaluates).
//   3. Its profit is the net ERC20 inflow to the transaction's sender and target contract, priced
//      with the Aave oracle, minus the gas it paid (including the L1 data fee where reported).
//   4. Timing: its position in the block, and whether another transaction swapped one of the same
//      pools earlier in that block (a same-block backrun).
import { getAddress, keccak256, toHex, zeroAddress, type Address, type Hex, type Log, type PublicClient } from "viem";
import { mapLimit } from "./chain.ts";
import type { Scanner } from "./scanner.ts";
import type { PoolInfo } from "./venues.ts";

const sig = (s: string) => keccak256(toHex(s));
const SWAP_TOPICS: Hex[] = [
  sig("Swap(address,address,int256,int256,uint160,uint128,int24)"), // Uniswap v3 forks, Slipstream, Algebra
  sig("Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)"), // PancakeSwap v3
  sig("Swap(address,uint256,uint256,uint256,uint256,address)"), // Uniswap v2 style, Camelot v2
  sig("Swap(address,address,uint256,uint256,uint256,uint256)"), // Aerodrome / Velodrome v2
];
const V4_SWAP = sig("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
const TRANSFER = sig("Transfer(address,address,uint256)");

export interface ArbTx {
  hash: Hex;
  block: bigint;
  index: number;
  from: Address;
  to: Address | null;
  pair: string;
  pools: string[];
  sameBlockBackrun: boolean;
  profitUsd: number;
  gasUsd: number;
  netUsd: number;
  unpricedTokens: number;
  /** a leg went through a native-ETH v4 pool: ETH moves are not ERC20 transfers, so profit is incomplete */
  nativeLeg: boolean;
  status: string;
  /** transactions between the latest earlier swap on one of these pools in the same block and this one */
  triggerGap?: number;
  /** priority fee above the block base fee */
  tipGwei: number;
  tipUsd: number;
  gasUsed: number;
  /** largest amount sent into a watched pool, USD */
  sizeUsd: number;
  /** where the trading capital came from, judged from transfers into the bot */
  capital: string;
}

export interface CompetitorReport {
  chain: string;
  fromBlock: bigint;
  toBlock: bigint;
  minutes: number;
  swapTxs: number;
  arbTxs: number;
  analysed: number;
  arbs: ArbTx[];
}

const word = (data: Hex, i: number) => BigInt("0x" + data.slice(2 + 64 * i, 2 + 64 * (i + 1)));
const signed = (x: bigint, bits: number) => (x >= 1n << BigInt(bits - 1) ? x - (1n << BigInt(bits)) : x);

/**
 * Input token of one swap event, as a logical (ERC20) token of the pool.
 *  - v3 forks / Slipstream / Algebra / Pancake: amount0, amount1 are the pool's deltas; positive = paid in.
 *  - v2 / Camelot v2 / Aerodrome v2: amount0In, amount1In, amount0Out, amount1Out.
 *  - v4: amount0, amount1 are the swapper's deltas; negative = paid in. Currency 0x0 is native ETH,
 *    whose logical token is the pool's WETH side.
 */
function swapInput(l: Log, p: PoolInfo): Address | undefined {
  const data = l.data as Hex;
  if (l.topics[0] === V4_SWAP) {
    const a0 = signed(word(data, 0), 256);
    const key = p.v4Key!;
    const logical = (c: Address) => (c === zeroAddress ? (p.token0 === key.currency1 ? p.token1 : p.token0) : c);
    return a0 < 0n ? logical(key.currency0) : logical(key.currency1);
  }
  if (l.topics[0] === SWAP_TOPICS[2] || l.topics[0] === SWAP_TOPICS[3]) {
    return word(data, 0) > 0n ? p.token0 : word(data, 1) > 0n ? p.token1 : undefined;
  }
  const a0 = signed(word(data, 0), 256);
  return a0 > 0n ? p.token0 : p.token1;
}

async function getLogsChunked(client: PublicClient, params: any, from: bigint, to: bigint, step: bigint): Promise<Log[]> {
  const ranges: [bigint, bigint][] = [];
  for (let b = from; b <= to; b += step) ranges.push([b, b + step - 1n > to ? to : b + step - 1n]);
  const out = await mapLimit(ranges, 3, async ([a, z]) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await client.request({ method: "eth_getLogs", params: [{ ...params, fromBlock: toHex(a), toBlock: toHex(z) }] } as any)) as any[];
      } catch (e) {
        if (attempt >= 5) throw e;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  });
  return out.flat().map((l: any) => ({ ...l, blockNumber: BigInt(l.blockNumber), transactionIndex: Number(l.transactionIndex), logIndex: Number(l.logIndex) }));
}

export async function analyseCompetitors(scanner: Scanner, chain: string, minutes: number, maxReceipts = 1500): Promise<CompetitorReport> {
  const { client, pools, decimals, market, aTokens } = await scanner.poolsFor(chain);
  const head = (await client.getBlockNumber()) - 1n;
  const [bHead, bPast] = await Promise.all([client.getBlock({ blockNumber: head }), client.getBlock({ blockNumber: head - 1000n })]);
  const secPerBlock = Number(bHead.timestamp - bPast.timestamp) / 1000;
  const fromBlock = head - BigInt(Math.ceil((minutes * 60) / secPerBlock));

  // Pool lookup: address (or v4 pool id) -> pool
  const byAddr = new Map<string, PoolInfo>();
  const v4ByManager = new Map<Address, Map<string, PoolInfo>>();
  for (const p of pools) {
    if (p.venue.type === "v4") {
      const m = v4ByManager.get(p.address) ?? new Map();
      m.set(p.id.toLowerCase(), p);
      v4ByManager.set(p.address, m);
    } else byAddr.set(p.address.toLowerCase(), p);
  }
  const step = secPerBlock < 1 ? 1000n : 2000n;
  const logs: Log[] = [];
  const addrs = [...byAddr.keys()];
  // Public RPCs cap eth_getLogs at 10 addresses per request.
  for (let i = 0; i < addrs.length; i += 10) {
    logs.push(...(await getLogsChunked(client, { address: addrs.slice(i, i + 10), topics: [SWAP_TOPICS] }, fromBlock, head, step)));
  }
  for (const [manager, ids] of v4ByManager) {
    logs.push(...(await getLogsChunked(client, { address: manager, topics: [V4_SWAP, [...ids.keys()]] }, fromBlock, head, step)));
  }
  const poolOf = (l: Log): PoolInfo | undefined =>
    l.topics[0] === V4_SWAP ? v4ByManager.get(getAddress(l.address))?.get(String(l.topics[1]).toLowerCase()) : byAddr.get(l.address.toLowerCase());

  // Group swaps by transaction with each swap's input token; record swap positions per pool per
  // block (for backrun detection).
  const byTx = new Map<Hex, { block: bigint; index: number; swaps: { pool: PoolInfo; tokenIn: Address }[] }>();
  const firstSwapIndex = new Map<string, number[]>(); // `${block}|${poolId}` -> tx indexes that swapped it
  for (const l of logs) {
    const p = poolOf(l);
    if (!p) continue;
    const tokenIn = swapInput(l, p);
    if (!tokenIn) continue;
    const h = l.transactionHash as Hex;
    const e = byTx.get(h) ?? { block: l.blockNumber!, index: l.transactionIndex!, swaps: [] };
    e.swaps.push({ pool: p, tokenIn });
    byTx.set(h, e);
    const k = `${l.blockNumber}|${p.id}`;
    const arr = firstSwapIndex.get(k) ?? [];
    arr.push(l.transactionIndex!);
    firstSwapIndex.set(k, arr);
  }

  // Arbitrage round trips: one transaction sells A for B in one watched pool and B for A in another
  // pool of the same pair. Same-direction splits (aggregators routing a user's swap) are excluded.
  const candidates: { hash: Hex; block: bigint; index: number; pools: PoolInfo[] }[] = [];
  for (const [hash, e] of byTx) {
    const pairs = new Map<string, { pool: PoolInfo; tokenIn: Address }[]>();
    for (const s of e.swaps) {
      const k = `${s.pool.token0}|${s.pool.token1}`;
      pairs.set(k, [...(pairs.get(k) ?? []), s]);
    }
    for (const swaps of pairs.values()) {
      const ins = new Set(swaps.map((s) => s.tokenIn));
      const pools = [...new Set(swaps.map((s) => s.pool))];
      if (ins.size === 2 && pools.length >= 2) {
        candidates.push({ hash, block: e.block, index: e.index, pools });
        break;
      }
    }
  }
  // Analyse the most recent ones if there are too many for the public RPC.
  candidates.sort((a, b) => (a.block > b.block ? -1 : 1));
  const sample = candidates.slice(0, maxReceipts);

  const price = (token: Address) => {
    const s = market.assets.get(token);
    return s?.priceUsd8 ? { usd: Number(s.priceUsd8) / 1e8, dec: decimals.get(token)! } : undefined;
  };
  const ethUsd = Number(market.assets.get(scanner.cfg.chains.find((c) => c.name === chain)!.assets[scanner.cfg.chains.find((c) => c.name === chain)!.gasToken])!.priceUsd8) / 1e8;

  const baseFees = new Map<bigint, Promise<bigint>>();
  const baseFeeAt = (b: bigint) => {
    if (!baseFees.has(b)) baseFees.set(b, client.getBlock({ blockNumber: b }).then((x) => x.baseFeePerGas ?? 0n));
    return baseFees.get(b)!;
  };
  const watched = new Set(pools.map((p) => p.address.toLowerCase()));
  const lenders = new Map<string, string>([
    ...[...aTokens.values()].map((a) => [a.toLowerCase(), "Aave flash loan"] as [string, string]),
    ["0xba12222222228d8ba445958a75a0704d566bf2c8", "Balancer v2 flash loan"],
    ["0xba1333333333a1ba1108e8412f11850a5c319ba9", "Balancer v3 flash loan"],
    ["0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb", "Morpho flash loan"],
  ]);

  const arbs = await mapLimit(sample, 6, async (c): Promise<ArbTx> => {
    const [rc, tx] = await Promise.all([
      client.request({ method: "eth_getTransactionReceipt", params: [c.hash] } as any) as Promise<any>,
      client.getTransaction({ hash: c.hash }),
    ]);
    const parties = new Set([tx.from.toLowerCase(), (tx.to ?? zeroAddress).toLowerCase()]);
    const flows = new Map<Address, bigint>();
    let sizeUsd = 0;
    let capital = "own funds / other";
    for (const l of rc.logs as any[]) {
      if (l.topics[0] !== TRANSFER || l.topics.length !== 3) continue;
      const from = ("0x" + l.topics[1].slice(26)).toLowerCase();
      const to = ("0x" + l.topics[2].slice(26)).toLowerCase();
      const amt = BigInt(l.data);
      const token = getAddress(l.address);
      if (parties.has(to)) flows.set(token, (flows.get(token) ?? 0n) + amt);
      if (parties.has(from)) flows.set(token, (flows.get(token) ?? 0n) - amt);
      if (lenders.has(from) && !watched.has(to)) capital = lenders.get(from)!;
      // Trade size: the largest amount sent into a watched pool.
      if (watched.has(to)) {
        const p = price(token);
        if (p) sizeUsd = Math.max(sizeUsd, (Number(amt) / 10 ** p.dec) * p.usd);
      }
    }
    // Reaction: transactions between the latest earlier swap on one of these pools and this one.
    const earlier = c.pools.flatMap((p) => (firstSwapIndex.get(`${c.block}|${p.id}`) ?? []).filter((i) => i < c.index));
    const triggerGap = earlier.length ? c.index - Math.max(...earlier) : undefined;
    const baseFee = await baseFeeAt(c.block);
    const effective = BigInt(rc.effectiveGasPrice ?? 0);
    const tipWei = effective > baseFee ? effective - baseFee : 0n;
    const gasUsed = BigInt(rc.gasUsed);
    let profitUsd = 0;
    let unpriced = 0;
    for (const [token, amt] of flows) {
      if (amt === 0n) continue;
      const p = price(token);
      if (!p) {
        unpriced++;
        continue;
      }
      profitUsd += (Number(amt) / 10 ** p.dec) * p.usd;
    }
    const l2Wei = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice ?? 0);
    const l1Wei = rc.l1Fee ? BigInt(rc.l1Fee) : 0n;
    const gasUsd = (Number(l2Wei + l1Wei) / 1e18) * ethUsd;
    const sameBlockBackrun = c.pools.some((p) => (firstSwapIndex.get(`${c.block}|${p.id}`) ?? []).some((i) => i < c.index));
    return {
      hash: c.hash,
      block: c.block,
      index: c.index,
      from: tx.from,
      to: tx.to,
      pair: c.pools[0].label.split(":")[0] && `${c.pools[0].token0.slice(0, 6)}/${c.pools[0].token1.slice(0, 6)}`,
      pools: c.pools.map((p) => p.label),
      sameBlockBackrun,
      profitUsd,
      gasUsd,
      netUsd: profitUsd - gasUsd,
      unpricedTokens: unpriced,
      nativeLeg: c.pools.some((p) => p.native),
      status: rc.status === "0x1" ? "success" : "reverted",
      triggerGap,
      tipGwei: Number(tipWei) / 1e9,
      tipUsd: (Number(tipWei * gasUsed) / 1e18) * ethUsd,
      gasUsed: Number(gasUsed),
      sizeUsd,
      capital,
    };
  });
  return { chain, fromBlock, toBlock: head, minutes, swapTxs: byTx.size, arbTxs: candidates.length, analysed: arbs.length, arbs };
}

const usd = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(Math.abs(x) < 1 ? 4 : 2)}`;
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");

/** How the bots win: reaction distance, priority fee, size, capital, gas — overall and per bot. */
function playbook(arbs: ArbTx[]): string[] {
  const n = arbs.length;
  const gap = (a: ArbTx) => a.triggerGap;
  const bucket = (xs: ArbTx[], f: (a: ArbTx) => boolean) => pct(xs.filter(f).length, xs.length);
  const mix = (xs: ArbTx[]) => {
    const m = new Map<string, number>();
    for (const a of xs) m.set(a.capital, (m.get(a.capital) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v, xs.length)}`).join(", ");
  };
  const L = [
    "How they win (successful round trips):",
    "",
    "| Measure | Value |",
    "|---|---|",
    `| Landed right after the swap that opened the gap (next tx) | ${bucket(arbs, (a) => gap(a) === 1)} |`,
    `| 2-5 txs after it / more than 5 after / no earlier swap in that block | ${bucket(arbs, (a) => gap(a) !== undefined && gap(a)! >= 2 && gap(a)! <= 5)} / ${bucket(arbs, (a) => (gap(a) ?? 0) > 5)} / ${bucket(arbs, (a) => gap(a) === undefined)} |`,
    `| Priority fee: median / 90th percentile (gwei) | ${median(arbs.map((a) => a.tipGwei)).toPrecision(3)} / ${[...arbs.map((a) => a.tipGwei)].sort((a, b) => a - b)[Math.floor(n * 0.9)]?.toPrecision(3) ?? "n/a"} |`,
    `| Priority fee paid per trade: median / max (USD) | ${usd(median(arbs.map((a) => a.tipUsd)))} / ${n ? usd(Math.max(...arbs.map((a) => a.tipUsd))) : "n/a"} |`,
    `| Trade size: median (USD); under $100 / $100-1k / $1k-10k / over $10k | ${usd(median(arbs.map((a) => a.sizeUsd)))}; ${bucket(arbs, (a) => a.sizeUsd < 100)} / ${bucket(arbs, (a) => a.sizeUsd >= 100 && a.sizeUsd < 1000)} / ${bucket(arbs, (a) => a.sizeUsd >= 1000 && a.sizeUsd < 10000)} / ${bucket(arbs, (a) => a.sizeUsd >= 10000)} |`,
    `| Capital source | ${mix(arbs)} |`,
    `| Gas used: median | ${Math.round(median(arbs.map((a) => a.gasUsed)))} |`,
    "",
    "Per bot:",
    "",
    "| Contract | Trades | Net | Next-tx reaction | Median tip (gwei / $) | Median size | Capital | Median gas |",
    "|---|---|---|---|---|---|---|---|",
  ];
  const byBot = new Map<string, ArbTx[]>();
  for (const a of arbs) byBot.set((a.to ?? "creation").toLowerCase(), [...(byBot.get((a.to ?? "creation").toLowerCase()) ?? []), a]);
  for (const [bot, xs] of [...byBot].sort((a, b) => b[1].length - a[1].length).slice(0, 10)) {
    L.push(
      `| \`${bot}\` | ${xs.length} | ${usd(xs.filter((a) => !a.nativeLeg).reduce((s, a) => s + a.netUsd, 0))} | ${bucket(xs, (a) => gap(a) === 1)} | ` +
        `${median(xs.map((a) => a.tipGwei)).toPrecision(3)} / ${usd(median(xs.map((a) => a.tipUsd)))} | ${usd(median(xs.map((a) => a.sizeUsd)))} | ${mix(xs)} | ${Math.round(median(xs.map((a) => a.gasUsed)))} |`,
    );
  }
  return L;
}

export function competitorMarkdown(r: CompetitorReport, symbols: Map<Address, string>): string {
  const okAll = r.arbs.filter((a) => a.status === "success");
  const ok = okAll.filter((a) => !a.nativeLeg); // profit is measurable from ERC20 transfers
  const reverted = r.arbs.filter((a) => a.status !== "success");
  const profitable = ok.filter((a) => a.netUsd > 0);
  const scale = r.arbTxs / Math.max(1, r.analysed);
  const perDay = (x: number) => (x * scale * 1440) / r.minutes;
  const sym = (s: string) => s.split("/").map((t) => [...symbols].find(([a]) => a.toLowerCase().startsWith(t.toLowerCase()))?.[1] ?? t).join("/");
  const bots = new Map<string, { n: number; net: number; backrun: number }>();
  for (const a of ok) {
    const k = (a.to ?? "contract creation").toLowerCase();
    const b = bots.get(k) ?? { n: 0, net: 0, backrun: 0 };
    b.n++;
    b.net += a.netUsd;
    if (a.sameBlockBackrun) b.backrun++;
    bots.set(k, b);
  }
  const pairs = new Map<string, { n: number; net: number }>();
  for (const a of ok) {
    const k = sym(a.pair);
    const p = pairs.get(k) ?? { n: 0, net: 0 };
    p.n++;
    p.net += a.netUsd;
    pairs.set(k, p);
  }
  const L = [
    `## ${r.chain}: blocks ${r.fromBlock}–${r.toBlock} (~${r.minutes} min)`,
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Transactions swapping in watched pools | ${r.swapTxs} |`,
    `| Arbitrage round trips (same pair through >= 2 watched pools in one tx) | ${r.arbTxs}${r.analysed < r.arbTxs ? ` (most recent ${r.analysed} analysed)` : ""} |`,
    `| Successful / reverted | ${okAll.length} / ${reverted.length} |`,
    `| ...of which a leg used a native-ETH pool (profit not measurable from token transfers; excluded below) | ${okAll.length - ok.length} |`,
    `| Successful with positive net after gas | ${profitable.length} |`,
    `| Net profit, all successful (analysed) | ${usd(ok.reduce((s, a) => s + a.netUsd, 0))} |`,
    `| Median net per successful trade | ${usd(median(ok.map((a) => a.netUsd)))} |`,
    `| Largest single net | ${ok.length ? usd(Math.max(...ok.map((a) => a.netUsd))) : "n/a"} |`,
    `| Median gas cost | ${usd(median(r.arbs.map((a) => a.gasUsd)))} |`,
    `| Same-block backruns (another tx swapped the pool earlier in that block) | ${ok.filter((a) => a.sameBlockBackrun).length} of ${ok.length} |`,
    `| Median position in block (tx index) | ${median(ok.map((a) => a.index))} |`,
    `| Extrapolated per day: round trips (all) / net profit (measurable ones) | ${Math.round(perDay(okAll.length))} / ${usd(perDay(ok.reduce((s, a) => s + a.netUsd, 0)))} |`,
    "",
    "Busiest bot contracts:",
    "",
    "| Contract | Trades | Net profit | Same-block backruns |",
    "|---|---|---|---|",
    ...[...bots].sort((a, b) => b[1].n - a[1].n).slice(0, 8).map(([k, b]) => `| \`${k}\` | ${b.n} | ${usd(b.net)} | ${b.backrun} |`),
    "",
    "By pair:",
    "",
    "| Pair | Trades | Net profit |",
    "|---|---|---|",
    ...[...pairs].sort((a, b) => b[1].n - a[1].n).map(([k, p]) => `| ${k} | ${p.n} | ${usd(p.net)} |`),
    "",
    "Most profitable trades:",
    "",
    "| Block | Tx | Pools | Net | Gas | Backrun |",
    "|---|---|---|---|---|---|",
    ...[...ok].sort((a, b) => b.netUsd - a.netUsd).slice(0, 10).map((a) => `| ${a.block} | \`${a.hash.slice(0, 18)}…\` | ${a.pools.join(" + ")} | ${usd(a.netUsd)} | ${usd(a.gasUsd)} | ${a.sameBlockBackrun ? "yes" : "no"} |`),
    "",
  ];
  L.push(...playbook(okAll), "");
  if (ok.some((a) => a.unpricedTokens)) L.push(`Note: ${ok.filter((a) => a.unpricedTokens).length} trades also moved tokens without an Aave price; those amounts are not counted.`, "");
  return L.join("\n");
}
