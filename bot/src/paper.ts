// Paper trader (read-only). Watches every new block on one chain, reacts to swaps in watched pools,
// decides which round trips it WOULD send, and then judges each decision against what really
// happened: the exact trade is simulated through the real receiver code at the state just before
// the block it would have landed in, and the logs show whether a competitor arbitraged the same
// pools first. Nothing is signed or sent.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { toHex, zeroAddress, type Address, type Hex, type Log } from "viem";
import { multicallAt } from "./chain.ts";
import { SWAP_TOPICS, V4_SWAP, swapInput } from "./competitors.ts";
import { DATA_DIR } from "./ledger.ts";
import type { ChainRuntime, Route, RouteEval, Scanner, SimRecord } from "./scanner.ts";
import { rateFor } from "./marginal.ts";
import { TickCache, makeLocalQuoter, marginalFromSnapshot, parseSnapshot, stateReads, type PoolSnapshot } from "./localpool.ts";

/** Float and rounding tolerance on the local marginal bound (it has no probe impact to cover). */
const LOCAL_SLACK = 0.0002;


export type Verdict = "won" | "contested" | "lost" | "gone" | "unknown";

export interface PaperDecision {
  id: number;
  chain: string;
  routeId: string;
  sizeUsd: number;
  amount: string;
  quotedNetUsd: number;
  gasUsd: number;
  /** block whose state the decision was based on */
  stateBlock: string;
  /** chain head when the decision was made */
  headAtDecision: string;
  /** earliest block our transaction could land in */
  targetBlock: string;
  /** ms from first seeing stateBlock to the decision */
  reactionMs: number;
  verdict?: Verdict;
  /** simulated profit at the target block's starting state, USD (before gas) */
  simProfitUsd?: number;
  simReason?: string;
  /** paper P&L: simulated profit minus gas if the trade would have executed, else -gas if it would revert */
  paperPnlUsd?: number;
  competitor?: { block: string; index: number; tx: Hex; to: Address | null };
  /**
   * Counterfactual "instant" bot: the same trade landing in the block right after the state block.
   * Simulated profit there (USD, before gas), and whether a competitor round trip took it in that block.
   */
  instantSimProfitUsd?: number;
  instantReason?: string;
  instantContested?: boolean;
  /** the simulated proceeds at the decision's state block equal the local quote exactly */
  localExact?: boolean;
}

export interface PaperSummary {
  chain: string;
  startedAt: string;
  endedAt?: string;
  blocksSeen: number;
  blocksProcessed: number;
  avgCycleMs: number;
  changedPoolsPerBlock: number;
  routesTouched: number;
  routesPassedLocalCheck: number;
  localBoundChecks: number;
  localBoundViolations: number;
  localQuoteExact: number;
  localQuoteMismatch: number;
  localQuoteUnavailable: number;
  overlappingSkipped: number;
  localQuoteUnavailableWhy: Record<string, number>;
  decisions: number;
  verdicts: Record<string, number>;
  paperPnlUsd: number;
  decisionsList: PaperDecision[];
}

export class PaperTrader {
  private stopped = false;
  private decisions: PaperDecision[] = [];
  private pending: Promise<void>[] = [];
  private stats = { blocksSeen: 0, processed: 0, cycleMs: 0, changed: 0, affected: 0, candidates: 0, localChecks: 0, localViolations: 0, readMs: 0, quoteMs: 0, quoted: 0, localUnavailable: 0, localExact: 0, localMismatch: 0, overlapping: 0 };
  /** why exact local quotes were unavailable, by reason */
  readonly unavailableWhy = new Map<string, number>();
  readonly startedAt = new Date().toISOString();
  private readonly file: string;

  private scanner: Scanner;
  private chain: string;
  private log: (msg: string) => void;

  constructor(scanner: Scanner, chain: string, log: (msg: string) => void) {
    this.scanner = scanner;
    this.chain = chain;
    this.log = log;
    mkdirSync(DATA_DIR + "paper", { recursive: true });
    this.file = `${DATA_DIR}paper/${chain}-${this.startedAt.replace(/[:.]/g, "-")}`;
  }

  stop() {
    this.stopped = true;
  }

