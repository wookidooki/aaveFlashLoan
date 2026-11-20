// Entry point. Commands:
//   scan      [--minutes N] [--chains a,b] [--config path]   headless read-only scan
//   dashboard [--port 8787] [--chains a,b] [--config path]   operator view with start/stop
//   report    [--date YYYY-MM-DD] [--session ID]             daily / session report from data/
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
} else if (command === "report") {
  const { writeReports } = await import("./report.ts");
  const files = writeReports({ date: values.date, session: values.session });
  for (const f of files) console.log(f);
} else {
  console.error(`unknown command ${command}`);
  process.exit(2);
}
