// Copies a langfuse-lite database into a full Langfuse (Cloud or self-hosted)
// through its public API, so the real Langfuse does the processing and shows
// everything in its UI.
//
//   1. datasets (upsert by name) and their items (same ids)
//   2. every OTLP request not pushed yet, replayed as OTLP/JSON; local dataset
//      ids in span attributes are rewritten to the target's dataset ids
//   3. scores (same ids, so a second push updates instead of duplicating)

import type { Db } from "./db";
import { decodeTraceRequest } from "./ingest";
import { encodeTraceRequestJson, type AnyValue, type KeyValue, type ResourceSpans } from "./otlp";

export type PushOptions = {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  dryRun?: boolean;
  log?: (msg: string) => void;
};

const parse = (s: unknown) => {
  if (typeof s !== "string") return s ?? undefined;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

export async function push(db: Db, opts: PushOptions) {
  const log = opts.log ?? (() => {});
  const base = opts.baseUrl.replace(/\/+$/, "");
  const auth = "Basic " + btoa(`${opts.publicKey}:${opts.secretKey}`);
  const call = async (method: string, path: string, body?: unknown, contentType = "application/json") => {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: auth, "content-type": contentType },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };

  // Cache the key-to-project lookup so dry runs also work offline. A new key
  // gets a conservative estimate until its project has been verified.
  const cacheKey = JSON.stringify(["push-project", base, opts.publicKey]);
  let projectId: string | null;
  if (opts.dryRun) {
    projectId = db.get<{ value: string }>("SELECT value FROM lite_meta WHERE key = ?", cacheKey)?.value ?? null;
  } else {
    const project = (await call("GET", "/api/public/projects"))?.data?.[0];
    if (typeof project?.id !== "string" || !project.id) throw new Error("Target returned no project ID");
    projectId = project.id;
    db.run("INSERT OR REPLACE INTO lite_meta (key, value) VALUES (?, ?)", cacheKey, projectId);
    log(`  target project: ${project.name ?? "?"} (${projectId})`);
  }
  const pending = `FROM otlp_requests r WHERE NOT EXISTS (
    SELECT 1 FROM otlp_deliveries d WHERE d.base_url = ? AND d.project_id = ? AND d.request_id = r.id
  )`;
  const totals = db.get<{ requests: number; spans: number; last_id: number }>(
    `SELECT COUNT(*) AS requests, COALESCE(SUM(span_count), 0) AS spans, COALESCE(MAX(id), 0) AS last_id ${pending}`,
    base, projectId,
  )!;
  const counts = db.get<{ datasets: number; datasetItems: number; scores: number }>(
    `SELECT (SELECT COUNT(*) FROM datasets) AS datasets, (SELECT COUNT(*) FROM dataset_items) AS datasetItems,
      (SELECT COUNT(*) FROM scores) AS scores`,
  )!;
  const report = {
    target: base,
    ...counts,
    otlpRequests: totals.requests,
    spans: totals.spans,
    dryRun: Boolean(opts.dryRun),
  };
  log(
    `${opts.dryRun ? "Would push" : "Pushing"} to ${base}: ${report.datasets} datasets, ${report.datasetItems} items, ` +
      `${report.spans} spans in ${report.otlpRequests} requests, ${report.scores} scores`,
  );
  if (opts.dryRun) return report;

  const datasets = db.all<Record<string, any>>("SELECT * FROM datasets ORDER BY created_at");
  const items = db.all<Record<string, any>>(
    "SELECT i.*, d.name AS dataset_name FROM dataset_items i JOIN datasets d ON d.id = i.dataset_id ORDER BY i.created_at",
  );
  const scores = db.all<Record<string, any>>("SELECT * FROM scores ORDER BY timestamp");
  const datasetIds = new Map<string, string>();
  for (const d of datasets) {
    const created = await call("POST", "/api/public/v2/datasets", {
      name: d.name,
      description: d.description ?? undefined,
      metadata: parse(d.metadata),
      inputSchema: parse(d.input_schema),
      expectedOutputSchema: parse(d.expected_output_schema),
    });
    datasetIds.set(d.id, created.id);
  }
  for (const i of items) {
    await call("POST", "/api/public/dataset-items", {
      id: i.id,
      datasetName: i.dataset_name,
      input: parse(i.input),
      expectedOutput: parse(i.expected_output),
      metadata: parse(i.metadata),
      sourceTraceId: i.source_trace_id ?? undefined,
      sourceObservationId: i.source_observation_id ?? undefined,
      status: i.status,
    });
  }
  if (datasets.length) log(`  datasets and items done`);

  // A single payload can be large. Fetch one at a time, stopping at the last
  // request counted above even if the local server keeps ingesting more.
  let lastId = 0;
  while (lastId < totals.last_id) {
    const r = db.get<{ id: number; content_type: string; body: Uint8Array }>(
      `SELECT r.id, r.content_type, r.body ${pending} AND r.id > ? AND r.id <= ? ORDER BY r.id LIMIT 1`,
      base, projectId, lastId, totals.last_id,
    );
    if (!r) break;
    const resourceSpans = decodeTraceRequest(r.body, r.content_type);
    rewriteDatasetIds(resourceSpans, datasetIds);
    await call("POST", "/api/public/otel/v1/traces", encodeTraceRequestJson(resourceSpans));
    db.tx(() => {
      db.run("INSERT OR IGNORE INTO otlp_deliveries (base_url, project_id, request_id) VALUES (?, ?, ?)", base, projectId, r.id);
      db.run("UPDATE otlp_requests SET pushed_at = ? WHERE id = ?", new Date().toISOString(), r.id);
    });
    lastId = r.id;
  }
  if (totals.requests) log(`  spans done`);

  for (const s of scores) {
    const value =
      s.data_type === "NUMERIC" ? s.value : s.data_type === "BOOLEAN" ? s.value : (s.string_value ?? String(s.value));
    await call("POST", "/api/public/scores", {
      id: s.id,
      name: s.name,
      value,
      dataType: s.data_type,
      traceId: s.trace_id ?? undefined,
      observationId: s.observation_id ?? undefined,
      sessionId: s.session_id ?? undefined,
      datasetRunId: s.dataset_run_id ?? undefined,
      comment: s.comment ?? undefined,
      metadata: parse(s.metadata),
      configId: s.config_id ?? undefined,
      environment: s.environment,
      timestamp: s.timestamp,
    });
  }
  if (scores.length) log(`  scores done`);
  log("Done. Traces and experiments appear in the target once its worker has processed them.");
  return report;
}

function rewriteDatasetIds(resourceSpans: ResourceSpans[], ids: Map<string, string>) {
  if (!ids.size) return;
  const fix = (v: AnyValue) => {
    if (v.stringValue !== undefined) {
      if (ids.has(v.stringValue)) v.stringValue = ids.get(v.stringValue)!;
      else if (v.stringValue.includes('"')) {
        // JSON-encoded metadata such as {"dataset_id": "<local id>"}
        let s = v.stringValue;
        for (const [local, remote] of ids) s = s.split(`"${local}"`).join(`"${remote}"`);
        v.stringValue = s;
      }
    }
    v.arrayValue?.values.forEach(fix);
    v.kvlistValue?.values.forEach((kv) => fix(kv.value));
  };
  const fixAll = (kvs: KeyValue[] | undefined) => kvs?.forEach((kv) => fix(kv.value));
  // OTLP/JSON may leave out empty lists.
  for (const rs of resourceSpans ?? [])
    for (const ss of rs.scopeSpans ?? [])
      for (const s of ss.spans ?? []) {
        fixAll(s.attributes);
        s.events?.forEach((e) => fixAll(e.attributes));
      }
}