  private record(type: string, payload: object) {
    appendFileSync(this.file + ".jsonl", JSON.stringify({ ts: new Date().toISOString(), type, ...payload }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n");
  }

  async run(minutes: number): Promise<PaperSummary> {
    const rt = await this.scanner.runtime(this.chain);
    const routesByPool = new Map<string, Route[]>();
    for (const r of rt.routes) for (const p of [r.first, r.second]) routesByPool.set(p.id, [...(routesByPool.get(p.id) ?? []), r]);
    // $5-equivalent probe amounts for pools whose marginal rate comes from getAmountOut.
    const probe = (token: Address) => {
      const p = rt.cache?.market.assets.get(token)?.priceUsd8 ?? 0n;
      const d = BigInt(rt.decimals.get(token) ?? 18);
      // $1: the smallest size ever traded, so the rate bounds every size used (rates only fall with size)
      return p > 0n ? (10n ** d * 10n ** 8n) / p : 10n ** d;
    };
    const fp = rt.pools.map((p) => ({ pool: p, calls: stateReads(p, probe) }));
    const flat = fp.flatMap((f) => f.calls);
    // Warm the tick cache for every concentrated pool before the loop starts.
    const ticks = new TickCache();
    {
      const b0 = await rt.client.getBlockNumber();
      const r0 = await multicallAt(rt.client, flat, b0, 60);
      let j = 0;
      for (const f of fp) {
        const snap = parseSnapshot(f.pool, r0.slice(j, j + f.calls.length));
        j += f.calls.length;
        if (snap.cl) await ticks.fetch(rt.client, f.pool, snap.cl.tick, b0).catch(() => undefined);
      }
    }
    let prev: string[] | undefined;
    let lastBlock = 0n;
    let lastCacheRefresh = Date.now();
    const until = Date.now() + minutes * 60_000;
    const minNet = this.scanner.cfg.minNetUsd;
    this.log(`paper trading on ${this.chain}: ${rt.pools.length} pools, ${rt.routes.length} routes; lender ${rt.cfg.lender.type}; nothing is sent`);

    while (!this.stopped && Date.now() < until) {
      const head = await rt.client.getBlockNumber();
      if (head <= lastBlock) {
        await new Promise((r) => setTimeout(r, 40));
        continue;
      }
      const seenAt = Date.now();
      this.stats.blocksSeen += lastBlock ? Number(head - lastBlock) : 1;
      lastBlock = head;
      const block = head;
      try {
        // 1. Which pools changed since the last processed block?
        const tRead = Date.now();
        const res = await multicallAt(rt.client, flat, block, 60);
        this.stats.readMs += Date.now() - tRead;
        let k = 0;
        const now = fp.map((f) => f.calls.map(() => JSON.stringify(res[k++] ?? null, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).join("|"));
        const changed = prev ? fp.filter((_, i) => now[i] !== prev![i]).map((f) => f.pool) : [];
        prev = now;
        this.stats.changed += changed.length;
        if (!changed.length) {
          this.stats.processed++;
          this.stats.cycleMs += Date.now() - seenAt;
          continue;
        }
        // 2. Local marginal rates from the same read; only routes through changed pools whose
        //    marginal round-trip rate can beat break-even are quoted (usually none).
        const rates = new Map<string, { r01: number; r10: number } | undefined>();
        const snaps = new Map<string, PoolSnapshot>();
        k = 0;
        for (const f of fp) {
          const snap = parseSnapshot(f.pool, res.slice(k, k + f.calls.length));
          k += f.calls.length;
          snaps.set(f.pool.id, snap);
          rates.set(f.pool.id, marginalFromSnapshot(snap, probe));
        }
        // Keep tick data fresh for moved pools (background; decisions use what is cached).
        for (const p of changed) {
          const s = snaps.get(p.id);
          if (s?.cl && ticks.stale(p, s.cl.tick, 120_000)) ticks.fetch(rt.client, p, s.cl.tick, block).catch(() => undefined);
        }
        const affected = [...new Set(changed.flatMap((p) => routesByPool.get(p.id) ?? []))];
        const mp = new Map<string, number>();
        const candidates = affected.filter((r) => {
          const a = rates.get(r.first.id);
          const b = rates.get(r.second.id);
          if (!a || !b) return true; // no local model: quote it
          const m = rateFor(r.first, a, r.borrow) * rateFor(r.second, b, r.mid);
          mp.set(r.id, m);
          return m >= 1 + this.scanner.cfg.paper.minEdgeBps / 1e4;
        });
        this.stats.affected += affected.length;
        this.stats.candidates += candidates.length;
        if (!candidates.length) {
          this.stats.processed++;
          this.stats.cycleMs += Date.now() - seenAt;
          continue;
        }
        if (Date.now() - lastCacheRefresh > 30_000) {
          // Background refresh: lender balances, prices and gas; never blocks the block loop.
          lastCacheRefresh = Date.now();
          this.scanner.refreshCache(rt, block).catch((e) => this.log(`cache refresh failed: ${(e as Error).message.slice(0, 120)}`));
        }
        // One route per price gap: borrowing either token through the same two pools is the same gap.
        const perGap = new Map<string, Route>();
        for (const r of candidates) {
          const cur = perGap.get(r.gapKey);
          if (!cur || (mp.get(r.id) ?? Infinity) > (mp.get(cur.id) ?? Infinity)) perGap.set(r.gapKey, r);
        }
        const tQuote = Date.now();
        // Exact local quotes only: a decision never waits on the network.
        const local = makeLocalQuoter(snaps, ticks, BigInt(this.scanner.cfg.gasModel.v2SwapGas), true);
        const { evals } = await this.scanner.evaluate(rt, [...perGap.values()], block, false, true, true, this.scanner.cfg.paper.sizesUsd, local);
        for (const ev of evals)
          for (const s of ev.sizes)
            if (s.skip?.includes("local quote unavailable")) {
              this.stats.localUnavailable++;
              const why = s.skip.replace(/^.*local quote unavailable: /, "").replace(/0x[0-9a-fA-F]+|-?\d+/g, "#").slice(0, 80);
              this.unavailableWhy.set(why, (this.unavailableWhy.get(why) ?? 0) + 1);
            }
        this.stats.quoteMs += Date.now() - tQuote;
        this.stats.quoted++;
        // Soundness of the local model: a real quote must never beat the local marginal bound.
        for (const ev of evals) {
          const m = mp.get(ev.route.id);
          if (m === undefined) continue;
          for (const s of ev.sizes) {
            if (s.leg2Out === undefined) continue;
            this.stats.localChecks++;
            const actual = Number(s.leg2Out) / Number(s.amount);
            if (actual > m * (1 + LOCAL_SLACK)) {
              this.stats.localViolations++;
              this.log(`local bound violated on ${ev.route.id} $${s.sizeUsd}: actual ${actual} > marginal ${m}`);
            }
          }
        }
        // 3. Decide: best route per price gap with positive net after gas.
        const byGap = new Map<string, RouteEval>();
        for (const ev of evals) {
          if (!ev.best || ev.best.netUsd! <= minNet) continue;
          const cur = byGap.get(ev.route.gapKey);
          if (!cur || ev.best.netUsd! > cur.best!.netUsd!) byGap.set(ev.route.gapKey, ev);
        }
        const headNow = byGap.size ? await rt.client.getBlockNumber() : block;
        // Gaps sharing a pool interact (the first trade moves that pool's price for the rest), so
        // per block take the best net first and skip any later route that touches a pool already used.
        const usedPools = new Set<string>();
        const chosen: RouteEval[] = [];
        for (const ev of [...byGap.values()].sort((a, b) => b.best!.netUsd! - a.best!.netUsd!)) {
          if (usedPools.has(ev.route.first.id) || usedPools.has(ev.route.second.id)) {
            this.stats.overlapping++;
            continue;
          }
          usedPools.add(ev.route.first.id);
          usedPools.add(ev.route.second.id);
          chosen.push(ev);
        }
        for (const ev of chosen) {
          const d: PaperDecision = {
            id: this.decisions.length + 1,
            chain: this.chain,
            routeId: ev.route.id,
            sizeUsd: ev.best!.sizeUsd,
            amount: String(ev.best!.amount),
            quotedNetUsd: ev.best!.netUsd!,
            gasUsd: ev.best!.gasUsd!,
            stateBlock: String(block),
            headAtDecision: String(headNow),
            targetBlock: String(headNow + 1n),
            reactionMs: Date.now() - seenAt,
          };
          this.decisions.push(d);
          this.record("decision", d);
          this.log(`DECIDE #${d.id} ${d.routeId} $${d.sizeUsd} quoted net $${d.quotedNetUsd.toFixed(4)} @state ${block}, head ${headNow}, ${d.reactionMs} ms`);
          this.pending.push(this.judge(rt, ev, d));
        }
      } catch (e) {
        this.log(`block ${block}: ${(e as Error).message.split("\n")[0].slice(0, 160)}`);
      }
      this.stats.processed++;
      this.stats.cycleMs += Date.now() - seenAt;
      if (this.stats.processed % 50 === 0) this.log(this.progress());
    }
    await Promise.all(this.pending);
    const s = this.summary();
    writeFileSync(this.file + ".json", JSON.stringify(s, null, 2));
    return s;
  }

  private progress() {
    return (
      `${this.stats.processed} blocks processed of ${this.stats.blocksSeen} produced, avg cycle ${Math.round(this.stats.cycleMs / Math.max(1, this.stats.processed))} ms; ` +
      `state read avg ${Math.round(this.stats.readMs / Math.max(1, this.stats.processed))} ms, quoting ${this.stats.quoted} blocks avg ${Math.round(this.stats.quoteMs / Math.max(1, this.stats.quoted))} ms; ` +
      `${this.stats.affected} routes touched, ${this.stats.candidates} passed the local marginal check; ` +
      `local-bound checks ${this.stats.localChecks}, violations ${this.stats.localViolations}; ${this.decisions.length} decisions`
    );
  }

  /** Wait for the target block, then simulate the exact trade there and look for a competitor. */
  private async judge(rt: ChainRuntime, ev: RouteEval, d: PaperDecision) {
    const target = BigInt(d.targetBlock);
    try {
      for (let i = 0; i < 100 && (await rt.client.getBlockNumber()) < target + 1n; i++) await new Promise((r) => setTimeout(r, 200));
      // The trade at the top of the target block sees the state at the end of target - 1.
      const sim: SimRecord = await this.scanner.simulateAt(rt, ev, target - 1n, "paper-trade");
      const dec = rt.decimals.get(ev.route.borrow)!;
      const price = Number(rt.cache?.market.assets.get(ev.route.borrow)?.priceUsd8 ?? 0n) / 1e8;
      d.simProfitUsd = sim.ok ? (Number(sim.simProfit) / 10 ** dec) * price : 0;
      d.simReason = sim.ok ? "executed" : sim.reason;
      d.paperPnlUsd = sim.ok ? d.simProfitUsd - d.gasUsd : -d.gasUsd;
      d.competitor = await this.findCompetitor(rt, ev.route, BigInt(d.stateBlock) + 1n, target);
      // Speed upside: what an instant bot (landing in stateBlock + 1) would have got.
      const state = BigInt(d.stateBlock);
      let atState: SimRecord = sim;
      if (target - 1n > state) {
        atState = await this.scanner.simulateAt(rt, ev, state, "paper-trade");
        d.instantSimProfitUsd = atState.ok ? (Number(atState.simProfit) / 10 ** dec) * price : 0;
        d.instantReason = atState.ok ? "executed" : atState.reason;
        d.instantContested = d.competitor !== undefined && BigInt(d.competitor.block) === state + 1n;
      } else {
        d.instantSimProfitUsd = d.simProfitUsd;
        d.instantReason = d.simReason;
        d.instantContested = d.competitor !== undefined && BigInt(d.competitor.block) === target;
      }
      // Exactness: the receiver run on the state the decision saw must return exactly the local quote.
      if (atState.simProceeds !== undefined) {
        d.localExact = atState.simProceeds === String(ev.best!.leg2Out);
        if (d.localExact) this.stats.localExact++;
        else {
          this.stats.localMismatch++;
          this.log(`local quote mismatch on #${d.id}: local ${ev.best!.leg2Out} vs simulated ${atState.simProceeds}`);
        }
      }
      const compBlock = d.competitor ? BigInt(d.competitor.block) : undefined;
      d.verdict =
        compBlock !== undefined && compBlock < target ? "lost" : compBlock === target ? "contested" : sim.ok && d.paperPnlUsd > 0 ? "won" : "gone";
    } catch (e) {
      d.verdict = "unknown";
      d.simReason = (e as Error).message.split("\n")[0].slice(0, 160);
    }
    this.record("verdict", d);
    this.log(
      `VERDICT #${d.id} ${d.verdict}: sim at ${target - 1n} ${d.simReason}` +
        (d.competitor ? `; competitor ${d.competitor.tx.slice(0, 12)}… in block ${d.competitor.block} (index ${d.competitor.index})` : "") +
        `; paper P&L $${(d.paperPnlUsd ?? 0).toFixed(4)}`,
    );
  }

  /** A transaction that traded the route's pair in opposite directions through both of its pools. */
  private async findCompetitor(rt: ChainRuntime, route: Route, from: bigint, to: bigint) {
    const pools = [route.first, route.second];
    const logs: Log[] = [];
    const plain = pools.filter((p) => p.venue.type !== "v4");
    if (plain.length) {
      logs.push(
        ...((await rt.client.request({
          method: "eth_getLogs",
          params: [{ address: plain.map((p) => p.address), topics: [SWAP_TOPICS], fromBlock: toHex(from), toBlock: toHex(to) }],
        } as any)) as Log[]),
      );
    }
    for (const p of pools.filter((x) => x.venue.type === "v4")) {
      logs.push(
        ...((await rt.client.request({
          method: "eth_getLogs",
          params: [{ address: p.address, topics: [V4_SWAP, p.id], fromBlock: toHex(from), toBlock: toHex(to) }],
        } as any)) as Log[]),
      );
    }
    const byTx = new Map<string, { block: bigint; index: number; ins: Set<string>; pools: Set<string> }>();
    for (const l of logs) {
      const pool = pools.find((p) => (l.topics[0] === V4_SWAP ? String(l.topics[1]).toLowerCase() === p.id.toLowerCase() : l.address.toLowerCase() === p.address.toLowerCase()));
      if (!pool) continue;
      const tokenIn = swapInput({ ...l, data: l.data } as Log, pool);
      if (!tokenIn) continue;
      const e = byTx.get(l.transactionHash!) ?? { block: BigInt(l.blockNumber as any), index: Number(l.transactionIndex as any), ins: new Set(), pools: new Set() };
      e.ins.add(tokenIn);
      e.pools.add(pool.id);
      byTx.set(l.transactionHash!, e);
    }
    const hit = [...byTx].filter(([, e]) => e.ins.size === 2 && e.pools.size === 2).sort((a, b) => (a[1].block === b[1].block ? a[1].index - b[1].index : a[1].block < b[1].block ? -1 : 1))[0];
    if (!hit) return undefined;
    const tx = await rt.client.getTransaction({ hash: hit[0] as Hex });
    return { block: String(hit[1].block), index: hit[1].index, tx: hit[0] as Hex, to: tx.to ?? zeroAddress };
  }

  summary(): PaperSummary {
    const verdicts: Record<string, number> = {};
    for (const d of this.decisions) verdicts[d.verdict ?? "pending"] = (verdicts[d.verdict ?? "pending"] ?? 0) + 1;
    return {
      chain: this.chain,
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      blocksSeen: this.stats.blocksSeen,
      blocksProcessed: this.stats.processed,
      avgCycleMs: Math.round(this.stats.cycleMs / Math.max(1, this.stats.processed)),
      changedPoolsPerBlock: this.stats.changed / Math.max(1, this.stats.processed),
      routesTouched: this.stats.affected,
      routesPassedLocalCheck: this.stats.candidates,
      localBoundChecks: this.stats.localChecks,
      localBoundViolations: this.stats.localViolations,
      localQuoteExact: this.stats.localExact,
      localQuoteMismatch: this.stats.localMismatch,
      localQuoteUnavailable: this.stats.localUnavailable,
      overlappingSkipped: this.stats.overlapping,
      localQuoteUnavailableWhy: Object.fromEntries([...this.unavailableWhy].sort((a, b) => b[1] - a[1]).slice(0, 8)),
      decisions: this.decisions.length,
      verdicts,
      paperPnlUsd: this.decisions.reduce((s, d) => s + (d.paperPnlUsd ?? 0), 0),
      decisionsList: this.decisions,
    };
  }
}

export function paperMarkdown(s: PaperSummary): string {
  const won = s.decisionsList.filter((d) => d.verdict === "won");
  const instantPay = s.decisionsList.filter((d) => (d.instantSimProfitUsd ?? 0) - d.gasUsd > 0);
  const L = [
    `# Paper trading — ${s.chain}`,
    "",
    `${s.startedAt} -> ${s.endedAt}. Nothing was signed or sent. Each decision was judged by simulating the exact trade through the real receiver code at the state just before the block it would have landed in, and by checking the logs for a competitor's round trip through the same pools.`,
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Blocks produced / processed | ${s.blocksSeen} / ${s.blocksProcessed} (avg cycle ${s.avgCycleMs} ms) |`,
    `| Watched pools changing per processed block | ${s.changedPoolsPerBlock.toFixed(2)} |`,
    `| Routes touched by those changes / passing the local marginal-rate check (then quoted) | ${s.routesTouched} / ${s.routesPassedLocalCheck} |`,
    `| Local marginal model checked against real quotes: checks / violations | ${s.localBoundChecks} / ${s.localBoundViolations} |`,
    `| Decisions priced locally: simulated proceeds exactly equal to the local quote / different | ${s.localQuoteExact} / ${s.localQuoteMismatch} |`,
    `| Size quotes with no exact local answer (skipped, never sent to the RPC) | ${s.localQuoteUnavailable}${Object.keys(s.localQuoteUnavailableWhy).length ? ": " + Object.entries(s.localQuoteUnavailableWhy).map(([k, n]) => `${k} (${n})`).join("; ") : ""} |`,
    `| Paying routes skipped because a better decision in the same block already used one of their pools | ${s.overlappingSkipped} |`,
    `| Decisions (would have sent) | ${s.decisions} |`,
    `| Verdicts | ${Object.entries(s.verdicts).map(([k, v]) => `${k} ${v}`).join(", ") || "none"} |`,
    `| Paper P&L (won trades' simulated profit minus gas; reverts cost gas) | $${s.paperPnlUsd.toFixed(4)} |`,
    `| Won trades: total simulated profit | $${won.reduce((a, d) => a + (d.simProfitUsd ?? 0), 0).toFixed(4)} |`,
    `| If we had been instant (landing in the block right after the state block): trades still paying after gas / of which a competitor also hit that block | ${instantPay.length} / ${instantPay.filter((d) => d.instantContested).length} |`,
    `| Instant-bot paper P&L (paying trades, uncontested only) | $${instantPay.filter((d) => !d.instantContested).reduce((a, d) => a + (d.instantSimProfitUsd! - d.gasUsd), 0).toFixed(4)} |`,
    "",
    "Verdicts: won = the trade still paid at the target block and no competitor took it earlier; contested = a competitor arbitraged the same pools in the target block (the priority fee decides); lost = a competitor took it before; gone = the gap closed without a visible competitor round trip.",
    "",
  ];
  if (s.decisionsList.length) {
    L.push("| # | Route | Size | Quoted net | State block | Target | Reaction ms | Verdict | Sim at target | Paper P&L | Competitor |", "|---|---|---|---|---|---|---|---|---|---|---|");
    for (const d of s.decisionsList.slice(0, 200)) {
      L.push(
        `| ${d.id} | ${d.routeId} | $${d.sizeUsd} | $${d.quotedNetUsd.toFixed(4)} | ${d.stateBlock} | ${d.targetBlock} | ${d.reactionMs} | ${d.verdict} | ${d.simReason ?? ""} | $${(d.paperPnlUsd ?? 0).toFixed(4)} | ${d.competitor ? `${d.competitor.tx.slice(0, 14)}… blk ${d.competitor.block} #${d.competitor.index}` : ""} |`,
      );
    }
  }
  return L.join("\n") + "\n";
}

