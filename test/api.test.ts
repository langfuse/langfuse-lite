// bun test: the server end to end on a temporary database, without SDKs.
// SDK behaviour is covered by test/conformance.py against a real Langfuse.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { openDb, type Db } from "../src/db";
import { exportViewer, handle } from "../src/api";
import { dbSize, GROWING_DB_BYTES, GROWING_DB_OBSERVATIONS, LARGE_DB_BYTES, LARGE_DB_OBSERVATIONS } from "../src/limits";
import { decodeTraceRequestProto } from "../src/otlp";
import { push } from "../src/push";
import { migrate } from "../src/schema";
import { serve, type Server } from "../src/server";
import { capture, capturePush, POSTHOG_KEY, postViaProxy, proxyFor, startServeTelemetry, telemetryEnabled } from "../src/telemetry";
import { createServer } from "node:http";

let dir: string;
let db: Db;
let server: Server;
const auth = { authorization: "Basic " + btoa("pk-test:sk-test") };
const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(server.url + path, {
    method,
    headers: { ...auth, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : body instanceof Uint8Array ? (body as unknown as BodyInit) : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "langfuse-lite-test-"));
  db = await openDb(join(dir, "lite.db"));
  migrate(db);
  server = await serve(db, { host: "127.0.0.1", port: 0 });
});
afterAll(async () => {
  await server.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---- a minimal protobuf encoder, independent of the decoder under test
const varint = (n: number | bigint) => {
  let v = BigInt(n);
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
};
const bytes = (field: number, data: number[] | Uint8Array) => [...varint((field << 3) | 2), ...varint(data.length), ...data];
const str = (field: number, s: string) => bytes(field, [...new TextEncoder().encode(s)]);
const fixed64 = (field: number, n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return [...varint((field << 3) | 1), ...b];
};
const hexBytes = (h: string) => h.match(/../g)!.map((x) => parseInt(x, 16));
const kvString = (k: string, v: string) => bytes(9, [...str(1, k), ...bytes(2, str(1, v))]);
const kvInt = (k: string, v: number) => bytes(9, [...str(1, k), ...bytes(2, [...varint(3 << 3), ...varint(v)])]);

function protoRequest(spans: number[][]) {
  const scope = bytes(1, [...str(1, "my-tracer"), ...str(2, "1.0")]);
  const scopeSpans = bytes(2, [...scope, ...spans.flatMap((s) => bytes(2, s))]);
  const resource = bytes(1, bytes(1, [...str(1, "service.name"), ...bytes(2, str(1, "proto-test"))]));
  return new Uint8Array(bytes(1, [...resource, ...scopeSpans]));
}
const T0 = 1_763_620_000_000_000_000n;

describe("OTLP ingestion", () => {
  test("protobuf with GenAI attributes becomes a generation with usage and cost", async () => {
    const traceId = "11111111111111111111111111111111";
    const root = [
      ...bytes(1, hexBytes(traceId)), ...bytes(2, hexBytes("aaaaaaaaaaaaaaaa")), ...str(5, "invoke_agent bot"),
      ...fixed64(7, T0), ...fixed64(8, T0 + 2_000_000_000n), ...kvString("gen_ai.operation.name", "invoke_agent"),
    ];
    const chat = [
      ...bytes(1, hexBytes(traceId)), ...bytes(2, hexBytes("bbbbbbbbbbbbbbbb")), ...bytes(4, hexBytes("aaaaaaaaaaaaaaaa")),
      ...str(5, "chat gpt-4o"), ...fixed64(7, T0 + 100_000_000n), ...fixed64(8, T0 + 900_000_000n),
      ...kvString("gen_ai.operation.name", "chat"), ...kvString("gen_ai.request.model", "gpt-4o"),
      ...kvInt("gen_ai.usage.input_tokens", 1000), ...kvInt("gen_ai.usage.output_tokens", 100),
      ...bytes(15, [...str(2, "boom"), ...varint(3 << 3), ...varint(2)]),
    ];
    const body = protoRequest([root, chat]);
    const decoded = decodeTraceRequestProto(body);
    expect(decoded[0].scopeSpans[0].spans[1].parentSpanId).toBe("aaaaaaaaaaaaaaaa");
    expect(decoded[0].scopeSpans[0].spans[1].startTimeUnixNano).toBe(String(T0 + 100_000_000n));

    const res = await fetch(server.url + "/api/public/otel/v1/traces", {
      method: "POST",
      headers: { ...auth, "content-type": "application/x-protobuf", "content-encoding": "gzip" },
      body: gzipSync(body) as unknown as BodyInit,
    });
    expect(res.status).toBe(200);
    const obs = await call("GET", `/api/public/v2/observations?traceId=${traceId}&fields=core,basic,model,usage`);
    const gen = obs.body.data.find((o: any) => o.type === "GENERATION");
    expect(gen).toMatchObject({ name: "chat gpt-4o", model: "gpt-4o", level: "ERROR", statusMessage: "boom", parentObservationId: "aaaaaaaaaaaaaaaa" });
    expect(gen.usageDetails).toEqual({ input: 1000, output: 100, total: 1100 });
    expect(gen.totalCost).toBeCloseTo(1000 * 0.0000025 + 100 * 0.00001, 10);
    expect(gen.latency).toBeCloseTo(0.8, 5);
    const raw = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM otlp_requests WHERE content_type = 'application/x-protobuf'");
    expect(raw!.n).toBeGreaterThan(0);
  });

  test("OTLP/JSON with base64 ids, and experiment attributes become a run", async () => {
    const b64 = (hex: string) => btoa(String.fromCharCode(...hexBytes(hex)));
    const span = (id: string, item: string, output: string) => ({
      traceId: b64(id.repeat(32).slice(0, 32)),
      spanId: b64(id.repeat(16).slice(0, 16)),
      name: "experiment-item-run",
      startTimeUnixNano: String(T0),
      endTimeUnixNano: String(T0 + 5_000_000n),
      attributes: [
        { key: "langfuse.observation.type", value: { stringValue: "span" } },
        { key: "langfuse.observation.output", value: { stringValue: JSON.stringify(output) } },
        { key: "langfuse.environment", value: { stringValue: "sdk-experiment" } },
        { key: "langfuse.experiment.id", value: { stringValue: "exp-json-1" } },
        { key: "langfuse.experiment.name", value: { stringValue: "json-run" } },
        { key: "langfuse.experiment.item.id", value: { stringValue: item } },
        { key: "langfuse.experiment.item.expected_output", value: { stringValue: JSON.stringify("Paris") } },
      ],
    });
    const res = await call("POST", "/api/public/otel/v1/traces", {
      resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: "langfuse-sdk" }, spans: [span("c", "i1", "Paris"), span("d", "i2", "Lyon")] }] }],
    });
    expect(res.status).toBe(200);
    const exps = await call("GET", "/api/public/experiments?fromStartTime=2020-01-01T00:00:00Z");
    expect(exps.body.data.find((e: any) => e.id === "exp-json-1")).toMatchObject({ name: "json-run", itemCount: 2, datasetId: null });
    const items = await call("GET", "/api/public/experiment-items?experimentId=exp-json-1&fromStartTime=2020-01-01T00:00:00Z&fields=io");
    expect(items.body.data.map((i: any) => i.experimentItemId).sort()).toEqual(["i1", "i2"]);
    expect(items.body.data[0].traceId).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("scores", () => {
  test("a batch stores what is valid and reports the rest with 207", async () => {
    const res = await call("POST", "/api/public/scores", [
      { id: "s1", name: "ok", value: 1, traceId: "11111111111111111111111111111111" },
      { name: "missing target", value: 1 },
    ]);
    expect(res.status).toBe(207);
    expect(res.body).toMatchObject({ accepted: 1, rejected: 1 });
    const all = await call("POST", "/api/public/scores", [{ id: "s2", name: "flag", value: true, dataType: "BOOLEAN", sessionId: "sess" }]);
    expect(all).toEqual({ status: 202, body: { message: "Accepted" } });
    const scores = await call("GET", "/api/public/v3/scores?sessionId=sess&fields=subject");
    expect(scores.body.data[0]).toMatchObject({ name: "flag", dataType: "BOOLEAN", value: true, subject: { kind: "session", id: "sess" } });
  });

  test("unknown filters are rejected like Langfuse does", async () => {
    const res = await call("GET", "/api/public/v3/scores?nope=1");
    expect(res.status).toBe(400);
    expect(res.body.error[0].code).toBe("unrecognized_keys");
  });
});

describe("datasets", () => {
  test("create is an upsert by name; items keep their ids", async () => {
    const a = await call("POST", "/api/public/v2/datasets", { name: "ds", description: "one" });
    const b = await call("POST", "/api/public/v2/datasets", { name: "ds", description: "two" });
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.description).toBe("two");
    await call("POST", "/api/public/dataset-items", { datasetName: "ds", id: "item-1", input: { q: 1 }, expectedOutput: "a" });
    await call("POST", "/api/public/dataset-items", { datasetName: "ds", id: "item-1", expectedOutput: "b" });
    const items = await call("GET", "/api/public/dataset-items?datasetName=ds");
    expect(items.body.meta).toMatchObject({ page: 1, totalItems: 1 });
    expect(items.body.data[0]).toMatchObject({ id: "item-1", input: { q: 1 }, expectedOutput: "b", datasetName: "ds", status: "ACTIVE" });
    expect((await call("GET", "/api/public/v2/datasets/nope")).status).toBe(404);
  });
});

