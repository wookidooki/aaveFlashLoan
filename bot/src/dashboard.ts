// Operator view: a local web page with start/stop controls, the line-by-line activity log, active
// chains/pairs/venues, opportunities, skip reasons, and quoted / simulated / realized P&L kept
// separate. Binds to 127.0.0.1 only. There is no control for live execution: it does not exist.
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { ScanConfig } from "./config.ts";
import { attachLedger } from "./ledger.ts";
import { writeReports } from "./report.ts";
import { Scanner, type LogLine } from "./scanner.ts";

const PAGE = fileURLToPath(new URL("./dashboard.html", import.meta.url));
const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

export function startDashboard(cfg: ScanConfig, port: number) {
  let scanner: Scanner | undefined;
  let detach: (() => void) | undefined;
  const clients = new Set<ServerResponse>();
  const push = (l: LogLine) => {
    for (const res of clients) res.write(`data: ${JSON.stringify(l)}\n\n`);
  };

  const json = (res: ServerResponse, body: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body, replacer));
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(readFileSync(PAGE, "utf8"));
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      return json(res, scanner ? scanner.summary() : { running: false, chains: {}, liveExecution: "disabled", config: { chains: cfg.chains.map((c) => c.name) } });
    }
    if (req.method === "GET" && url.pathname === "/api/log") return json(res, scanner?.logTail ?? []);
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/start") {
      if (!scanner || scanner.stoppedAt) {
        scanner = new Scanner(cfg);
        detach = attachLedger(scanner);
        scanner.on("log", push);
      }
      scanner.start();
      return json(res, { running: true, session: scanner.sessionId });
    }
    if (req.method === "POST" && url.pathname === "/api/stop") {
      scanner?.stop();
      detach?.();
      detach = undefined;
      return json(res, { running: false });
    }
    if (req.method === "POST" && url.pathname === "/api/report") {
      const files = scanner ? writeReports({ session: scanner.sessionId }) : [];
      const today = writeReports({});
      return json(res, { files: [...files, ...today] });
    }
    res.writeHead(404).end();
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`operator view on http://127.0.0.1:${port} (read-only scanner; live execution disabled)`);
  });
  const shutdown = () => {
    scanner?.stop();
    detach?.();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
