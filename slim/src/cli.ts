#!/usr/bin/env node
// langfuse-lite command line. `serve` runs the server; the other commands read
// the SQLite file directly, so they work whether or not the server is running.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { compareRuns, experimentSummaries, exportViewer, formatObservation, formatScore, resolveRun } from "./api";
import { openDb, type Db } from "./db";
import { LANGFUSE_VERSION } from "./langfuse";
import { push } from "./push";
import { migrate } from "./schema";
import { serve } from "./server";

export const VERSION = "0.1.0";

const HELP = `langfuse-lite ${VERSION} (Langfuse ${LANGFUSE_VERSION} data model)

A local Langfuse for experiment runs and agent tracing: one process, one SQLite
file. Point the Langfuse SDKs at it with LANGFUSE_BASE_URL=http://localhost:3000
(any keys work).

Usage: langfuse-lite <command> [options]

Commands:
  serve                     Start the server (default port 3000)
  traces                    List recent traces
  trace <id>                Show a trace as a tree: timings, errors, tokens, cost
  runs                      List experiment runs with their average scores
  compare <run> [<run>...]  Compare runs item by item (run id or name)
  sql "<query>"             Run a read-only SQL query on the database. Tables and views:
                              observations (one row per observation, Langfuse's names), traces,
                              scores, datasets, dataset_items, events (observations as stored),
                              otlp_requests (raw OTLP). Columns: sql "PRAGMA table_info(observations)"
  export [--out <file>]     Write the viewer with its data as one HTML file (default langfuse-lite.html)
  push --to <url>           Copy everything to a Langfuse (Cloud or self-hosted)

Options:
  --db <path>       Database file (default: $LANGFUSE_LITE_DB or ./.langfuse/lite.db)
  --json            Machine-readable output
  --port <n>        serve: port (default 3000, or $PORT)
  --host <h>        serve: host (default 127.0.0.1)
  --limit <n>       traces: how many (default 20); export: newest traces to include (default 100)
  --io              trace: also print each observation's input and output
  --public-key, --secret-key   push: target keys (or LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY)
`;

function dbPath(arg?: string) {
  return path.resolve(arg ?? process.env.LANGFUSE_LITE_DB ?? path.join(process.cwd(), ".langfuse", "lite.db"));
}

async function open(file: string): Promise<Db> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = await openDb(file);
  migrate(db);
  return db;
}

const money = (n: number | null | undefined) => (n ? `$${n < 0.01 ? n.toPrecision(2) : n.toFixed(4)}` : "");
const dur = (s: number | null | undefined) =>
  s == null ? "" : s < 1 ? `${Math.round(s * 1000)}ms` : s < 120 ? `${s.toFixed(1)}s` : `${(s / 60).toFixed(1)}m`;
const short = (v: unknown, n = 80) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s == null) return "";
  const flat = s.replace(/\s+/g, " ");
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
};
const secondsBetween = (a?: string | null, b?: string | null) =>
  a && b ? (new Date(b).getTime() - new Date(a).getTime()) / 1000 : null;

function table(rows: Record<string, unknown>[], cols: string[]) {
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (r: Record<string, unknown>) => cols.map((c, i) => String(r[c] ?? "").padEnd(widths[i])).join("  ").trimEnd();
  return [line(Object.fromEntries(cols.map((c) => [c, c]))), ...rows.map(line)].join("\n");
}

function cmdTraces(db: Db, o: { limit: number; json: boolean }) {
  const rows = db.all<Record<string, any>>("SELECT * FROM traces ORDER BY start_time DESC LIMIT ?", o.limit);
  if (o.json) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return console.log("No traces yet. Point an SDK at the server: LANGFUSE_BASE_URL=http://localhost:3000");
  console.log(
    table(
      rows.map((r) => ({
        id: r.id,
        name: short(r.name ?? "", 40),
        start: String(r.start_time).replace("T", " ").slice(0, 19),
        duration: dur(secondsBetween(r.start_time, r.end_time)),
        obs: r.observation_count,
        errors: r.error_count || "",
        tokens: r.total_tokens || "",
        cost: money(r.total_cost),
        experiment: r.experiment_id ?? "",
      })),
      ["id", "name", "start", "duration", "obs", "errors", "tokens", "cost", "experiment"],
    ),
  );
}

