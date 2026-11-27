#!/usr/bin/env node
// langfuse-lite command line. `serve` runs the server; the other commands read
// the SQLite file directly, so they work whether or not the server is running.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { compareRuns, experimentSummaries, exportViewer, findObservations, formatObservation, listRoots, observationTree, resolveRun } from "./api";
import { openDb, type Db } from "./db";
import { LANGFUSE_VERSION } from "./langfuse";
import { push } from "./push";
import { LARGE_DB_BYTES, LARGE_DB_OBSERVATIONS, SCALE_HINT } from "./limits";
import { migrate } from "./schema";
import { isLoopback, serve } from "./server";
import { capturePush, startServeTelemetry, TELEMETRY_NOTICE, telemetryEnabled } from "./telemetry";
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;

const HELP = `langfuse-lite ${VERSION} (Langfuse ${LANGFUSE_VERSION} data model)

A local Langfuse for experiment runs and agent tracing: one process, one SQLite
file. Point the Langfuse SDKs (or any OpenTelemetry exporter) at it with
LANGFUSE_BASE_URL=http://localhost:3000 (any keys work).

Data model (Langfuse v4): observations. Observations that belong together share a
trace id; trace-level attributes (trace name, user, session, tags) are fields on them.

Usage: langfuse-lite <command> [options]

Commands:
  serve                     Start the server (default port 3000)
  observations              List root observations, newest first, with totals over their trace id.
                              With a filter, list every matching observation:
                              --level ERROR  --name <n>  --type TOOL  --trace <id>  --experiment <run>  --since <time>
  tree <id>                 All observations sharing a trace id, as a tree: timings, errors, tokens,
                              cost (trace id, a prefix of one, or any observation's id)
  runs                      List experiment runs with their average scores
  compare <run> [<run>...]  Compare runs item by item (run id or name)
  sql "<query>"             Read-only SQL. Tables: observations (one row per observation; derived columns
                              input_usage, output_usage, total_usage, input_cost, output_cost, latency_ms),
                              scores, datasets, dataset_items, otlp_requests (raw OTLP).
                              Columns: sql "PRAGMA table_info(observations)"
  export [--out <file>]     Write the viewer with its data as one HTML file (default langfuse-lite.html)
  push --to <url>           Copy everything to a Langfuse (Cloud or self-hosted)

Options:
  --db <path>       Database file (default: $LANGFUSE_LITE_DB or ./.langfuse/lite.db)
  --json            Machine-readable output
  --io              observations, tree: also print input and output
  --limit <n>       observations: how many (default 20); export: newest root observations (default 100)
  --port <n>        serve: port (default 3000, or $PORT)
  --host <h>        serve: host (default 127.0.0.1). There is no authentication: anyone who can
                      reach the port can read and write the data, so only bind other hosts on a trusted network
  --public-key, --secret-key   push: target keys (or LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY)

Telemetry: serve and push send anonymous usage counts (no trace content) to Langfuse.
Turn off with TELEMETRY_ENABLED=false or DO_NOT_TRACK=1.
`;

// Commands from Langfuse v3's trace model, pointed at their v4 equivalents.
const RENAMED: Record<string, string> = {
  traces: 'there is no "traces" command: like Langfuse v4, everything is an observation. Use "langfuse-lite observations" (root observations, one per trace id) or filter, e.g. --level ERROR',
  trace: 'there is no "trace" command: like Langfuse v4, everything is an observation. Use "langfuse-lite tree <trace id>" for all observations that share a trace id',
};

const COMMANDS = ["serve", "observations", "tree", "runs", "compare", "sql", "export", "push"];

function dbPath(arg?: string) {
  return path.resolve(arg ?? process.env.LANGFUSE_LITE_DB ?? path.join(process.cwd(), ".langfuse", "lite.db"));
}

/** Only `serve` creates a database; the other commands read one that exists. */
async function open(file: string, command: string): Promise<Db> {
  if (command === "serve") fs.mkdirSync(path.dirname(file), { recursive: true });
  else if (!fs.existsSync(file))
    throw new Error(`no database at ${file}. Start one with "langfuse-lite serve", or pass --db <path> (or set LANGFUSE_LITE_DB).`);
  if (command === "sql") return openDb(file, { readOnly: true });
  const db = await openDb(file);
  migrate(db);
  return db;
}

