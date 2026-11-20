// The Langfuse public API slice: a fetch-style handler, (Request) => Response,
// so it runs unchanged under Bun.serve and node:http. Request validation and
// response shapes follow Langfuse 4.x; see docs/slim-server.md for the list.

import type { Db, Param } from "./db";
import { decompress, ingestTraceRequest } from "./ingest";
import { findModelById, LANGFUSE_VERSION } from "./langfuse";
import { VIEWER_HTML } from "./viewer";

export const PROJECT = { id: "local", name: "langfuse-lite" };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly error: unknown = undefined,
  ) {
    super(message);
  }
}
const notFound = (what: string) => new HttpError(404, `${what} not found`, "LangfuseNotFoundError");
const invalid = (message: string) => new HttpError(400, "Invalid request data", [{ code: "custom", message }]);

const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ---------------------------------------------------------------- helpers

const parseJson = (s: unknown) => {
  if (typeof s !== "string") return s ?? null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};
/** Metadata is stored flat as path → string; Langfuse returns JSON-looking values parsed. */
const metadataValues = (raw: unknown) => {
  const flat = (parseJson(raw) ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flat)) {
    if (typeof v !== "string") out[k] = v;
    else if (/^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null|\{.*\}|\[.*\])$/s.test(v)) out[k] = parseJson(v);
    else out[k] = v;
  }
  return out;
};
const iso = (s: unknown) => (s == null ? null : new Date(String(s)).toISOString());
const isIsoDateTime = (s: string) => /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(s);
const newCuid = () => "c" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
const nowIso = () => new Date().toISOString();

function fieldsOf(q: URLSearchParams, allowed: string[], defaults: string[]): Set<string> {
  const raw = q.get("fields");
  if (!raw) return new Set(defaults);
  const fields = raw.split(",").map((f) => f.trim()).filter(Boolean);
  for (const f of fields)
    if (!allowed.includes(f))
      throw new HttpError(400, "Invalid request data", [
        { code: "invalid_value", values: allowed, path: ["fields", 0], message: `Invalid option: expected one of ${allowed.map((a) => `"${a}"`).join("|")}` },
      ]);
  return new Set(["core", ...fields]);
}

function limitOf(q: URLSearchParams, def = 50, max = 1000) {
  const n = q.has("limit") ? Number(q.get("limit")) : def;
  if (!Number.isInteger(n) || n < 1 || n > max) throw invalid(`limit must be an integer between 1 and ${max}`);
  return n;
}

function requireIsoParam(q: URLSearchParams, name: string, required: boolean): string | null {
  const v = q.get(name);
  if (v == null) {
    if (required)
      throw new HttpError(400, "Invalid request data", [
        { expected: "string", code: "invalid_type", path: [name], message: `${name} is required. It bounds the query to a time window; pass an ISO 8601 datetime with offset (e.g. 2024-01-01T00:00:00Z).` },
      ]);
    return null;
  }
  if (!isIsoDateTime(v)) throw invalid(`${name} must be an ISO 8601 datetime with offset (e.g. 2024-01-01T00:00:00Z).`);
  return new Date(v).toISOString();
}

type Cursor = { t: string; id: string };
const encodeCursor = (c: Cursor) => btoa(JSON.stringify(c));
function decodeCursor(q: URLSearchParams): Cursor | null {
  const raw = q.get("cursor");
  if (!raw) return null;
  try {
    const c = JSON.parse(atob(raw));
    if (typeof c.t === "string" && typeof c.id === "string") return c;
  } catch {
    // fall through
  }
  throw invalid("invalid cursor");
}

/** Keyset page over rows ordered by (timeColumn DESC, id DESC). */
function page<T extends Record<string, unknown>>(
  db: Db,
  sql: { from: string; where: string[]; params: Param[]; time: string; id: string; select?: string },
  q: URLSearchParams,
  limit: number,
): { rows: T[]; cursor?: string } {
  const where = [...sql.where];
  const params = [...sql.params];
  const cursor = decodeCursor(q);
  if (cursor) {
    where.push(`(${sql.time} < ? OR (${sql.time} = ? AND ${sql.id} < ?))`);
    params.push(cursor.t, cursor.t, cursor.id);
  }
  const rows = db.all<T>(
    `SELECT ${sql.select ?? "*"} FROM ${sql.from} ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY ${sql.time} DESC, ${sql.id} DESC LIMIT ?`,
    ...params,
    limit + 1,
  );
  if (rows.length <= limit) return { rows };
  rows.length = limit;
  const last = rows[limit - 1] as Record<string, unknown>;
  return { rows, cursor: encodeCursor({ t: String(last.__t), id: String(last.__id) }) };
}

async function bodyJson(req: Request): Promise<Record<string, any>> {
  try {
    const b = await req.json();
    if (b && typeof b === "object") return b as Record<string, any>;
  } catch {
    // fall through
  }
  throw invalid("request body must be a JSON object");
}

// ---------------------------------------------------------------- observations

type EventRow = Record<string, any>;

function modelPrices(modelId: string | null) {
  const tier = findModelById(modelId)?.pricingTiers.find((t) => t.isDefault);
  const price = (k: string) => tier?.prices.find((p) => p.usageType === k)?.price.toString() ?? null;
  return { inputPrice: price("input"), outputPrice: price("output"), totalPrice: price("total") };
}

