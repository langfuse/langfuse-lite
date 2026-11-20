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

  const datasets = db.all<Record<string, any>>("SELECT * FROM datasets ORDER BY created_at");
  const items = db.all<Record<string, any>>(
    "SELECT i.*, d.name AS dataset_name FROM dataset_items i JOIN datasets d ON d.id = i.dataset_id ORDER BY i.created_at",
  );
  const requests = db.all<{ id: number; content_type: string; body: Uint8Array; span_count: number }>(
    "SELECT id, content_type, body, span_count FROM otlp_requests WHERE pushed_at IS NULL ORDER BY id",
  );
  const scores = db.all<Record<string, any>>("SELECT * FROM scores ORDER BY timestamp");
  const report = {
    target: base,
    datasets: datasets.length,
    datasetItems: items.length,
    otlpRequests: requests.length,
    spans: requests.reduce((n, r) => n + r.span_count, 0),
    scores: scores.length,
    dryRun: Boolean(opts.dryRun),
  };
  log(
    `${opts.dryRun ? "Would push" : "Pushing"} to ${base}: ${report.datasets} datasets, ${report.datasetItems} items, ` +
      `${report.spans} spans in ${report.otlpRequests} requests, ${report.scores} scores`,
  );
  if (opts.dryRun) return report;

  const project = await call("GET", "/api/public/projects");
  log(`  target project: ${project?.data?.[0]?.name ?? "?"} (${project?.data?.[0]?.id ?? "?"})`);

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

  for (const r of requests) {
    const resourceSpans = decodeTraceRequest(r.body, r.content_type);
    rewriteDatasetIds(resourceSpans, datasetIds);
    await call("POST", "/api/public/otel/v1/traces", encodeTraceRequestJson(resourceSpans));
    db.run("UPDATE otlp_requests SET pushed_at = ? WHERE id = ?", new Date().toISOString(), r.id);
  }
  if (requests.length) log(`  spans done`);

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