function cmdTrace(db: Db, id: string | undefined, o: { json: boolean; io: boolean }) {
  if (!id) throw new Error("usage: langfuse-lite trace <trace id>");
  const match = db.all<{ trace_id: string }>("SELECT DISTINCT trace_id FROM events WHERE trace_id LIKE ? || '%' LIMIT 2", id);
  if (!match.length) throw new Error(`no trace ${id}`);
  if (match.length > 1) throw new Error(`"${id}" matches more than one trace; give more characters`);
  const traceId = match[0].trace_id;
  const all = new Set(["core", "basic", "time", "io", "metadata", "model", "usage", "prompt"]);
  const obs = db.all<Record<string, any>>("SELECT * FROM events WHERE trace_id = ? ORDER BY start_time, id", traceId).map((r) => formatObservation(r, all));
  const scores = db.all("SELECT * FROM scores WHERE trace_id = ? ORDER BY timestamp", traceId).map((s) => formatScore(s, new Set(["core", "details", "subject"])));
  if (o.json) return console.log(JSON.stringify({ id: traceId, observations: obs, scores }, null, 2));
  const t = db.get<Record<string, any>>("SELECT * FROM traces WHERE id = ?", traceId)!;
  const head = [
    `trace ${traceId}`,
    t.name,
    t.user_id && `user ${t.user_id}`,
    t.session_id && `session ${t.session_id}`,
    dur(secondsBetween(t.start_time, t.end_time)),
    t.total_tokens ? `${t.total_tokens} tokens` : "",
    money(t.total_cost),
    t.error_count ? `${t.error_count} error${t.error_count > 1 ? "s" : ""}` : "",
  ].filter(Boolean);
  console.log(head.join("  ·  "));
  const ids = new Set(obs.map((x) => x.id));
  const children = new Map<string | null, any[]>();
  for (const x of obs) {
    const parent = x.parentObservationId && ids.has(x.parentObservationId) ? x.parentObservationId : null;
    children.set(parent as string | null, [...(children.get(parent as string | null) ?? []), x]);
  }
  const print = (x: any, prefix: string, last: boolean) => {
    const bits = [
      x.type,
      x.name,
      x.model ?? "",
      x.totalUsage ? `${x.inputUsage}→${x.outputUsage} tok` : "",
      money(x.totalCost),
      dur(x.latency),
      x.level === "ERROR" || x.level === "WARNING" ? `${x.level}${x.statusMessage ? `: ${x.statusMessage}` : ""}` : "",
    ].filter(Boolean);
    console.log(`${prefix}${last ? "└─ " : "├─ "}${bits.join("  ")}   ${x.id}`);
    const inner = prefix + (last ? "   " : "│  ");
    if (o.io) {
      if (x.input != null) console.log(`${inner}  in:  ${short(x.input, 160)}`);
      if (x.output != null) console.log(`${inner}  out: ${short(x.output, 160)}`);
    }
    const kids = children.get(x.id) ?? [];
    kids.forEach((k, i) => print(k, inner, i === kids.length - 1));
  };
  const roots = children.get(null) ?? [];
  roots.forEach((r, i) => print(r, "", i === roots.length - 1));
  if (scores.length)
    console.log(
      "scores: " +
        scores
          .map((s: any) => `${s.name}=${s.value}${s.subject?.kind === "observation" ? ` (on ${s.subject.id})` : ""}${s.comment ? ` "${short(s.comment, 40)}"` : ""}`)
          .join(", "),
    );
}

function cmdRuns(db: Db, o: { json: boolean }) {
  const runs = experimentSummaries(db);
  if (o.json) return console.log(JSON.stringify(runs, null, 2));
  if (!runs.length) return console.log("No experiment runs yet. Run one with the SDK's run_experiment.");
  console.log(
    table(
      runs.map((r) => ({
        id: r.id,
        name: short(r.name, 50),
        dataset: r.dataset_name ?? (r.dataset_id ? r.dataset_id : "(local data)"),
        items: r.items,
        errors: r.errors || "",
        "avg latency": dur(r.avg_latency),
        cost: money(r.total_cost),
        scores: Object.entries(r.scores)
          .map(([k, v]) => `${k}=${typeof v === "number" ? +v.toFixed(3) : v}`)
          .join(" "),
      })),
      ["id", "name", "dataset", "items", "errors", "avg latency", "cost", "scores"],
    ),
  );
}

function cmdCompare(db: Db, refs: string[], o: { json: boolean }) {
  if (!refs.length) throw new Error("usage: langfuse-lite compare <run> [<run>...]");
  const result = compareRuns(db, refs);
  if (o.json) return console.log(JSON.stringify(result, null, 2));
  result.runs.forEach((r, i) =>
    console.log(`[${i + 1}] ${r.name} (${r.id})  ${Object.entries(r.summary).map(([k, v]) => `${k}=${typeof v === "number" ? +v.toFixed(3) : v}`).join(" ")}`),
  );
  for (const item of result.items) {
    console.log(`\nitem ${item.itemId}  input: ${short(item.input, 70)}  expected: ${short(item.expectedOutput, 40)}`);
    result.runs.forEach((r, i) => {
      const x = item.runs[r.id];
      if (!x) return console.log(`  [${i + 1}] (not run)`);
      const scores = Object.entries(x.scores).map(([k, v]) => `${k}=${v}`).join(" ");
      console.log(`  [${i + 1}] ${short(x.output, 60)}  ${scores}  ${dur(x.latency)}  ${money(x.cost)}${x.level === "ERROR" ? "  ERROR" : ""}  trace ${x.traceId}`);
    });
  }
}

