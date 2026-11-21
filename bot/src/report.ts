// Builds the session / daily report from data/sessions/*.json and data/ledger/*.jsonl.
// Quoted net profit, simulation results and realized wallet P&L are always reported separately.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { DATA_DIR } from "./ledger.ts";

type Summary = any;

function loadSessions(date?: string, session?: string): Summary[] {
  const dir = DATA_DIR + "sessions/";
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(dir + f, "utf8")))
    .filter((s) => (session ? s.sessionId === session : date ? s.startedAt.slice(0, 10) === date : true))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function loadLedger(date: string): any[] {
  const f = `${DATA_DIR}ledger/${date}.jsonl`;
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const usd = (x: number | null | undefined) => (x === null || x === undefined ? "n/a" : `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(x !== 0 && Math.abs(x) < 0.01 ? 4 : 2)}`);
const dur = (ms: number) => `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;

function breakdown(e: any): string {
  const b = e.best;
  if (!b) return `_no quoted size: ${e.outcome}_\n`;
  return [
    `Route \`${e.routeId}\` at block ${e.block}`,
    "",
    "| Item | Value |",
    "|---|---|",
    `| Borrow (best size) | ${b.borrowed} ${e.borrow} (~$${b.sizeUsd.toLocaleString()}) |`,
    `| Leg 1 | ${e.borrow} -> ${e.via} on ${e.first.label} (\`${e.first.pool}\`) -> ${b.leg1Out} ${e.via} |`,
    `| Leg 2 | ${e.via} -> ${e.borrow} on ${e.second.label} (\`${e.second.pool}\`) -> ${b.leg2Out} ${e.borrow} |`,
    `| Gross (leg 2 out - borrowed; swap fees and price impact already inside the quotes) | ${b.grossTokens} ${e.borrow} |`,
    `| Aave flash-loan premium | ${b.premium} ${e.borrow} |`,
    `| Net before gas | ${b.netTokens} ${e.borrow} = ${usd(b.netTokensUsd)} |`,
    `| Gas: L2 units / L1 units / price | ${b.gasUnitsL2} / ${b.gasUnitsL1} / ${b.gasPriceGwei} gwei |`,
    `| Gas cost (incl. L1 data fee ${usd(b.l1Usd)}) | ${usd(b.gasUsd)} |`,
    `| **Quoted net profit** | **${usd(b.netUsd)}** |`,
    `| Outcome | ${e.outcome} |`,
    "",
    "Per loan size (same block):",
    "",
    "| Size | Borrowed | Leg 1 out | Leg 2 out | Premium | Gas | Net |",
    "|---|---|---|---|---|---|---|",
    ...e.sizes.map((s: any) =>
      s.skip
        ? `| $${s.sizeUsd.toLocaleString()} | ${s.borrowed} | skipped: ${s.skip} ||||`
        : `| $${s.sizeUsd.toLocaleString()} | ${s.borrowed} | ${s.leg1Out} | ${s.leg2Out} | ${s.premium} | ${usd(s.gasUsd)} | ${usd(s.netUsd)} |`,
    ),
    "",
  ].join("\n");
}

function perBlock(sessions: Summary[]): string {
  let passes = 0, ms = 0, skipped = 0;
  for (const s of sessions)
    for (const c of Object.values<any>(s.chains)) {
      if (!c.perBlock) continue;
      passes += c.perBlock.passes;
      ms += (c.perBlock.avgMs ?? 0) * c.perBlock.passes;
      skipped += c.perBlock.blocksSkipped;
    }
  return passes ? `${passes} / ${Math.round(ms / passes)} / ${skipped}` : "n/a (not run in this session's version)";
}