describe("misc", () => {
  test("health, projects, viewer and unimplemented routes", async () => {
    expect((await call("GET", "/api/public/health")).body.status).toBe("OK");
    expect((await call("GET", "/api/public/projects")).body.data[0].id).toBe("local");
    expect(await (await fetch(server.url + "/")).text()).toContain("<title>langfuse-lite</title>");
    const prompts = await call("GET", "/api/public/v2/prompts");
    expect(prompts.status).toBe(501);
  });

  test("a 501 names the Langfuse feature that was asked for", async () => {
    const prompts = await call("GET", "/api/public/v2/prompts/my-prompt");
    expect(prompts.status).toBe(501);
    expect(prompts.body.error).toBe("NotImplemented");
    expect(prompts.body.message).toContain("GET /api/public/v2/prompts/my-prompt");
    expect(prompts.body.message).toContain("Prompt Management is part of Langfuse Cloud");
    expect(prompts.body.message).toContain("langfuse-lite push --to <url>");
    expect((await call("POST", "/api/public/prompts", {})).body.message).toContain("Prompt Management");
    for (const path of ["/api/public/metrics", "/api/public/v2/metrics"]) {
      const metrics = await call("GET", path);
      expect(metrics.status).toBe(501);
      expect(metrics.body.message).toContain("Metrics API");
      expect(metrics.body.message).toContain("langfuse-lite sql");
    }
    // score-configs is its own feature, not a part of the scores routes that are served.
    expect((await call("GET", "/api/public/score-configs")).body.message).toContain("Score configuration is part of");
    const legacy = await call("POST", "/api/public/ingestion", { batch: [] });
    expect(legacy.status).toBe(501);
    expect(legacy.body.message).toContain("/api/public/otel/v1/traces");
    const unmapped = await call("GET", "/api/public/organizations/memberships");
    expect(unmapped).toEqual({
      status: 501,
      body: {
        message: "langfuse-lite does not implement GET /api/public/organizations/memberships. It serves tracing (OTLP), scores, datasets and experiments; for the rest, push to a full Langfuse.",
        error: "NotImplemented",
      },
    });
    expect((await call("GET", "/api/nope")).status).toBe(404);
  });

  test("a growing database gets a note well before the hard limits, a small one none", async () => {
    expect(dbSize(0, 0)).toEqual({ level: "ok", note: null });
    expect(dbSize(GROWING_DB_OBSERVATIONS, GROWING_DB_BYTES).level).toBe("ok");
    const byCount = dbSize(GROWING_DB_OBSERVATIONS + 1, 40e6);
    expect(byCount.level).toBe("growing");
    expect(byCount.note).toStartWith("This project is growing (100,001 observations, 40 MB).");
    expect(byCount.note).toContain("langfuse-lite push --to <url>");
    expect(byCount.note).not.toContain("warning");
    expect(dbSize(10, GROWING_DB_BYTES + 1).level).toBe("growing");
    expect(dbSize(LARGE_DB_OBSERVATIONS, LARGE_DB_BYTES).level).toBe("growing");
    expect(dbSize(LARGE_DB_OBSERVATIONS + 1, 0).level).toBe("large");
    expect(dbSize(10, LARGE_DB_BYTES + 1).note).toStartWith("This database holds 10 observations, 2.1 GB.");
    // The viewer reads it from here; the test database is small, so there is nothing to show.
    const status = (await call("GET", "/api/lite/status")).body;
    expect(status).toMatchObject({ level: "ok", note: null });
    expect(status.observations).toBeGreaterThan(0);
    expect(status.bytes).toBeGreaterThan(0);
  });

  test("datasets tab: items with run counts and the runs made on the dataset", async () => {
    const dsId = db.get<{ id: string }>("SELECT id FROM datasets WHERE name = 'ds'")!.id;
    const attr = (key: string, v: string) => ({ key, value: { stringValue: v } });
    await call("POST", "/api/public/otel/v1/traces", {
      resourceSpans: [{ scopeSpans: [{ scope: { name: "langfuse-sdk" }, spans: [{
        traceId: "33333333333333333333333333333333", spanId: "3333333333333333", name: "experiment-item-run",
        startTimeUnixNano: String(T0), endTimeUnixNano: String(T0 + 3_000_000n),
        attributes: [attr("langfuse.experiment.id", "exp-ds-1"), attr("langfuse.experiment.name", "ds-run"),
          attr("langfuse.experiment.dataset.id", dsId), attr("langfuse.experiment.item.id", "item-1")],
      }] }] }],
    });
    const list = await call("GET", "/api/lite/datasets");
    expect(list.body.data.find((d: any) => d.name === "ds")).toMatchObject({ items: 1, runs: 1 });
    const detail = await call("GET", `/api/lite/datasets/${dsId}`);
    expect(detail.body.items[0]).toMatchObject({ id: "item-1", runCount: 1, sourceTraceAvailable: false });
    expect(detail.body.runs.map((r: any) => r.id)).toEqual(["exp-ds-1"]);
    expect((await call("GET", "/api/lite/datasets/nope")).status).toBe(404);
  });

  test("one observations table with Langfuse's field names and derived usage, cost and latency", () => {
    const obs = db.all<Record<string, any>>("SELECT * FROM observations WHERE trace_id = '11111111111111111111111111111111' AND type = 'GENERATION'");
    expect(obs[0]).toMatchObject({ name: "chat gpt-4o", model: "gpt-4o", level: "ERROR", parent_observation_id: "aaaaaaaaaaaaaaaa",
      input_usage: 1000, output_usage: 100, total_usage: 1100 });
    expect(obs[0].latency_ms).toBeCloseTo(800, 0);
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").map((t) => t.name);
    expect(tables).toContain("observations");
    expect(tables).not.toContain("traces");
    expect(tables).not.toContain("events");
  });

  test("root observations come with totals over their trace id; a tree holds every observation of one", async () => {
    const roots = await call("GET", "/api/lite/roots");
    const root = roots.body.data.find((r: any) => r.trace_id === "11111111111111111111111111111111");
    expect(root).toMatchObject({ id: "aaaaaaaaaaaaaaaa", observation_count: 2, error_count: 1, total_tokens: 1100 });
    const tree = await call("GET", "/api/lite/tree/bbbbbbbbbbbbbbbb"); // any observation's id finds its group
    expect(tree.body.traceId).toBe("11111111111111111111111111111111");
    expect(tree.body.observations).toHaveLength(2);
  });

  test("a database from before the rename migrates in place", async () => {
    const old = await openDb(join(dir, "v1.db"));
    old.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_span_id TEXT, name TEXT NOT NULL,
      type TEXT NOT NULL, environment TEXT NOT NULL, version TEXT, release TEXT, tags TEXT NOT NULL, public INTEGER NOT NULL,
      is_app_root INTEGER NOT NULL, trace_name TEXT, user_id TEXT, session_id TEXT, level TEXT NOT NULL, status_message TEXT,
      start_time TEXT NOT NULL, end_time TEXT, completion_start_time TEXT, prompt_name TEXT, prompt_version INTEGER, model_id TEXT,
      provided_model_name TEXT, model_parameters TEXT NOT NULL, provided_usage_details TEXT NOT NULL, usage_details TEXT NOT NULL,
      provided_cost_details TEXT NOT NULL, cost_details TEXT NOT NULL, total_cost REAL, usage_pricing_tier_id TEXT,
      usage_pricing_tier_name TEXT, tool_definitions TEXT NOT NULL, tool_calls TEXT NOT NULL, tool_call_names TEXT NOT NULL,
      input TEXT, output TEXT, metadata TEXT NOT NULL, source TEXT, ingestion_sdk_name TEXT, ingestion_sdk_version TEXT,
      service_name TEXT, service_version TEXT, scope_name TEXT, scope_version TEXT, telemetry_sdk_language TEXT,
      telemetry_sdk_name TEXT, telemetry_sdk_version TEXT, experiment_id TEXT, experiment_name TEXT, experiment_metadata TEXT NOT NULL,
      experiment_description TEXT, experiment_dataset_id TEXT, experiment_item_id TEXT, experiment_item_version TEXT,
      experiment_item_root_span_id TEXT, experiment_item_expected_output TEXT, experiment_item_metadata TEXT NOT NULL,
      otlp_request_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE VIEW traces AS SELECT trace_id AS id FROM events GROUP BY trace_id;
      INSERT INTO events VALUES ('s1','t1',NULL,'root','SPAN','default',NULL,NULL,'[]',0,0,NULL,NULL,NULL,'DEFAULT',NULL,
        '2026-01-01T00:00:00.000Z','2026-01-01T00:00:01.000Z',NULL,NULL,NULL,NULL,'gpt-4o','{}','{}','{"input":5,"total":5}','{}','{}',
        NULL,NULL,NULL,'{}','[]','[]',NULL,NULL,'{}',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'{}',NULL,NULL,
        NULL,NULL,NULL,NULL,'{}',NULL,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');`);
    migrate(old);
    expect(old.get("SELECT model, parent_observation_id, input_usage, latency_ms FROM observations WHERE id = 's1'"))
      .toEqual({ model: "gpt-4o", parent_observation_id: null, input_usage: 5, latency_ms: 1000 });
    expect(old.get("SELECT 1 AS x FROM sqlite_master WHERE name IN ('events', 'traces')")).toBeUndefined();
    migrate(old); // and every later start
    expect(old.get("SELECT COUNT(*) AS n FROM observations")).toEqual({ n: 1 });
    old.close();
  });

  test("load errors tell the user where to go for more volume", async () => {
    const big = new Request("http://lite/api/public/otel/v1/traces", {
      method: "POST", headers: { "content-type": "application/json", "content-length": String(70 * 1024 * 1024) }, body: "{}",
    });
    const res = await handle(db, big);
    expect(res.status).toBe(413);
    expect((await res.json()).message).toContain("Langfuse Cloud");

    // Another process holding the write lock past the busy timeout.
    const other = await openDb(join(dir, "lite.db"));
    other.exec("BEGIN IMMEDIATE");
    try {
      const busy = await call("POST", "/api/public/scores", { name: "x", value: 1, traceId: "t" });
      expect(busy.status).toBe(503);
      expect(busy.body.message).toContain("self-host Langfuse");
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
  }, 20000);

  test("a failed BEGIN leaves the next transaction able to roll back", async () => {
    const path = join(dir, "transactions.db");
    const writer = await openDb(path);
    const locker = await openDb(path);
    try {
      writer.exec("CREATE TABLE entries (value INTEGER); PRAGMA busy_timeout = 1");
      locker.exec("BEGIN IMMEDIATE");
      expect(() => writer.tx(() => writer.run("INSERT INTO entries VALUES (1)"))).toThrow(/locked|busy/i);
      locker.exec("ROLLBACK");
      expect(() => writer.tx(() => {
        writer.run("INSERT INTO entries VALUES (2)");
        throw new Error("cancel transaction");
      })).toThrow("cancel transaction");
      expect(writer.all("SELECT * FROM entries")).toEqual([]);
    } finally {
      locker.close();
      writer.close();
    }
  });

  test("sql reads an existing database without migrating or changing it", async () => {
    const path = join(dir, "readonly.db");
    const writer = await openDb(path);
    try {
      writer.exec("CREATE TABLE entries (value INTEGER); INSERT INTO entries VALUES (7)");
      const sql = (query: string) => Bun.spawnSync(["bun", "src/cli.ts", "sql", query, "--json", "--db", path]);
      const read = sql("SELECT value FROM entries");
      expect(read.exitCode).toBe(0);
      expect(JSON.parse(read.stdout.toString())).toEqual([{ value: 7 }]);
      expect(sql("WITH candidate AS (SELECT 8) INSERT INTO entries SELECT * FROM candidate").exitCode).toBe(1);
      expect(sql("PRAGMA user_version = 3").exitCode).toBe(1);
      expect(writer.all("SELECT * FROM entries")).toEqual([{ value: 7 }]);
      expect(writer.get("PRAGMA user_version")).toEqual({ user_version: 0 });
      expect(writer.all("SELECT name FROM sqlite_schema WHERE type = 'table'")).toEqual([{ name: "entries" }]);
    } finally {
      writer.close();
    }
  });

  test("the CLI points v3 commands at their v4 equivalents", () => {
    const run = Bun.spawnSync(["bun", "src/cli.ts", "traces", "--db", join(dir, "cli.db")], { stderr: "pipe" });
    expect(run.exitCode).toBe(1);
    expect(new TextDecoder().decode(run.stderr)).toContain("langfuse-lite observations");
  });

  test("export embeds the viewer's data in one HTML file", async () => {
    const label = "Budget $& $$ $` $' </script>";
    await call("POST", "/api/public/v2/datasets", { name: "ds", description: label });
    const { html, groups, runs } = exportViewer(db, 100);
    expect(groups).toBeGreaterThan(0);
    expect(runs).toBeGreaterThan(0);
    const json = html.match(/window\.__LITE_DATA__ = (.*?);<\/script>/s)![1];
    const data = JSON.parse(json);
    expect(Object.keys(data.trees)).toContain("11111111111111111111111111111111");
    expect(data.compare.runs.map((r: any) => r.id)).toContain("exp-json-1");
    expect(data.datasets.map((d: any) => d.name)).toContain("ds");
    expect(Object.values(data.datasetDetails).some((d: any) => d.items.length === 1)).toBe(true);
    expect(data.datasets.find((d: any) => d.name === "ds").description).toBe(label);
    expect(json).not.toContain("</");
  });

  test("push replays spans as OTLP/JSON and rewrites local dataset ids", async () => {
    const localId = db.get<{ id: string }>("SELECT id FROM datasets WHERE name = 'ds'")!.id;
    // A span that references the local dataset id, as the SDK's experiment runner does.
    await call("POST", "/api/public/otel/v1/traces", {
      resourceSpans: [{ scopeSpans: [{ scope: { name: "langfuse-sdk" }, spans: [{
        traceId: "22222222222222222222222222222222", spanId: "2222222222222222", name: "run",
        startTimeUnixNano: String(T0), endTimeUnixNano: String(T0),
        attributes: [{ key: "langfuse.experiment.dataset.id", value: { stringValue: localId } }],
      }] }] }],
    });
    const seen: { path: string; body: string }[] = [];
    let projectId = "staging";
    let failAfter = -1;
    const target = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        seen.push({ path, body: await req.text() });
        if (path === "/api/public/projects") return Response.json({ data: [{ id: projectId, name: "target" }] });
        if (path === "/api/public/otel/v1/traces" && failAfter-- === 0) return new Response("retry later", { status: 503 });
        if (path === "/api/public/v2/datasets") return Response.json({ id: "remote-ds-id" });
        return Response.json({});
      },
    });
    try {
      const opts = { baseUrl: `http://127.0.0.1:${target.port}`, publicKey: "pk", secretKey: "sk" };
      // A legacy global timestamp cannot identify which project received the spans.
      db.run("UPDATE otlp_requests SET pushed_at = '2026-01-01'");
      const estimate = await push(db, { ...opts, dryRun: true });
      expect(seen).toHaveLength(0);
      expect(estimate.otlpRequests).toBeGreaterThan(1);
      const report = await push(db, opts);
      expect(report.otlpRequests).toBe(estimate.otlpRequests);
      expect(report.datasets).toBe(1);
      const traces = seen.filter((s) => s.path === "/api/public/otel/v1/traces").map((s) => s.body).join("\n");
      expect(traces).toContain("remote-ds-id");
      expect(traces).not.toContain(localId);
      // Second push: spans are not sent again.
      seen.length = 0;
      await push(db, { ...opts, publicKey: "rotated-key" });
      expect(seen.some((s) => s.path === "/api/public/otel/v1/traces")).toBe(false);
      expect((await push(db, { ...opts, dryRun: true })).otlpRequests).toBe(0);

      // Same host, second project: failure on the second request must leave it pending.
      projectId = "production";
      const production = { ...opts, publicKey: "production-key" };
      failAfter = 1;
      seen.length = 0;
      await expect(push(db, production)).rejects.toThrow("503");
      const attempted = seen.filter((s) => s.path === "/api/public/otel/v1/traces");
      expect(attempted).toHaveLength(2);
      expect((await push(db, { ...production, dryRun: true })).otlpRequests).toBe(report.otlpRequests - 1);
      seen.length = 0;
      await push(db, production);
      const retried = seen.filter((s) => s.path === "/api/public/otel/v1/traces");
      expect(retried).toHaveLength(report.otlpRequests - 1);
      expect(retried[0].body).toBe(attempted[1].body);
      expect((await push(db, { ...production, dryRun: true })).otlpRequests).toBe(0);
    } finally {
      target.stop(true);
    }
  });
});