const seconds = (a: string | null, b: string | null) =>
  a && b ? (new Date(b).getTime() - new Date(a).getTime()) / 1000 : null;
const num = (v: unknown) => (typeof v === "number" ? v : null);

export function formatObservation(r: EventRow, fields: Set<string>) {
  const o: Record<string, unknown> = {
    id: r.id,
    traceId: r.trace_id,
    startTime: iso(r.start_time),
    endTime: iso(r.end_time),
    projectId: PROJECT.id,
    parentObservationId: r.parent_span_id ?? null,
    type: r.type,
  };
  if (fields.has("basic")) {
    Object.assign(o, {
      name: r.name,
      level: r.level,
      statusMessage: r.status_message ?? "",
      version: r.version ?? "",
      environment: r.environment,
      bookmarked: false,
      public: Boolean(r.public),
      userId: r.user_id ?? "",
      sessionId: r.session_id ?? "",
      isRootObservation: r.parent_span_id == null,
    });
  }
  if (fields.has("time")) {
    Object.assign(o, {
      completionStartTime: iso(r.completion_start_time),
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    });
  }
  if (fields.has("io")) Object.assign(o, { input: r.input ?? null, output: r.output ?? null });
  if (fields.has("metadata")) o.metadata = metadataValues(r.metadata);
  if (fields.has("model")) {
    Object.assign(o, {
      model: r.provided_model_name ?? "",
      internalModelId: r.model_id ?? "",
      modelParameters: parseJson(r.model_parameters) ?? {},
    });
  }
  if (fields.has("usage")) {
    const usage = (parseJson(r.usage_details) ?? {}) as Record<string, number>;
    const cost = (parseJson(r.cost_details) ?? {}) as Record<string, number>;
    Object.assign(o, {
      usageDetails: usage,
      inputUsage: usage.input ?? 0,
      outputUsage: usage.output ?? 0,
      totalUsage: usage.total ?? 0,
      costDetails: cost,
      inputCost: num(cost.input),
      outputCost: num(cost.output),
      totalCost: num(cost.total) ?? r.total_cost ?? null,
      usagePricingTierId: r.usage_pricing_tier_id ?? null,
      usagePricingTierName: r.usage_pricing_tier_name ?? null,
    });
  }
  if (fields.has("prompt")) {
    Object.assign(o, { promptId: "", promptName: r.prompt_name ?? "", promptVersion: r.prompt_version ?? null });
  }
  // With the metrics fields Langfuse reports 0 s as null, without them as 0.
  // Model id and prices are only filled in with the model fields.
  const zero = fields.has("metrics") ? null : 0;
  const latency = seconds(r.start_time, r.end_time);
  const ttft = seconds(r.start_time, r.completion_start_time);
  Object.assign(o, {
    latency: latency === 0 ? zero : latency,
    timeToFirstToken: ttft === 0 ? zero : ttft,
    modelId: fields.has("model") ? (r.model_id ?? null) : null,
    ...modelPrices(fields.has("model") ? (r.model_id ?? null) : null),
  });
  return o;
}

const OBSERVATION_FIELDS = ["core", "basic", "time", "io", "metadata", "model", "usage", "prompt", "metrics"];

function listObservations(db: Db, q: URLSearchParams) {
  const fields = fieldsOf(q, OBSERVATION_FIELDS, ["core", "basic"]);
  const limit = limitOf(q, 50, 1000);
  const where: string[] = [];
  const params: Param[] = [];
  const eq = (param: string, column: string) => {
    const v = q.get(param);
    if (v != null) {
      where.push(`${column} = ?`);
      params.push(v);
    }
  };
  eq("traceId", "trace_id");
  eq("name", "name");
  eq("type", "type");
  eq("userId", "user_id");
  eq("sessionId", "session_id");
  eq("level", "level");
  eq("parentObservationId", "parent_span_id");
  eq("environment", "environment");
  eq("version", "version");
  eq("experimentId", "experiment_id");
  const from = requireIsoParam(q, "fromStartTime", false);
  const to = requireIsoParam(q, "toStartTime", false);
  if (from) where.push("start_time >= ?"), params.push(from);
  if (to) where.push("start_time < ?"), params.push(to);
  const { rows, cursor } = page<EventRow>(
    db,
    { from: "events", where, params, time: "start_time", id: "id", select: "*, start_time AS __t, id AS __id" },
    q,
    limit,
  );
  return { data: rows.map((r) => formatObservation(r, fields)), meta: cursor ? { cursor } : {} };
}

// ---------------------------------------------------------------- scores

type ScoreRow = Record<string, any>;

function subjectOf(r: ScoreRow) {
  if (r.observation_id) return { kind: "observation", id: r.observation_id, traceId: r.trace_id };
  if (r.trace_id) return { kind: "trace", id: r.trace_id };
  if (r.session_id) return { kind: "session", id: r.session_id };
  if (r.dataset_run_id) return { kind: "experiment", id: r.dataset_run_id };
  return null;
}

function scoreValue(r: ScoreRow) {
  if (r.data_type === "CATEGORICAL" || r.data_type === "TEXT") return r.string_value;
  if (r.data_type === "BOOLEAN") return r.value === 1;
  return r.value;
}