function cmdSql(db: Db, query: string | undefined, o: { json: boolean }) {
  if (!query) throw new Error('usage: langfuse-lite sql "SELECT ..."');
  if (!/^\s*(select|with|pragma|explain)\b/i.test(query)) throw new Error("sql runs read-only queries (SELECT/WITH/PRAGMA/EXPLAIN)");
  let rows: Record<string, unknown>[];
  try {
    rows = db.all<Record<string, unknown>>(query);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/no such (table|column)/.test(message)) {
      const tables = db.all<{ name: string; type: string }>(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' AND name != 'lite_meta' ORDER BY name",
      );
      throw new Error(
        `${message}\n  tables and views: ${tables.map((t) => t.name).join(", ")}` +
          `\n  columns of one: langfuse-lite sql "PRAGMA table_info(observations)"`,
      );
    }
    throw e;
  }
  if (o.json || !rows.length) return console.log(JSON.stringify(rows, null, 2));
  console.log(table(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, short(v ?? "", 60)]))), Object.keys(rows[0])));
}

export async function main(argv = process.argv.slice(2)) {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: "string" },
      json: { type: "boolean", default: false },
      port: { type: "string" },
      host: { type: "string", default: "127.0.0.1" },
      limit: { type: "string" },
      out: { type: "string" },
      io: { type: "boolean", default: false },
      to: { type: "string" },
      "public-key": { type: "string" },
      "secret-key": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (o.version) return console.log(VERSION);
  if (o.help || !command || command === "help") return console.log(HELP);
  const file = dbPath(o.db);
  const db = await open(file);
  try {
    switch (command) {
      case "serve": {
        const port = Number(o.port ?? process.env.PORT ?? 3000);
        const server = await serve(db, { host: o.host!, port });
        console.log(`langfuse-lite ${VERSION} listening on ${server.url}  (data: ${file})`);
        console.log(`  LANGFUSE_BASE_URL=${server.url} LANGFUSE_PUBLIC_KEY=pk-lf-local LANGFUSE_SECRET_KEY=sk-lf-local`);
        await new Promise<void>((resolve) => {
          const stop = () => resolve();
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
        await server.stop();
        return;
      }
      case "traces":
        return cmdTraces(db, { limit: Number(o.limit ?? 20), json: o.json! });
      case "trace":
        return cmdTrace(db, rest[0], { json: o.json!, io: o.io! });
      case "runs":
        return cmdRuns(db, { json: o.json! });
      case "compare":
        return cmdCompare(db, rest, { json: o.json! });
      case "sql":
        return cmdSql(db, rest.join(" "), { json: o.json! });
      case "export": {
        const out = path.resolve(o.out ?? "langfuse-lite.html");
        const { html, traces, runs } = exportViewer(db, Number(o.limit ?? 100));
        fs.writeFileSync(out, html);
        console.log(`Wrote ${out}: ${traces} traces, ${runs} experiment runs, ${(html.length / 1024).toFixed(0)} KB. Open it in a browser; no server needed.`);
        return;
      }
      case "push": {
        if (!o.to) throw new Error("usage: langfuse-lite push --to <langfuse url> [--public-key ..] [--secret-key ..]");
        const publicKey = o["public-key"] ?? process.env.LANGFUSE_PUBLIC_KEY;
        const secretKey = o["secret-key"] ?? process.env.LANGFUSE_SECRET_KEY;
        if (!publicKey || !secretKey) throw new Error("push needs --public-key and --secret-key (or LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY)");
        const report = await push(db, { baseUrl: o.to, publicKey, secretKey, dryRun: o["dry-run"]!, log: (m) => console.log(m) });
        if (o.json) console.log(JSON.stringify(report, null, 2));
        return;
      }
      default:
        throw new Error(`unknown command "${command}"; see langfuse-lite --help`);
    }
  } finally {
    db.close();
  }
}

// Exported for tests; run when executed directly.
export { resolveRun };
if (!(globalThis as { __LANGFUSE_LITE_NO_MAIN__?: boolean }).__LANGFUSE_LITE_NO_MAIN__) {
  main().catch((e) => {
    console.error(`langfuse-lite: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