describe("bad input and other sites", () => {
  const post = (body: BodyInit, headers: Record<string, string>) =>
    fetch(server.url + "/api/public/otel/v1/traces", { method: "POST", headers, body });

  test("requests that cannot be read answer 4xx, not 500", async () => {
    expect((await post("garbage!!", { "content-type": "application/x-protobuf" })).status).toBe(400);
    expect((await post("{nope", { "content-type": "application/json" })).status).toBe(400);
    expect((await post('{"resourceSpans": 1}', { "content-type": "application/json" })).status).toBe(400);
    expect((await post("x", { "content-type": "application/json", "content-encoding": "br" })).status).toBe(415);
    expect((await post("not gzip", { "content-type": "application/json", "content-encoding": "gzip" })).status).toBe(400);
    const badTime = await call("POST", "/api/public/scores", { name: "x", value: 1, traceId: "t", timestamp: "nope" });
    expect(badTime.status).toBe(400);
    // Nothing of the above was stored as a raw request.
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM otlp_requests WHERE span_count = 0")!.n).toBe(0);
  });

  test("a compressed body is limited by its decompressed size", async () => {
    const bomb = gzipSync(new Uint8Array(65 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const res = await post(bomb as unknown as BodyInit, { "content-type": "application/json", "content-encoding": "gzip" });
    expect(res.status).toBe(413);
  });

  test("web pages from other sites are refused; the viewer and SDKs are not", async () => {
    const crossSite = await call("POST", "/api/public/v2/datasets", { name: "csrf" }, { origin: "https://evil.example", "content-type": "text/plain" });
    expect(crossSite.status).toBe(403);
    expect(db.get("SELECT 1 FROM datasets WHERE name = 'csrf'")).toBeUndefined();
    expect((await call("GET", "/api/lite/roots", undefined, { origin: "null" })).status).toBe(403);
    expect((await call("GET", "/api/lite/roots", undefined, { origin: server.url })).status).toBe(200);
    expect((await call("GET", "/api/lite/roots")).status).toBe(200);

    // DNS rebinding: the browser reaches 127.0.0.1 under the attacker's host name.
    const at = (host: string) => handle(db, new Request(`http://${host}/api/lite/roots`), { localOnly: true });
    expect((await at("evil.example:3000")).status).toBe(403);
    for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000", "app.localhost:3000"]) expect((await at(host)).status).toBe(200);
    process.env.LANGFUSE_LITE_ALLOWED_HOSTS = "lite.internal";
    try {
      expect((await at("lite.internal:3000")).status).toBe(200);
    } finally {
      delete process.env.LANGFUSE_LITE_ALLOWED_HOSTS;
    }
    // Listening beyond loopback is the user's choice; any host name is served then.
    expect((await handle(db, new Request("http://my-laptop.lan:3000/api/lite/roots"))).status).toBe(200);
  });

  test("export keeps `$` sequences and line separators in the data intact", async () => {
    const tricky = "costs $$5, $& and $' and $`   </script><script>alert(1)</script>";
    await call("POST", "/api/public/scores", { id: "tricky", name: "note", value: "ok", traceId: "11111111111111111111111111111111", comment: tricky });
    const { html } = exportViewer(db, 100);
    // The first script is the data, the second the viewer: markup added to the viewer must not add one.
    expect(html.match(/<script\b/g)!.length).toBe(2);
    const data = JSON.parse(html.match(/window\.__LITE_DATA__ = (.*?);<\/script>/s)![1]);
    expect(data.status).toMatchObject({ level: "ok", note: null });
    expect(html).toContain('<dialog id="move"');
    const comments = data.trees["11111111111111111111111111111111"].scores.map((s: any) => s.comment);
    expect(comments).toContain(tricky);
  });
});

describe("CLI", () => {
  const cli = (...args: string[]) => {
    const run = Bun.spawnSync(["bun", "src/cli.ts", ...args], { stdout: "pipe", stderr: "pipe" });
    return { code: run.exitCode, out: new TextDecoder().decode(run.stdout), err: new TextDecoder().decode(run.stderr) };
  };

  test("sql cannot write, whatever the statement starts with", () => {
    const file = join(dir, "lite.db");
    const before = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM scores")!.n;
    expect(before).toBeGreaterThan(0);
    for (const query of ["WITH x AS (SELECT 1) DELETE FROM scores", "DELETE FROM scores", "PRAGMA user_version = 7"]) {
      const run = cli("sql", query, "--db", file);
      expect(run.code).toBe(1);
      expect(run.err).toContain("read-only");
    }
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM scores")!.n).toBe(before);
    expect(db.get<{ user_version: number }>("PRAGMA user_version")!.user_version).toBe(0);
    expect(cli("sql", "SELECT COUNT(*) AS n FROM scores", "--db", file, "--json").out).toContain(`"n": ${before}`);
  });

  test("read commands do not create a database; bad options are named", () => {
    const missing = join(dir, "nowhere", "lite.db");
    const run = cli("runs", "--db", missing);
    expect(run.code).toBe(1);
    expect(run.err).toContain("no database at");
    expect(existsSync(join(dir, "nowhere"))).toBe(false);
    const file = join(dir, "lite.db");
    expect(cli("observations", "--limit", "abc", "--db", file).err).toContain("--limit must be");
    expect(cli("observations", "--since", "nope", "--db", file).err).toContain("--since must be");
    expect(cli("--version").out.trim()).toBe(JSON.parse(readFileSync("package.json", "utf8")).version);
  });
});

describe("telemetry", () => {
  const receiver = () => {
    const events: any[] = [];
    const s = Bun.serve({ port: 0, async fetch(req) { events.push(await req.json()); return Response.json({ status: 1 }); } });
    return { events, env: { LANGFUSE_LITE_TELEMETRY_KEY: "phc_test", LANGFUSE_LITE_TELEMETRY_URL: `http://127.0.0.1:${s.port}/capture/` }, stop: () => s.stop(true) };
  };
  const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20)); };

  test("is off without a key, when opted out, and in CI", () => {
    const key = { LANGFUSE_LITE_TELEMETRY_KEY: "phc_test" };
    expect(telemetryEnabled({})).toBe(POSTHOG_KEY !== "");
    expect(telemetryEnabled(key)).toBe(true);
    expect(telemetryEnabled({ ...key, TELEMETRY_ENABLED: "false" })).toBe(false);
    expect(telemetryEnabled({ ...key, DO_NOT_TRACK: "1" })).toBe(false);
    expect(telemetryEnabled({ ...key, CI: "true" })).toBe(false);
  });

  test("serve reports the start, then the first data of the session; counts only", async () => {
    const r = receiver();
    const stop = startServeTelemetry(db, { loopback: true, firstDataDelayMs: 30 }, r.env);
    try {
      await until(() => r.events.length >= 1);
      expect(r.events.map((e) => e.event)).toEqual(["langfuse_lite:serve_started"]);
      const started = r.events[0];
      expect(started.api_key).toBe("phc_test");
      expect(started.properties.observations).toBeGreaterThan(0);
      expect(started.properties.lite_version).toBe(JSON.parse(readFileSync("package.json", "utf8")).version);
      expect(started.properties.$process_person_profile).toBe(false);
      // The id is random, stable per database, and nothing from the data is sent.
      expect(started.distinct_id).toMatch(/^[0-9a-f-]{36}$/);
      const sent = JSON.stringify(r.events);
      for (const secret of ["11111111111111111111111111111111", "exp-json-1", "pk-test", dir]) expect(sent).not.toContain(secret);

      await new Promise((r2) => setTimeout(r2, 80));
      expect(r.events.length).toBe(1); // no new data, no further event
      await call("POST", "/api/public/otel/v1/traces", { resourceSpans: [{ scopeSpans: [{ spans: [{
        traceId: "33333333333333333333333333333333", spanId: "3333333333333333", name: "t",
        startTimeUnixNano: String(T0), endTimeUnixNano: String(T0), attributes: [],
      }] }] }] });
      await until(() => r.events.length >= 2);
      expect(r.events[1].event).toBe("langfuse_lite:first_data");
      expect(r.events[1].distinct_id).toBe(started.distinct_id);
      await new Promise((r2) => setTimeout(r2, 80));
      expect(r.events.length).toBe(2); // once per session
    } finally {
      stop();
      r.stop();
    }
  });

  test("push reports counts and whether the target is Langfuse Cloud, never the host", async () => {
    const r = receiver();
    try {
      await capturePush(db, "https://langfuse.internal.example", { datasets: 1, datasetItems: 2, spans: 3, scores: 4 }, r.env);
      await capturePush(db, "https://us.cloud.langfuse.com", { datasets: 0, datasetItems: 0, spans: 0, scores: 0 }, r.env);
      expect(r.events.map((e) => e.properties.to_langfuse_cloud)).toEqual([false, true]);
      expect(r.events[0].properties.spans).toBe(3);
      expect(JSON.stringify(r.events)).not.toContain("internal.example");
    } finally {
      r.stop();
    }
  });

  test("an unreachable endpoint or opt-out never throws or sends", async () => {
    const dead = { LANGFUSE_LITE_TELEMETRY_KEY: "phc_test", LANGFUSE_LITE_TELEMETRY_URL: "http://127.0.0.1:1/capture/" };
    expect(await capture(db, "langfuse_lite:serve_started", {}, dead)).toBe(false);
    const r = receiver();
    try {
      expect(await capture(db, "x", {}, { ...r.env, TELEMETRY_ENABLED: "false" })).toBe(false);
      expect(r.events.length).toBe(0);
    } finally {
      r.stop();
    }
  });
});