export function formatScore(r: ScoreRow, fields: Set<string>) {
  const s: Record<string, unknown> = {
    id: r.id,
    projectId: PROJECT.id,
    name: r.name,
    source: r.source,
    timestamp: iso(r.timestamp),
    environment: r.environment,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
  if (fields.has("details"))
    Object.assign(s, { comment: r.comment ?? null, configId: r.config_id ?? null, metadata: parseJson(r.metadata) ?? {} });
  if (fields.has("annotation")) Object.assign(s, { authorUserId: r.author_user_id ?? null, queueId: r.queue_id ?? null });
  if (fields.has("subject")) s.subject = subjectOf(r);
  s.dataType = r.data_type;
  s.value = scoreValue(r);
  return s;
}

const SCORE_PARAMS = new Set([
  "limit", "cursor", "fields", "traceId", "observationId", "sessionId", "experimentId", "name", "dataType",
  "source", "environment", "configId", "fromTimestamp", "toTimestamp", "queueId", "value", "operator",
]);

function listScores(db: Db, q: URLSearchParams) {
  const unknown = [...q.keys()].filter((k) => !SCORE_PARAMS.has(k));
  if (unknown.length)
    throw new HttpError(400, "Invalid request data", [
      { code: "unrecognized_keys", keys: unknown, path: [], message: `Unrecognized key: "${unknown[0]}"` },
    ]);
  if (q.get("observationId") && !q.get("traceId"))
    throw invalid("observationId filter requires traceId — observation IDs are scoped to a trace");
  const fields = fieldsOf(q, ["core", "details", "subject", "annotation"], ["core"]);
  const limit = limitOf(q, 50, 1000);
  const where: string[] = [];
  const params: Param[] = [];
  const eq = (param: string, column: string) => {
    const v = q.get(param);
    if (v != null) where.push(`${column} = ?`), params.push(v);
  };
  eq("traceId", "trace_id");
  eq("observationId", "observation_id");
  eq("sessionId", "session_id");
  eq("experimentId", "dataset_run_id");
  eq("name", "name");
  eq("dataType", "data_type");
  eq("source", "source");
  eq("environment", "environment");
  eq("configId", "config_id");
  eq("queueId", "queue_id");
  const from = requireIsoParam(q, "fromTimestamp", false);
  const to = requireIsoParam(q, "toTimestamp", false);
  if (from) where.push("timestamp >= ?"), params.push(from);
  if (to) where.push("timestamp < ?"), params.push(to);
  const { rows, cursor } = page<ScoreRow>(
    db,
    { from: "scores", where, params, time: "timestamp", id: "id", select: "*, timestamp AS __t, id AS __id" },
    q,
    limit,
  );
  return { data: rows.map((r) => formatScore(r, fields)), meta: { limit, ...(cursor ? { cursor } : {}) } };
}

function createScore(db: Db, b: Record<string, any>) {
  if (typeof b.name !== "string" || !b.name) throw invalid("name is required");
  if (b.value === undefined || b.value === null) throw invalid("value is required");
  const targets = [b.traceId, b.sessionId, b.datasetRunId].filter((v) => v != null && v !== "").length;
  if (targets !== 1 || (b.observationId && !b.traceId))
    throw invalid(
      "Provide exactly one of the following: traceId (with optional observationId), sessionId or datasetRunId. ObservationId requires traceId.",
    );
  let dataType: string = b.dataType ?? (typeof b.value === "string" ? "CATEGORICAL" : typeof b.value === "boolean" ? "BOOLEAN" : "NUMERIC");
  dataType = String(dataType).toUpperCase();
  let value: number | null = null;
  let stringValue: string | null = null;
  if (dataType === "NUMERIC") {
    value = Number(b.value);
    if (!Number.isFinite(value)) throw invalid("NUMERIC scores need a numeric value");
  } else if (dataType === "BOOLEAN") {
    const v = b.value === true || b.value === 1 || b.value === "1" || String(b.value).toLowerCase() === "true";
    const f = b.value === false || b.value === 0 || b.value === "0" || String(b.value).toLowerCase() === "false";
    if (!v && !f) throw invalid("BOOLEAN scores need 0/1 or true/false");
    value = v ? 1 : 0;
    stringValue = v ? "True" : "False";
  } else if (dataType === "CATEGORICAL" || dataType === "TEXT" || dataType === "CORRECTION") {
    stringValue = String(b.value);
  } else throw invalid(`unknown dataType ${dataType}`);
  const id = typeof b.id === "string" && b.id ? b.id : crypto.randomUUID();
  const t = nowIso();
  db.run(
    `INSERT INTO scores (id, name, value, string_value, data_type, source, trace_id, observation_id, session_id,
       dataset_run_id, comment, metadata, config_id, queue_id, environment, timestamp, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, value = excluded.value, string_value = excluded.string_value,
       data_type = excluded.data_type, trace_id = excluded.trace_id, observation_id = excluded.observation_id,
       session_id = excluded.session_id, dataset_run_id = excluded.dataset_run_id, comment = excluded.comment,
       metadata = excluded.metadata, config_id = excluded.config_id, queue_id = excluded.queue_id,
       environment = excluded.environment, timestamp = excluded.timestamp, updated_at = excluded.updated_at`,
    id, b.name, value, stringValue, dataType, "API", b.traceId ?? null, b.observationId ?? null,
    b.sessionId ?? null, b.datasetRunId ?? null, b.comment ?? null, JSON.stringify(b.metadata ?? {}),
    b.configId ?? null, b.queueId ?? null, b.environment ?? "default", iso(b.timestamp) ?? t, t, t,
  );
  return { id };
}

// ---------------------------------------------------------------- datasets

type DatasetRow = Record<string, any>;
const formatDataset = (r: DatasetRow) => ({
  id: r.id,
  projectId: PROJECT.id,
  name: r.name,
  description: r.description ?? null,
  metadata: parseJson(r.metadata),
  inputSchema: parseJson(r.input_schema),
  expectedOutputSchema: parseJson(r.expected_output_schema),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});
const formatItem = (r: Record<string, any>) => ({
  id: r.id,
  datasetId: r.dataset_id,
  sourceTraceId: r.source_trace_id ?? null,
  sourceObservationId: r.source_observation_id ?? null,
  status: r.status,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  input: parseJson(r.input),
  expectedOutput: parseJson(r.expected_output),
  metadata: parseJson(r.metadata),
  datasetName: r.dataset_name,
  version: iso(r.updated_at),
  mediaReferences: [],
});

const datasetByName = (db: Db, name: string) => db.get<DatasetRow>("SELECT * FROM datasets WHERE name = ?", name);
const enc = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

function upsertDataset(db: Db, b: Record<string, any>) {
  if (typeof b.name !== "string" || !b.name) throw invalid("name is required");
  const existing = datasetByName(db, b.name);
  const t = nowIso();
  if (existing) {
    db.run(
      `UPDATE datasets SET description = COALESCE(?, description), metadata = COALESCE(?, metadata),
         input_schema = COALESCE(?, input_schema), expected_output_schema = COALESCE(?, expected_output_schema),
         updated_at = ? WHERE id = ?`,
      b.description ?? null, enc(b.metadata), enc(b.inputSchema), enc(b.expectedOutputSchema), t, existing.id,
    );
  } else {
    db.run(
      `INSERT INTO datasets (id, name, description, metadata, input_schema, expected_output_schema, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      newCuid(), b.name, b.description ?? null, enc(b.metadata), enc(b.inputSchema), enc(b.expectedOutputSchema), t, t,
    );
  }
  return formatDataset(datasetByName(db, b.name)!);
}

function pageMeta(q: URLSearchParams, total: number) {
  const pageNo = q.has("page") ? Number(q.get("page")) : 1;
  const limit = limitOf(q, 50, 1000);
  if (!Number.isInteger(pageNo) || pageNo < 1) throw invalid("page must be a positive integer");
  return { page: pageNo, limit, totalItems: total, totalPages: Math.ceil(total / limit), offset: (pageNo - 1) * limit };
}

function listDatasets(db: Db, q: URLSearchParams) {
  const total = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM datasets")!.n;
  const { offset, ...meta } = pageMeta(q, total);
  const rows = db.all<DatasetRow>("SELECT * FROM datasets ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?", meta.limit, offset);
  return { data: rows.map(formatDataset), meta };
}

const ITEM_SELECT = "SELECT i.*, d.name AS dataset_name FROM dataset_items i JOIN datasets d ON d.id = i.dataset_id";

function upsertItem(db: Db, b: Record<string, any>) {
  if (typeof b.datasetName !== "string") throw invalid("datasetName is required");
  const ds = datasetByName(db, b.datasetName);
  if (!ds) throw notFound("Dataset");
  const id = typeof b.id === "string" && b.id ? b.id : crypto.randomUUID();
  const t = nowIso();
  const existing = db.get<{ dataset_id: string }>("SELECT dataset_id FROM dataset_items WHERE id = ?", id);
  if (existing && existing.dataset_id !== ds.id) throw invalid("dataset item id already exists in another dataset");
  db.run(
    `INSERT INTO dataset_items (id, dataset_id, input, expected_output, metadata, source_trace_id, source_observation_id,
       status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET input = COALESCE(excluded.input, input),
       expected_output = COALESCE(excluded.expected_output, expected_output),
       metadata = COALESCE(excluded.metadata, metadata), source_trace_id = COALESCE(excluded.source_trace_id, source_trace_id),
       source_observation_id = COALESCE(excluded.source_observation_id, source_observation_id),
       status = excluded.status, updated_at = excluded.updated_at`,
    id, ds.id, enc(b.input), enc(b.expectedOutput), enc(b.metadata), b.sourceTraceId ?? null,
    b.sourceObservationId ?? null, b.status ?? "ACTIVE", t, t,
  );
  return formatItem(db.get(`${ITEM_SELECT} WHERE i.id = ?`, id)!);
}

function listItems(db: Db, q: URLSearchParams) {
  const where: string[] = [];
  const params: Param[] = [];
  const name = q.get("datasetName");
  if (name) {
    const ds = datasetByName(db, name);
    if (!ds) throw notFound("Dataset");
    where.push("i.dataset_id = ?"), params.push(ds.id);
  }
  if (q.get("sourceTraceId")) where.push("i.source_trace_id = ?"), params.push(q.get("sourceTraceId")!);
  if (q.get("sourceObservationId")) where.push("i.source_observation_id = ?"), params.push(q.get("sourceObservationId")!);
  const w = where.length ? " WHERE " + where.join(" AND ") : "";
  const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM dataset_items i${w}`, ...params)!.n;
  const { offset, ...meta } = pageMeta(q, total);
  const rows = db.all(`${ITEM_SELECT}${w} ORDER BY i.created_at DESC, i.id DESC LIMIT ? OFFSET ?`, ...params, meta.limit, offset);
  return { data: rows.map(formatItem), meta };
}

// ---------------------------------------------------------------- experiments

// An experiment item is the root span of one item run: the span carrying the
// experiment fields with no parent (the SDK's "experiment-item-run" span).
const itemRoots = (a = "e") => `events ${a} WHERE ${a}.experiment_id IS NOT NULL AND ${a}.experiment_item_id IS NOT NULL
  AND (${a}.id = ${a}.experiment_item_root_span_id OR (${a}.experiment_item_root_span_id IS NULL AND ${a}.parent_span_id IS NULL))`;

function scoresFor(db: Db, column: "dataset_run_id" | "observation_id", id: string) {
  return db
    .all<ScoreRow>(`SELECT * FROM scores WHERE ${column} = ? ORDER BY timestamp, id`, id)
    .map((s) => formatScore(s, new Set(["core", "subject"])));
}

function listExperiments(db: Db, q: URLSearchParams) {
  const from = requireIsoParam(q, "fromStartTime", true)!;
  const to = requireIsoParam(q, "toStartTime", false);
  const fields = fieldsOf(q, ["core", "metadata", "scores"], ["core"]);
  const limit = limitOf(q, 50, 1000);
  const where = ["start_time >= ?"];
  const params: Param[] = [from];
  if (to) where.push("start_time < ?"), params.push(to);
  if (q.get("experimentId")) where.push("experiment_id = ?"), params.push(q.get("experimentId")!);
  if (q.get("datasetId")) where.push("experiment_dataset_id = ?"), params.push(q.get("datasetId")!);
  const from_ = `(SELECT experiment_id AS id, MAX(experiment_name) AS name, MAX(experiment_description) AS description,
      MIN(start_time) AS start_time, MAX(COALESCE(end_time, start_time)) AS end_time, COUNT(*) AS item_count,
      MAX(experiment_dataset_id) AS dataset_id, MAX(experiment_metadata) AS metadata
    FROM ${itemRoots()} AND ${where.join(" AND ")} GROUP BY experiment_id)`;
  const { rows, cursor } = page<Record<string, any>>(
    db,
    { from: from_, where: [], params, time: "start_time", id: "id", select: "*, start_time AS __t, id AS __id" },
    q,
    limit,
  );
  const data = rows.map((r) => {
    const e: Record<string, unknown> = {
      id: r.id,
      name: r.name,
      description: r.description ?? "",
      startTime: iso(r.start_time),
      endTime: iso(r.end_time),
      itemCount: r.item_count,
      datasetId: r.dataset_id ?? null,
    };
    if (fields.has("metadata")) e.metadata = parseJson(r.metadata) ?? {};
    if (fields.has("scores")) e.scores = scoresFor(db, "dataset_run_id", r.id);
    return e;
  });
  return { data, meta: cursor ? { cursor } : {} };
}

function listExperimentItems(db: Db, q: URLSearchParams) {
  const from = requireIsoParam(q, "fromStartTime", true)!;
  const to = requireIsoParam(q, "toStartTime", false);
  const fields = fieldsOf(
    q,
    ["core", "dataset", "io", "metadata", "itemMetadata", "experimentMetadata", "scores"],
    ["core", "dataset"],
  );
  const limit = limitOf(q, 50, 1000);
  const where = ["start_time >= ?"];
  const params: Param[] = [from];
  if (to) where.push("start_time < ?"), params.push(to);
  for (const [param, column] of [
    ["experimentId", "experiment_id"],
    ["experimentName", "experiment_name"],
    ["experimentItemId", "experiment_item_id"],
    ["datasetId", "experiment_dataset_id"],
    ["traceId", "trace_id"],
  ])
    if (q.get(param)) where.push(`${column} = ?`), params.push(q.get(param)!);
  const { rows, cursor } = page<EventRow>(
    db,
    { from: `(SELECT * FROM ${itemRoots()} AND ${where.join(" AND ")})`, where: [], params, time: "start_time", id: "id", select: "*, start_time AS __t, id AS __id" },
    q,
    limit,
  );
  const data = rows.map((r) => {
    const item: Record<string, unknown> = {
      id: r.id,
      traceId: r.trace_id,
      startTime: iso(r.start_time),
      endTime: iso(r.end_time),
      level: r.level,
      environment: r.environment,
      experimentId: r.experiment_id,
      experimentName: r.experiment_name,
      experimentItemId: r.experiment_item_id,
    };
    if (fields.has("dataset"))
      Object.assign(item, { experimentDatasetId: r.experiment_dataset_id ?? null, experimentItemVersion: r.experiment_item_version ?? null });
    if (fields.has("io")) Object.assign(item, { input: r.input ?? null, output: r.output ?? null, expectedOutput: r.experiment_item_expected_output ?? null });
    if (fields.has("metadata")) item.metadata = metadataValues(r.metadata);
    if (fields.has("itemMetadata")) item.experimentItemMetadata = parseJson(r.experiment_item_metadata) ?? {};
    if (fields.has("experimentMetadata"))
      Object.assign(item, { experimentMetadata: parseJson(r.experiment_metadata) ?? {}, experimentDescription: r.experiment_description ?? "" });
    if (fields.has("scores")) item.scores = scoresFor(db, "observation_id", r.id);
    return item;
  });
  return { data, meta: cursor ? { cursor } : {} };
}

// ---------------------------------------------------------------- routing

type Handler = (ctx: { db: Db; req: Request; url: URL; params: string[] }) => Promise<Response> | Response;
const routes: [string, RegExp, Handler][] = [];
const route = (method: string, path: string, h: Handler) =>
  routes.push([method, new RegExp("^" + path.replace(/:[a-zA-Z]+/g, "([^/]+)") + "/?$"), h]);

route("GET", "/api/public/health", () => ok({ status: "OK", version: LANGFUSE_VERSION }));
route("GET", "/api/public/ready", () => ok({ status: "OK" }));
route("GET", "/api/public/projects", () =>
  ok({ data: [{ id: PROJECT.id, name: PROJECT.name, organization: { id: PROJECT.id, name: PROJECT.name }, metadata: {} }] }),
);

route("POST", "/api/public/otel/v1/traces", async ({ db, req }) => {
  const contentType = req.headers.get("content-type") ?? "application/x-protobuf";
  const body = decompress(new Uint8Array(await req.arrayBuffer()), req.headers.get("content-encoding"));
  ingestTraceRequest(db, body, contentType, {
    publicKey: publicKeyOf(req),
    sdkName: req.headers.get("x-langfuse-sdk-name") ?? undefined,
    sdkVersion: req.headers.get("x-langfuse-sdk-version") ?? undefined,
  });
  // An empty ExportTraceServiceResponse, in the request's encoding.
  return contentType.includes("json")
    ? ok({})
    : new Response(new Uint8Array(0), { status: 200, headers: { "content-type": "application/x-protobuf" } });
});

route("GET", "/api/public/v2/observations", ({ db, url }) => ok(listObservations(db, url.searchParams)));
route("GET", "/api/public/v3/scores", ({ db, url }) => ok(listScores(db, url.searchParams)));
route("POST", "/api/public/scores", async ({ db, req }) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw invalid("request body must be JSON");
  }
  if (!Array.isArray(body)) return ok(createScore(db, (body ?? {}) as Record<string, any>));
  // Batch, as the SDKs send it: 202 when all are stored, 207 with errors otherwise.
  const errors: { message: string }[] = [];
  db.tx(() => {
    for (const s of body as Record<string, any>[]) {
      try {
        createScore(db, s ?? {});
      } catch (e) {
        errors.push({ message: e instanceof HttpError ? JSON.stringify(e.error) : String(e) });
      }
    }
  });
  if (!errors.length) return ok({ message: "Accepted" }, 202);
  return ok({ accepted: (body as unknown[]).length - errors.length, rejected: errors.length, errors }, 207);
});
route("DELETE", "/api/public/scores/:id", ({ db, params }) => {
  if (!db.run("DELETE FROM scores WHERE id = ?", decodeURIComponent(params[0])).changes) throw notFound("Score");
  return ok({ message: "Score deleted successfully" });
});

route("POST", "/api/public/v2/datasets", async ({ db, req }) => ok(upsertDataset(db, await bodyJson(req))));
route("GET", "/api/public/v2/datasets", ({ db, url }) => ok(listDatasets(db, url.searchParams)));
route("GET", "/api/public/v2/datasets/:name", ({ db, params }) => {
  const ds = datasetByName(db, decodeURIComponent(params[0]));
  if (!ds) throw notFound("Dataset");
  return ok(formatDataset(ds));
});
route("DELETE", "/api/public/v2/datasets/:name", ({ db, params }) => {
  if (!db.run("DELETE FROM datasets WHERE name = ?", decodeURIComponent(params[0])).changes) throw notFound("Dataset");
  return ok({ message: "Dataset deleted successfully" });
});
route("POST", "/api/public/dataset-items", async ({ db, req }) => ok(upsertItem(db, await bodyJson(req))));
route("GET", "/api/public/dataset-items", ({ db, url }) => ok(listItems(db, url.searchParams)));
route("GET", "/api/public/dataset-items/:id", ({ db, params }) => {
  const item = db.get(`${ITEM_SELECT} WHERE i.id = ?`, decodeURIComponent(params[0]));
  if (!item) throw notFound("Dataset item");
  return ok(formatItem(item));
});
route("DELETE", "/api/public/dataset-items/:id", ({ db, params }) => {
  if (!db.run("DELETE FROM dataset_items WHERE id = ?", decodeURIComponent(params[0])).changes) throw notFound("Dataset item");
  return ok({ message: "Dataset item deleted successfully" });
});

route("GET", "/api/public/experiments", ({ db, url }) => ok(listExperiments(db, url.searchParams)));
route("GET", "/api/public/experiment-items", ({ db, url }) => ok(listExperimentItems(db, url.searchParams)));

// langfuse-lite's own endpoints, for the viewer.
route("GET", "/", () => new Response(VIEWER_HTML, { headers: { "content-type": "text/html; charset=utf-8" } }));
route("GET", "/api/lite/traces", ({ db, url }) => ok({ data: listTraces(db, limitOf(url.searchParams, 100, 1000)) }));
route("GET", "/api/lite/traces/:id", ({ db, params }) => {
  const detail = traceDetail(db, decodeURIComponent(params[0]));
  if (!detail) throw notFound("Trace");
  return ok(detail);
});
route("GET", "/api/lite/experiments", ({ db }) => ok({ data: experimentSummaries(db) }));
route("GET", "/api/lite/datasets", ({ db }) => ok({ data: datasetSummaries(db) }));
route("GET", "/api/lite/datasets/:id", ({ db, params }) => {
  const detail = datasetDetail(db, decodeURIComponent(params[0]));
  if (!detail) throw notFound("Dataset");
  return ok(detail);
});
route("GET", "/api/lite/compare", ({ db, url }) => {
  const runs = url.searchParams.getAll("run");
  if (runs.length < 1) throw invalid("pass one or more run=<experiment id or name>");
  return ok(compareRuns(db, runs));
});

function publicKeyOf(req: Request): string | undefined {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Basic ")) return undefined;
  try {
    return atob(auth.slice(6)).split(":")[0];
  } catch {
    return undefined;
  }
}

export async function handle(db: Db, req: Request): Promise<Response> {
  const res = await route_(db, req);
  // Failed requests are logged: an SDK usually swallows them, so this is where they show up.
  if (res.status >= 400) {
    const body = await res.clone().text();
    console.error(`${req.method} ${new URL(req.url).pathname} → ${res.status} ${body.slice(0, 300)}`);
  }
  return res;
}

async function route_(db: Db, req: Request): Promise<Response> {
  const url = new URL(req.url);
  try {
    for (const [method, pattern, h] of routes) {
      if (method !== req.method) continue;
      const m = pattern.exec(url.pathname);
      if (m) return await h({ db, req, url, params: m.slice(1) });
    }
    if (url.pathname.startsWith("/api/public/"))
      return ok(
        {
          message: `langfuse-lite does not implement ${req.method} ${url.pathname}. It serves tracing (OTLP), scores, datasets and experiments; for the rest, push to a full Langfuse.`,
          error: "NotImplemented",
        },
        501,
      );
    return ok({ message: "Not found", error: "NotFound" }, 404);
  } catch (e) {
    if (e instanceof HttpError) return ok({ message: e.message, error: e.error }, e.status);
    const message = e instanceof Error ? e.message : String(e);
    return ok({ message, error: "InternalServerError" }, 500);
  }
}

// ---------------------------------------------------------------- viewer data (also used by export)

export function listTraces(db: Db, limit: number) {
  return db.all<Record<string, any>>("SELECT * FROM traces ORDER BY start_time DESC LIMIT ?", limit);
}

export function traceDetail(db: Db, id: string) {
  const rows = db.all<EventRow>("SELECT * FROM events WHERE trace_id = ? ORDER BY start_time, id", id);
  if (!rows.length) return null;
  const all = new Set(OBSERVATION_FIELDS);
  const scores = db.all<ScoreRow>("SELECT * FROM scores WHERE trace_id = ? ORDER BY timestamp", id);
  return {
    id,
    observations: rows.map((r) => formatObservation(r, all)),
    scores: scores.map((s) => formatScore(s, new Set(["core", "details", "subject"]))),
  };
}

/** Datasets with item counts and the experiment runs made on them. */
export function datasetSummaries(db: Db) {
  const runs = experimentSummaries(db);
  return db
    .all<Record<string, any>>(
      `SELECT d.*, COUNT(i.id) AS items, SUM(CASE WHEN i.status = 'ARCHIVED' THEN 1 ELSE 0 END) AS archived
       FROM datasets d LEFT JOIN dataset_items i ON i.dataset_id = d.id GROUP BY d.id ORDER BY d.created_at DESC`,
    )
    .map((d) => {
      const own = runs.filter((r) => r.dataset_id === d.id);
      return {
        id: d.id,
        name: d.name,
        description: d.description ?? null,
        createdAt: iso(d.created_at),
        items: d.items,
        archived: d.archived ?? 0,
        runs: own.length,
        lastRunAt: own.length ? own[0].start_time : null,
      };
    });
}

/** One dataset: its fields, items (oldest first, as created) and runs (newest first). */
export function datasetDetail(db: Db, id: string) {
  const d = db.get<DatasetRow>("SELECT * FROM datasets WHERE id = ?", id);
  if (!d) return null;
  const items = db.all(`${ITEM_SELECT} WHERE i.dataset_id = ? ORDER BY i.created_at, i.id`, id).map(formatItem);
  const traces = new Set(
    db.all<{ id: string }>(
      `SELECT DISTINCT trace_id AS id FROM events WHERE trace_id IN (SELECT source_trace_id FROM dataset_items WHERE dataset_id = ?)`,
      id,
    ).map((r) => r.id),
  );
  const runItems = db.all<{ item: string; n: number }>(
    `SELECT experiment_item_id AS item, COUNT(DISTINCT experiment_id) AS n FROM ${itemRoots()} AND e.experiment_dataset_id = ? GROUP BY 1`,
    id,
  );
  const runsPerItem = new Map(runItems.map((r) => [r.item, r.n]));
  return {
    ...formatDataset(d),
    items: items.map((i) => ({
      ...i,
      runCount: runsPerItem.get(i.id) ?? 0,
      // Only link a source trace that is in this database.
      sourceTraceAvailable: Boolean(i.sourceTraceId && traces.has(i.sourceTraceId)),
    })),
    runs: experimentSummaries(db).filter((r) => r.dataset_id === id),
  };
}

/** The viewer with its data embedded: one HTML file that works without a server. */
export function exportViewer(db: Db, limit: number): { html: string; traces: number; runs: number } {
  const traces = listTraces(db, limit);
  const experiments = experimentSummaries(db);
  // Traces of the exported runs are included even when older than the newest `limit`.
  const runTraceIds = experiments.length
    ? db.all<{ trace_id: string }>(
        `SELECT DISTINCT trace_id FROM events WHERE experiment_id IN (${experiments.map(() => "?").join(",")})`,
        ...experiments.map((e) => e.id),
      ).map((r) => r.trace_id)
    : [];
  const details: Record<string, unknown> = {};
  for (const id of new Set([...traces.map((t) => t.id), ...runTraceIds])) details[id] = traceDetail(db, id);
  const datasets = datasetSummaries(db);
  const datasetDetails: Record<string, unknown> = {};
  for (const d of datasets) datasetDetails[d.id] = datasetDetail(db, d.id);
  const data = {
    exportedAt: new Date().toISOString(),
    traces,
    details,
    experiments,
    datasets,
    datasetDetails,
    compare: experiments.length ? compareRuns(db, experiments.map((e) => e.id)) : { runs: [], items: [] },
  };
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const html = VIEWER_HTML.replace("<script>", `<script>window.__LITE_DATA__ = ${json};</script>\n<script>`);
  return { html, traces: Object.keys(details).length, runs: experiments.length };
}

// ---------------------------------------------------------------- run summaries (CLI, viewer)

export function experimentSummaries(db: Db) {
  return db
    .all<Record<string, any>>(
      `SELECT x.*, d.name AS dataset_name,
         (SELECT SUM(COALESCE(total_cost, 0)) FROM events c WHERE c.experiment_id = x.id) AS total_cost
       FROM (
         SELECT r.experiment_id AS id, MAX(r.experiment_name) AS name, MAX(r.experiment_dataset_id) AS dataset_id,
           MIN(r.start_time) AS start_time, COUNT(*) AS items,
           SUM(CASE WHEN r.level = 'ERROR' THEN 1 ELSE 0 END) AS errors,
           AVG((julianday(COALESCE(r.end_time, r.start_time)) - julianday(r.start_time)) * 86400) AS avg_latency
         FROM ${itemRoots("r")}
         GROUP BY r.experiment_id
       ) x LEFT JOIN datasets d ON d.id = x.dataset_id
       ORDER BY x.start_time DESC`,
    )
    .map((r): Record<string, any> => ({ ...r, scores: runScoreAverages(db, r.id) }));
}

/** Average of each numeric score over a run's items, plus run-level scores. */
function runScoreAverages(db: Db, experimentId: string) {
  const out: Record<string, number | string> = {};
  for (const s of db.all<{ name: string; avg: number | null; n: number }>(
    `SELECT s.name, AVG(s.value) AS avg, COUNT(*) AS n FROM scores s
     JOIN events e ON e.id = s.observation_id WHERE e.experiment_id = ? AND s.value IS NOT NULL GROUP BY s.name`,
    experimentId,
  ))
    if (s.avg != null) out[s.name] = s.avg;
  for (const s of db.all<ScoreRow>("SELECT * FROM scores WHERE dataset_run_id = ?", experimentId))
    out[s.name] = scoreValue(s);
  return out;
}

export function resolveRun(db: Db, ref: string): string {
  const exact = db.get<{ id: string }>("SELECT experiment_id AS id FROM events WHERE experiment_id = ? LIMIT 1", ref);
  if (exact) return exact.id;
  const byName = db.all<{ id: string }>(
    `SELECT experiment_id AS id, MIN(start_time) AS t FROM events WHERE experiment_name = ? OR experiment_name LIKE ? || ' - %'
     GROUP BY experiment_id ORDER BY t DESC`,
    ref,
    ref,
  );
  if (!byName.length) throw notFound(`Experiment run "${ref}"`);
  return byName[0].id;
}

/** Per item: each run's output, scores, latency and cost, side by side. */
export function compareRuns(db: Db, refs: string[]) {
  const runIds = refs.map((r) => resolveRun(db, r));
  const items = new Map<string, Record<string, any>>();
  const runs = runIds.map((id) => {
    const rows = db.all<EventRow>(
      `SELECT r.*, (SELECT SUM(COALESCE(total_cost, 0)) FROM events c WHERE c.trace_id = r.trace_id) AS trace_cost
       FROM ${itemRoots("r")}
         AND r.experiment_id = ?`,
      id,
    );
    for (const r of rows) {
      const key = r.experiment_item_id;
      const item = items.get(key) ?? { itemId: key, input: r.input, expectedOutput: r.experiment_item_expected_output, runs: {} };
      const scores: Record<string, unknown> = {};
      for (const s of db.all<ScoreRow>("SELECT * FROM scores WHERE observation_id = ? OR (trace_id = ? AND observation_id IS NULL)", r.id, r.trace_id))
        scores[s.name] = scoreValue(s);
      item.runs[id] = {
        traceId: r.trace_id,
        output: r.output,
        level: r.level,
        latency: seconds(r.start_time, r.end_time),
        cost: r.trace_cost,
        scores,
      };
      items.set(key, item);
    }
    const name = rows[0]?.experiment_name ?? id;
    return { id, name, summary: runScoreAverages(db, id) };
  });
  return { runs, items: [...items.values()] };
}
