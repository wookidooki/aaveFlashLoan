// Append-only evidence: every log line and structured event goes to data/ledger/<UTC date>.jsonl,
// and the session's aggregate summary is snapshotted to data/sessions/<session>.json.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Scanner } from "./scanner.ts";

export const DATA_DIR = fileURLToPath(new URL("../data/", import.meta.url));

const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

export function attachLedger(scanner: Scanner, snapshotEveryMs = 30_000): () => void {
  mkdirSync(DATA_DIR + "ledger", { recursive: true });
  mkdirSync(DATA_DIR + "sessions", { recursive: true });
  const write = (type: string, payload: unknown) => {
    const ts = new Date().toISOString();
    const line = JSON.stringify({ ts, session: scanner.sessionId, type, ...(payload as object) }, replacer);
    appendFileSync(`${DATA_DIR}ledger/${ts.slice(0, 10)}.jsonl`, line + "\n");
  };
  const snapshot = () =>
    writeFileSync(`${DATA_DIR}sessions/${scanner.sessionId}.json`, JSON.stringify(scanner.summary(), replacer, 2));

  const handlers: [string, (x: any) => void][] = [
    ["log", (l) => write("log", l)],
    ["cycle", (c) => write("cycle", c)],
    ["opportunity", (e) => write("opportunity", { episode: e })],
    ["episode_closed", (e) => write("episode_closed", { episode: e })],
    ["simulation", (s) => write("simulation", { simulation: s })],
    ["stopped", () => snapshot()],
  ];
  for (const [ev, fn] of handlers) scanner.on(ev, fn);
  const timer = setInterval(snapshot, snapshotEveryMs);
  return () => {
    clearInterval(timer);
    snapshot();
    for (const [ev, fn] of handlers) scanner.off(ev, fn);
  };
}