export function buildReport(sessions: Summary[], ledger: any[], title: string): { md: string; json: any } {
  const L: string[] = [`# ${title}`, ""];
  if (!sessions.length) {
    L.push("No scan sessions found for this period.");
    return { md: L.join("\n"), json: { sessions: 0 } };
  }
  const start = sessions[0].startedAt;
  const end = sessions.map((s) => s.stoppedAt ?? s.updatedAt).sort().at(-1);
  const trades = ledger.filter((e) => e.type === "trade");
  const everyEpisode = sessions.flatMap((s) => [...s.closedEpisodes, ...s.openEpisodes]);
  const allEpisodes = everyEpisode.filter((e) => (e.kind ?? "aave") === "aave");
  const feeFree = everyEpisode.filter((e) => e.kind === "fee-free");
  const fresh = allEpisodes.filter((e) => e.freshQuote?.qualifies);
  const minNet = sessions[0].config.minNetUsd ?? sessions[0].config.benchmarkNetUsd;
  const blocksOpen = (eps: any[]) => {
    if (!eps.length) return "n/a";
    const b = eps.map((e) => e.blocksOpen ?? 1).sort((x: number, y: number) => x - y);
    const one = b.filter((x: number) => x === 1).length;
    return `median ${b[Math.floor(b.length / 2)]}, max ${b.at(-1)}; ${one} of ${b.length} seen in a single block only`;
  };
  const sumNet = (eps: any[]) => eps.reduce((a: number, e: any) => a + (e.bestNetUsd ?? 0), 0);
  const sims = sessions.flatMap((s) => s.simulations);
  const chainNames = [...new Set(sessions.flatMap((s) => Object.keys(s.chains)))];

  L.push(
    `- Observation period: ${start} -> ${end} (${dur(Date.parse(end) - Date.parse(start))}), ${sessions.length} session(s)`,
    `- Live execution: **disabled** (not authorized; no wallet or key loaded)`,
    `- Loan sizes: ${sessions[0].config.loanSizesUsd.map((x: number) => "$" + x.toLocaleString()).join(", ")} equivalent per borrowed asset (Aave oracle price at the quote block)`,
    `- A trade qualifies when its net after Aave premium, gas and L1 fee is above ${usd(minNet)}; business target ${usd(sessions[0].config.dailyTargetUsd)}/day`,
    "",
    "## Headline",
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Chains | ${chainNames.join(", ")} |`,
  );
  let routesQuoted = 0, routes = 0, quotesOk = 0, quotesFailed = 0, cycles = 0;
  let routesEvaluated = 0, boundChecks = 0, boundViolations = 0, quotesDominated = 0, quotesCannotFill = 0;
  const classified = sessions.every((s) => Object.values<any>(s.chains).every((c) => c.quotesCannotFill !== undefined));
  let best: any = null;
  for (const s of sessions)
    for (const c of Object.values<any>(s.chains)) {
      routesEvaluated += c.routesEvaluatedEver ?? c.routesQuotedEver;
      boundChecks += c.boundChecks ?? 0;
      boundViolations += c.boundViolations ?? 0;
      quotesDominated += c.quotesDominated ?? 0;
      quotesCannotFill += c.quotesCannotFill ?? 0;
      routesQuoted += c.routesQuotedEver;
      routes += c.routes;
      quotesOk += c.quotesOk;
      quotesFailed += c.quotesFailed;
      cycles += c.cycles;
      if (c.bestEver?.best && (!best || c.bestEver.best.netUsd > best.best.netUsd)) best = c.bestEver;
    }
  L.push(
    `| Scan cycles (all chains) | ${cycles} |`,
    `| Routes configured / evaluated at least once / fully quoted at least once | ${routes} / ${routesEvaluated} / ${routesQuoted} |`,
    `| Marginal-price bound: soundness checks on fully quoted sizes / violations | ${boundChecks} / ${boundViolations} |`,
    classified
      ? `| Size-level quotes: completed / pool cannot fill the size / dominated (provably unprofitable) / other failures | ${quotesOk} / ${quotesCannotFill} / ${quotesDominated} / ${quotesFailed} |`
      : `| Size-level quotes completed / failed (failure causes not classified in this session's version) | ${quotesOk} / ${quotesFailed} |`,
    `| Independent opportunities (net above ${usd(minNet)} after all costs; one gap counts once) | ${allEpisodes.length} |`,
    `| ...still qualifying on a fresh quote at a newer block | ${fresh.length} |`,
    `| ...blocks each stayed open while observed | ${blocksOpen(allEpisodes)} |`,
    `| Best quoted net (any route, any size) | ${best ? usd(best.best.netUsd) : "n/a"} |`,
    `| Counterfactual, fee-free lender: independent positive-net gaps / sum of best net / blocks open | ${feeFree.length} / ${usd(sumNet(feeFree))} / ${blocksOpen(feeFree)} |`,
    `| Per-block passes (hot routes re-quoted every new block): passes / avg ms / blocks skipped while busy | ${perBlock(sessions)} |`,
    `| Simulations run (receiver code via eth_call) | ${sims.length} (${sims.filter((x: any) => x.ok).length} executed, ${sims.filter((x: any) => x.proceedsMatchQuote).length} with proceeds exactly equal to quote) |`,
    "",
    "## Targets",
    "",
    `- Positive net per trade (above ${usd(minNet)}): ${allEpisodes.length ? `${allEpisodes.length} independent gap(s) seen, ${fresh.length} still there on a fresh quote; best-net sum ${usd(sumNet(allEpisodes))}` : "**none** in this period with the Aave premium"}.`,
    `- ${usd(sessions[0].config.dailyTargetUsd)}/day: ${fresh.length ? `fresh-quote qualifying net totalled ${usd(fresh.reduce((a: number, e: any) => a + (e.freshQuote.netUsd ?? 0), 0))} over the period` : "**not supported**: zero qualifying trades"}.`,
    `- Without the Aave premium (counterfactual): ${feeFree.length} gap(s), best-net sum ${usd(sumNet(feeFree))}.`,
    "",
    "## Quoted vs simulated vs realized",
    "",
    "| Layer | Result |",
    "|---|---|",
    `| Quoted net profit | best ${best ? usd(best.best.netUsd) : "n/a"}; ${allEpisodes.length} independent gap(s) above ${usd(minNet)} |`,
    `| Simulation | ${sims.length ? sims.slice(-3).map((x: any) => `${x.routeId} $${x.sizeUsd}: ${x.ok ? "executed" : x.reason}${x.proceedsMatchQuote !== undefined ? (x.proceedsMatchQuote ? ", proceeds = quote" : ", proceeds != quote") : ""}`).join("; ") : "none"} |`,
    `| Realized wallet P&L | ${trades.length ? "see trades" : "$0.00 — no transactions sent (live execution disabled)"} |`,
    "",
    "## Daily trading",
    "",
    "| Successful trades | Reverted trades | Gas spent | Gains | Losses |",
    "|---|---|---|---|---|",
    `| ${trades.filter((t) => t.status === "success").length} | ${trades.filter((t) => t.status === "reverted").length} | ${usd(trades.reduce((a, t) => a + (t.gasUsd ?? 0), 0))} | ${usd(trades.reduce((a, t) => a + Math.max(0, t.pnlUsd ?? 0), 0))} | ${usd(trades.reduce((a, t) => a + Math.min(0, t.pnlUsd ?? 0), 0))} |`,
    "",
    "## Best route (full cost breakdown, even if it lost money)",
    "",
    best ? breakdown(best) : "_none quoted_",
  );
  const bestSim = best && sims.filter((x: any) => x.routeId === best.routeId).at(-1);
  if (bestSim) {
    L.push(
      `Simulation of this route (block ${bestSim.block}, $${bestSim.sizeUsd} size, ${bestSim.purpose}): ${bestSim.ok ? `executed, profit ${bestSim.simProfit}` : bestSim.reason}; ` +
        `final-leg proceeds ${bestSim.simProceeds ?? "n/a"} vs quoted ${bestSim.quotedLeg2Out} (${bestSim.proceedsMatchQuote ? "exact match" : "differ"}); gas used inside the receiver call ${bestSim.gasUsedInside}.`,
      "",
    );
  }

  for (const s of sessions) {
    for (const [name, c] of Object.entries<any>(s.chains)) {
      L.push(`## ${name} (chain ${c.chainId}) — session ${s.sessionId}`, "");
      L.push(
        `- Cycles: ${c.cycles}, last block ${c.lastBlock}, last cycle ${c.lastCycleMs} ms${c.lastError ? `, last error: ${c.lastError}` : ""}`,
        `- Pairs: ${c.pairs.join(", ")}`,
        `- Venues scanned: ${c.venues.join(", ")}`,
        `- Venues skipped: ${c.venueSkips.map((v: any) => `${v.id} (${v.reason})`).join("; ") || "none"}`,
        `- Live pools: ${c.pools.length} — ${c.pools.map((p: any) => `${p.pair} ${p.label}`).join(", ")}`,
        `- Routes: ${c.routes} configured, ${c.routesEvaluatedEver ?? c.routesQuotedEver} evaluated at least once, ${c.routesQuotedEver} fully quoted at least once; last cycle ${c.routesQuotedLastCycle} fully quoted, ${c.routesPrunedLastCycle ?? 0} pruned by the marginal-price bound`,
        `- Bound soundness: ${c.boundChecks ?? 0} checks, ${c.boundViolations ?? 0} violations`,
        "",
        "Pools skipped:",
        "",
        "| Pair | Pool | Reason |",
        "|---|---|---|",
        ...c.poolSkips.map((p: any) => `| ${p.pair} | ${p.label} | ${p.reason} |`),
        "",
        "Why routes did not trade (best size per route per cycle):",
        "",
        "| Outcome | Route-cycles |",
        "|---|---|",
        ...Object.entries(c.outcomeCounts).map(([k, v]) => `| ${k} | ${v} |`),
        "",
        "Routes or sizes not quoted:",
        "",
        "| Reason | Count |",
        "|---|---|",
        ...Object.entries(c.skipCounts).slice(0, 15).map(([k, v]) => `| ${k} | ${v} |`),
        "",
        "Top routes by best quoted net:",
        "",
        "| Route | Best size | Gross | Premium | Gas | Net |",
        "|---|---|---|---|---|---|",
        ...c.topRoutes.map((e: any) => `| ${e.routeId} | $${e.best.sizeUsd.toLocaleString()} | ${e.best.grossTokens} ${e.borrow} | ${e.best.premium} | ${usd(e.best.gasUsd)} | ${usd(e.best.netUsd)} |`),
        "",
      );
    }
  }
  if (everyEpisode.length) {
    L.push(
      "## Opportunities",
      "",
      "| Kind | Chain | Route | First seen | First block | Blocks open | Best net | Fresh quote | Simulation |",
      "|---|---|---|---|---|---|---|---|---|",
    );
    for (const e of everyEpisode.slice(0, 200))
      L.push(
        `| ${e.kind ?? "aave"} | ${e.chain} | ${e.routeId} | ${e.firstSeen} | ${e.firstBlock} | ${e.blocksOpen ?? e.sightings} | ${usd(e.bestNetUsd)} | ` +
          `${e.freshQuote ? `${usd(e.freshQuote.netUsd)} ${e.freshQuote.qualifies ? "qualifies" : `(${e.freshQuote.note})`}` : "n/a"} | ` +
          `${e.simulation ? (e.simulation.ok ? "executed" : e.simulation.reason) : "n/a"} |`,
      );
    if (everyEpisode.length > 200) L.push(`| ... ${everyEpisode.length - 200} more in the session JSON |||||||||`);
    L.push("");
  }
  return {
    md: L.join("\n"),
    json: { start, end, sessions: sessions.map((s) => s.sessionId), cycles, routes, routesEvaluated, boundChecks, boundViolations, routesQuoted, quotesOk, quotesFailed, opportunities: allEpisodes.length, freshQualified: fresh.length, best, simulations: sims, trades },
  };
}

export function writeReports(opts: { date?: string; session?: string }): string[] {
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const sessions = loadSessions(opts.session ? undefined : date, opts.session);
  const ledgerDates = [...new Set(sessions.map((s) => s.startedAt.slice(0, 10)).concat(opts.session ? [] : [date]))];
  const ledger = ledgerDates.flatMap(loadLedger);
  const name = opts.session ? `session-${opts.session}` : `daily-${date}`;
  const { md, json } = buildReport(sessions, ledger, opts.session ? `Scan report — session ${opts.session}` : `Daily report — ${date} (UTC)`);
  mkdirSync(DATA_DIR + "reports", { recursive: true });
  const base = `${DATA_DIR}reports/${name}`;
  writeFileSync(base + ".md", md);
  writeFileSync(base + ".json", JSON.stringify(json, null, 2));
  return [base + ".md", base + ".json"];
}