describe("telemetry through a proxy", () => {
  test("the proxy comes from the environment and NO_PROXY is honoured", () => {
    const https = new URL("https://eu.i.posthog.com/capture/");
    expect(proxyFor(https, {})).toBeNull();
    expect(proxyFor(https, { HTTPS_PROXY: "http://user:pw@proxy.local:3128" })!.host).toBe("proxy.local:3128");
    expect(proxyFor(https, { https_proxy: "proxy.local:3128" })!.href).toBe("http://proxy.local:3128/");
    expect(proxyFor(https, { HTTP_PROXY: "http://proxy.local:3128" })).toBeNull(); // only for http targets
    expect(proxyFor(new URL("http://collector.local/x"), { HTTP_PROXY: "http://proxy.local:3128" })!.port).toBe("3128");
    for (const no of ["*", "posthog.com", ".posthog.com", "*.posthog.com", "localhost, eu.i.posthog.com:443"])
      expect(proxyFor(https, { HTTPS_PROXY: "http://proxy.local:3128", NO_PROXY: no })).toBeNull();
    expect(proxyFor(https, { HTTPS_PROXY: "http://proxy.local:3128", NO_PROXY: "example.com,localhost" })).not.toBeNull();
    expect(proxyFor(https, { HTTPS_PROXY: "socks5://proxy.local:1080" })).toBeNull();
  });

  test("an http target is requested from the proxy with its full URL and credentials", async () => {
    const seen: { url: string; auth: string | undefined; body: string }[] = [];
    const proxy = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ url: req.url ?? "", auth: req.headers["proxy-authorization"], body });
        res.end("{}");
      });
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    const port = (proxy.address() as { port: number }).port;
    try {
      const ok = await postViaProxy(new URL("http://collector.invalid/capture/"), new URL(`http://u:p@127.0.0.1:${port}`), '{"a":1}');
      expect(ok).toBe(true);
      expect(seen).toEqual([{ url: "http://collector.invalid/capture/", auth: "Basic " + btoa("u:p"), body: '{"a":1}' }]);
      // A proxy that is not there, or refuses the tunnel, is a quiet false.
      expect(await postViaProxy(new URL("https://collector.invalid/capture/"), new URL("http://127.0.0.1:1"), "{}", 500)).toBe(false);
    } finally {
      proxy.close();
    }
  });
});
