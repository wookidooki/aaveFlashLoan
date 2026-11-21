// Entry point. Commands:
//   scan      [--minutes N] [--chains a,b] [--config path]   headless read-only scan
//   dashboard [--port 8787] [--chains a,b] [--config path]   operator view with start/stop
//   report    [--date YYYY-MM-DD] [--session ID]             daily / session report from data/
//   verify    [--chains a,b]                                  simulate one route through every venue
//   replay    --session ID                                    re-quote each opportunity block by block to measure its lifetime
// Node's fetch only honours HTTPS_PROXY with NODE_USE_ENV_PROXY=1 (set in the npm scripts).
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { attachLedger } from "./ledger.ts";
import { Scanner } from "./scanner.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    minutes: { type: "string" },
    chains: { type: "string" },
    config: { type: "string" },
    port: { type: "string", default: "8787" },
    date: { type: "string" },
    session: { type: "string" },
    quiet: { type: "boolean", default: false },
  },
});
const command = positionals[0] ?? "scan";
const chains = values.chains?.split(",").map((s) => s.trim());

if (command === "scan") {
  const cfg = loadConfig(values.config, chains);
  const scanner = new Scanner(cfg);
  const detach = attachLedger(scanner);
  scanner.on("log", (l) => {
    if (values.quiet && l.level === "info") return;
    console.log(`${l.ts.slice(11, 19)} ${l.level.padEnd(11)} ${(l.chain ?? "").padEnd(9)} ${l.msg}`);
  });
  const finish = () => {
    scanner.stop();
    detach();
    console.log(`session ${scanner.sessionId} saved under data/sessions/`);
    process.exit(0);
  };
  process.on("SIGINT", finish);
  process.on("SIGTERM", finish);
  scanner.start();
  if (values.minutes) setTimeout(finish, Number(values.minutes) * 60_000);
} else if (command === "dashboard") {
  const { startDashboard } = await import("./dashboard.ts");
  startDashboard(loadConfig(values.config, chains), Number(values.port));
} else if (command === "verify") {
  // Simulate one real route through every venue on every chain (read-only eth_call).
  const scanner = new Scanner(loadConfig(values.config, chains));
  const detach = attachLedger(scanner);
  const rows = await scanner.verifyVenues();
  detach();
  let bad = 0;
  for (const r of rows) {
    const rec = r.rec;
    let verdict: string;
    if (!rec) verdict = "not simulated: " + r.note;
    else if (rec.error) verdict = "SIM ERROR " + rec.error;
    else if (rec.proceedsMatchQuote) verdict = "proceeds = quote";
    else verdict = "proceeds " + rec.simProceeds + " != quote " + rec.quotedLeg2Out;
    if (rec && !rec.proceedsMatchQuote) bad++;
    const detail = rec ? "$" + rec.sizeUsd + " " + (rec.ok ? "executed" : rec.reason.slice(0, 60)) + " | " + rec.routeId : "";
    console.log(r.chain.padEnd(9), r.venue.padEnd(30), verdict.padEnd(22), detail);
  }
  console.log(rows.filter((r) => r.rec?.proceedsMatchQuote).length + "/" + rows.length + " venues verified; " + bad + " mismatches");
  process.exit(bad ? 1 : 0);
} else if (command === "paper") {
  // Paper trading: react to swaps block by block, decide, then judge each decision. Nothing is sent.
  const { PaperTrader, paperMarkdown } = await import("./paper.ts");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { DATA_DIR } = await import("./ledger.ts");
  const cfg = loadConfig(values.config, chains ?? ["base"]);
  const scanner = new Scanner(cfg);
  const say = (m: string) => console.log(new Date().toISOString().slice(11, 19) + " " + m);
  const traders = cfg.chains.map((c) => new PaperTrader(scanner, c.name, (m) => say(c.name.padEnd(9) + m)));
  process.on("SIGINT", () => traders.forEach((t) => t.stop()));
  const results = await Promise.all(traders.map((t) => t.run(Number(values.minutes ?? "30"))));
  mkdirSync(DATA_DIR + "reports", { recursive: true });
  for (const s of results) {
    const md = paperMarkdown(s);
    const file = DATA_DIR + "reports/paper-" + s.chain + "-" + s.startedAt.replace(/[:.]/g, "-") + ".md";
    writeFileSync(file, md);
    console.log(md.split("\n").slice(0, 14).join("\n"));
    console.log("written " + file);
  }
  process.exit(0);
} else if (command === "competitors") {
  // Who already runs these round trips, how often and for how much (read-only, recent blocks).
  const { analyseCompetitors, competitorMarkdown } = await import("./competitors.ts");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { DATA_DIR } = await import("./ledger.ts");
  const cfg = loadConfig(values.config, chains);
  const scanner = new Scanner(cfg);
  const minutes = Number(values.minutes ?? "60");
  const parts = ["# Competitor analysis", "", "Arbitrage round trips by other bots through the pools this scanner watches. Profit = net token inflow to the sender and target contract (Aave oracle prices) minus gas incl. L1 fee.", ""];
  for (const c of cfg.chains) {
    const r = await analyseCompetitors(scanner, c.name, minutes);
    const { symbols } = await scanner.poolsFor(c.name);
    const md = competitorMarkdown(r, symbols);
    console.log(md);
    parts.push(md);
  }
  mkdirSync(DATA_DIR + "reports", { recursive: true });
  const file = DATA_DIR + "reports/competitors-" + new Date().toISOString().replace(/[:.]/g, "-") + ".md";
  writeFileSync(file, parts.join("\n"));
  console.log("written " + file);
  process.exit(0);
} else if (command === "replay") {
  // Measure how many blocks each opportunity of a session was really open (historical eth_call).
  const { readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { DATA_DIR } = await import("./ledger.ts");
  if (!values.session) throw new Error("replay needs --session ID");
  const sum = JSON.parse(readFileSync(DATA_DIR + "sessions/" + values.session + ".json", "utf8"));
  const eps = [...sum.closedEpisodes, ...sum.openEpisodes];
  const scanner = new Scanner(loadConfig(values.config, [...new Set(eps.map((e: any) => e.chain as string))]));
  const seen = new Set<string>();
  const out: string[] = ["# Gap lifetime replay — session " + values.session, "",
    "Each opportunity re-quoted at every block around where it was seen (best size per block).", "",
    "| Kind | Route | Seen at | Blocks with net > min (Aave) | Blocks with net > min (fee-free) | Peak net (Aave / fee-free) |", "|---|---|---|---|---|---|"];
  for (const ep of eps) {
    const key = ep.routeId + "@" + ep.firstBlock;
    if (seen.has(key)) continue;
    seen.add(key);
    const rows = await scanner.replayRoute(ep.chain, ep.routeId, BigInt(ep.firstBlock));
    const aave = rows.filter((r) => (r.netUsd ?? -Infinity) > scanner.cfg.minNetUsd).map((r) => r.block);
    const ff = rows.filter((r) => (r.feeFreeNetUsd ?? -Infinity) > scanner.cfg.minNetUsd).map((r) => r.block);
    const peakA = Math.max(...rows.map((r) => r.netUsd ?? -Infinity));
    const peakF = Math.max(...rows.map((r) => r.feeFreeNetUsd ?? -Infinity));
    const errs = rows.filter((r) => r.error && r.netUsd === undefined).length;
    const span = (b: bigint[]) => (b.length ? b.length + " (" + b[0] + "–" + b[b.length - 1] + ")" : "0");
    const line = "| " + ep.kind + " | " + ep.routeId + " | " + ep.firstBlock + " | " + span(aave) + " | " + span(ff) + " | $" + peakA.toFixed(3) + " / $" + peakF.toFixed(3) + (errs ? " (" + errs + " blocks unreadable)" : "") + " |";
    out.push(line);
    console.log(line);
  }
  mkdirSync(DATA_DIR + "reports", { recursive: true });
  writeFileSync(DATA_DIR + "reports/replay-" + values.session + ".md", out.join("\n") + "\n");
  console.log("written data/reports/replay-" + values.session + ".md");
  process.exit(0);
} else if (command === "report") {
  const { writeReports } = await import("./report.ts");
  const files = writeReports({ date: values.date, session: values.session });
  for (const f of files) console.log(f);
} else {
  console.error(`unknown command ${command}`);
  process.exit(2);
}