function intOption(name: string, value: string | undefined, def: number, min: number, max: number) {
  if (value === undefined) return def;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be a whole number between ${min} and ${max}, got "${value}"`);
  return n;
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

type ListOptions = { limit: number; json: boolean; io: boolean; level?: string; name?: string; type?: string;
  trace?: string; experiment?: string; since?: string };

function cmdObservations(db: Db, o: ListOptions) {
  const filtered = Boolean(o.level || o.name || o.type || o.trace || o.experiment || o.since);
  if (!filtered) {
    const rows = listRoots(db, o.limit);
    if (o.json) return console.log(JSON.stringify(rows, null, 2));
    if (!rows.length)
      return console.log("No observations yet. Point an SDK at the server: LANGFUSE_BASE_URL=http://localhost:3000");
    console.log(
      table(
        rows.map((r) => ({
          trace_id: r.trace_id,
          name: short(r.name ?? "", 36),
          type: r.type,
          start: String(r.start_time).replace("T", " ").slice(0, 19),
          duration: dur(secondsBetween(r.start_time, r.end_time)),
          obs: r.observation_count,
          errors: r.error_count || "",
          tokens: r.total_tokens || "",
          cost: money(r.total_cost),
          experiment: r.experiment_id ?? "",
          ...(o.io ? { input: short(r.input, 70), output: short(r.output, 70) } : {}),
        })),
        ["trace_id", "name", "type", "start", "duration", "obs", "errors", "tokens", "cost", "experiment", ...(o.io ? ["input", "output"] : [])],
      ),
    );
    console.log(`\n${rows.length} root observations. Drill into one: langfuse-lite tree <trace_id>`);
    return;
  }
  const rows = findObservations(db, o, o.limit);
  const all = new Set(["core", "basic", "time", "io", "model", "usage"]);
  if (o.json) return console.log(JSON.stringify(rows.map((r) => formatObservation(r, all)), null, 2));
  if (!rows.length) return console.log("No observations match.");
  console.log(
    table(
      rows.map((r) => ({
        id: r.id,
        trace_id: r.trace_id,
        type: r.type,
        name: short(r.name, 30),
        level: r.level === "DEFAULT" ? "" : r.level,
        status: short(r.status_message ?? "", 40),
        start: String(r.start_time).replace("T", " ").slice(0, 19),
        latency: dur(r.latency_ms == null ? null : r.latency_ms / 1000),
        model: r.model ?? "",
        tokens: r.total_usage ?? "",
        cost: money(r.total_cost),
        ...(o.io ? { input: short(r.input, 70), output: short(r.output, 70) } : {}),
      })),
      ["id", "trace_id", "type", "name", "level", "status", "start", "latency", "model", "tokens", "cost", ...(o.io ? ["input", "output"] : [])],
    ),
  );
}

function cmdTree(db: Db, id: string | undefined, o: { json: boolean; io: boolean }) {
  if (!id) throw new Error("usage: langfuse-lite tree <trace id, or the id of one of its observations>");
  const match = db.all<{ trace_id: string }>(
    "SELECT DISTINCT trace_id FROM observations WHERE trace_id LIKE ? || '%' OR id = ? LIMIT 2", id, id);
  if (!match.length) throw new Error(`no observations with trace id or id ${id}`);
  if (match.length > 1) throw new Error(`"${id}" matches more than one trace id; give more characters`);
  const tree = observationTree(db, match[0].trace_id)!;
  if (o.json) return console.log(JSON.stringify(tree, null, 2));
  const obs = tree.observations as any[];
  const scores = tree.scores as any[];
  const start = Math.min(...obs.map((x) => +new Date(x.startTime)));
  const end = Math.max(...obs.map((x) => +new Date(x.endTime ?? x.startTime)));
  const tokens = obs.reduce((a, x) => a + (x.totalUsage || 0), 0);
  const cost = obs.reduce((a, x) => a + (x.totalCost || 0), 0);
  const errors = obs.filter((x) => x.level === "ERROR").length;
  const meta = db.get<Record<string, any>>(
    "SELECT MAX(trace_name) AS name, MAX(user_id) AS user_id, MAX(session_id) AS session_id FROM observations WHERE trace_id = ?",
    tree.traceId,
  )!;
  const head = [
    `trace id ${tree.traceId}`,
    meta.name,
    meta.user_id && `user ${meta.user_id}`,
    meta.session_id && `session ${meta.session_id}`,
    `${obs.length} observations`,
    dur((end - start) / 1000),
    tokens ? `${tokens} tokens` : "",
    money(cost),
    errors ? `${errors} error${errors > 1 ? "s" : ""}` : "",
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
  // The check above is a hint for a clear message; this is what enforces it
  // (WITH … DELETE and writing PRAGMAs pass the check).
  db.exec("PRAGMA query_only = ON");
  try {
    rows = db.all<Record<string, unknown>>(query);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/readonly|read-only/i.test(message)) throw new Error("sql runs read-only queries; this one writes to the database");
    if (/no such (table|column)/.test(message)) {
      const tables = db.all<{ name: string; type: string }>(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' AND name != 'lite_meta' ORDER BY name",
      );
      const v4 = /no such table: traces\b/.test(message)
        ? "\n  like Langfuse v4 there is no traces table: group observations by trace_id, e.g." +
          "\n  SELECT trace_id, MAX(trace_name), COUNT(*), SUM(level = 'ERROR') FROM observations GROUP BY trace_id"
        : "";
      throw new Error(
        `${message}${v4}\n  tables: ${tables.map((t) => t.name).join(", ")}` +
          `\n  columns of one: langfuse-lite sql "PRAGMA table_info(observations)"`,
      );
    }
    throw e;
  }
  if (o.json || !rows.length) return console.log(JSON.stringify(rows, null, 2));
  console.log(table(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, short(v ?? "", 120)]))), Object.keys(rows[0])));
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
      level: { type: "string" },
      name: { type: "string" },
      type: { type: "string" },
      trace: { type: "string" },
      experiment: { type: "string" },
      since: { type: "string" },
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
  if (!COMMANDS.includes(command))
    throw new Error(RENAMED[command] ?? `unknown command "${command}"; see langfuse-lite --help`);
  const limit = (def: number) => intOption("limit", o.limit, def, 1, 100_000);
  if (o.since !== undefined && Number.isNaN(new Date(o.since).getTime()))
    throw new Error(`--since must be a date or time such as 2026-01-31 or 2026-01-31T12:00:00Z, got "${o.since}"`);
  const port = intOption("port", o.port ?? process.env.PORT, 3000, 0, 65535);
  const file = dbPath(o.db);
  const db = await open(file, command);
  try {
    switch (command) {
      case "serve": {
        const server = await serve(db, { host: o.host!, port });
        console.log(`langfuse-lite ${VERSION} listening on ${server.url}  (data: ${file})`);
        console.log(`  LANGFUSE_BASE_URL=${server.url} LANGFUSE_PUBLIC_KEY=pk-lf-local LANGFUSE_SECRET_KEY=sk-lf-local`);
        if (!isLoopback(o.host!))
          console.error(`warning: listening on ${o.host}, not only on this machine. langfuse-lite has no authentication: anyone who can reach this port can read and write the data.`);
        const n = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM observations")!.n;
        const bytes = fs.statSync(file).size;
        if (n > LARGE_DB_OBSERVATIONS || bytes > LARGE_DB_BYTES)
          console.error(`warning: this database holds ${n.toLocaleString("en")} observations (${(bytes / 1e9).toFixed(1)} GB). ${SCALE_HINT}`);
        if (telemetryEnabled()) console.log(`  ${TELEMETRY_NOTICE}`);
        const stopTelemetry = startServeTelemetry(db, { loopback: isLoopback(o.host!) });
        await new Promise<void>((resolve) => {
          const stop = () => resolve();
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
        stopTelemetry();
        await server.stop();
        return;
      }
      case "observations":
        return cmdObservations(db, {
          limit: limit(20), json: o.json!, io: o.io!, level: o.level, name: o.name, type: o.type,
          trace: o.trace, experiment: o.experiment, since: o.since,
        });
      case "tree":
        return cmdTree(db, rest[0], { json: o.json!, io: o.io! });
      case "runs":
        return cmdRuns(db, { json: o.json! });
      case "compare":
        return cmdCompare(db, rest, { json: o.json! });
      case "sql":
        return cmdSql(db, rest.join(" "), { json: o.json! });
      case "export": {
        const out = path.resolve(o.out ?? "langfuse-lite.html");
        const { html, groups, runs } = exportViewer(db, limit(100));
        fs.writeFileSync(out, html);
        console.log(`Wrote ${out}: ${groups} observation trees, ${runs} experiment runs, ${(html.length / 1024).toFixed(0)} KB. Open it in a browser; no server needed.`);
        return;
      }
      case "push": {
        if (!o.to) throw new Error("usage: langfuse-lite push --to <langfuse url> [--public-key ..] [--secret-key ..]");
        const publicKey = o["public-key"] ?? process.env.LANGFUSE_PUBLIC_KEY;
        const secretKey = o["secret-key"] ?? process.env.LANGFUSE_SECRET_KEY;
        if (!publicKey || !secretKey) throw new Error("push needs --public-key and --secret-key (or LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY)");
        const report = await push(db, { baseUrl: o.to, publicKey, secretKey, dryRun: o["dry-run"]!, log: (m) => console.log(m) });
        if (o.json) console.log(JSON.stringify(report, null, 2));
        if (!report.dryRun) await capturePush(db, o.to, report);
        return;
      }
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
