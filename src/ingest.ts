// OTLP request → Langfuse observations → SQLite rows. Mirrors the Langfuse worker:
// OtelIngestionProcessor.processToEvent, then IngestionService.createEventRecord
// (without prompt lookup, skill references and AI-gateway attribution).

import { gunzipSync, inflateSync } from "node:zlib";
import type { Db } from "./db";
import { flattenJsonToPathArrays, processSpans, usageAndCost, type LangfuseEvent } from "./langfuse";
import { decodeTraceRequestJson, decodeTraceRequestProto, type ResourceSpans } from "./otlp";

const now = () => new Date().toISOString();
const json = (v: unknown) => JSON.stringify(v ?? null);
const stringify = (v: unknown) => (v == null ? null : typeof v === "string" ? v : JSON.stringify(v));

/** Throws ERR_BUFFER_TOO_LARGE when the decompressed body would exceed maxBytes. */
export function decompress(body: Uint8Array, encoding: string | null, maxBytes?: number): Uint8Array {
  if (!encoding || encoding === "identity") return body;
  const limit = maxBytes ? { maxOutputLength: maxBytes } : {};
  if (encoding === "gzip") return gunzipSync(body, limit);
  if (encoding === "deflate") return inflateSync(body, limit);
  throw new Error(`unsupported content-encoding ${encoding}`);
}

export function decodeTraceRequest(body: Uint8Array, contentType: string): ResourceSpans[] {
  return contentType.includes("json")
    ? decodeTraceRequestJson(new TextDecoder().decode(body))
    : decodeTraceRequestProto(body);
}

export type SdkHeaders = { publicKey?: string; sdkName?: string; sdkVersion?: string };

/** Stores one OTLP request and its spans; returns the number of observations written. */
export function ingestTraceRequest(
  db: Db,
  body: Uint8Array,
  contentType: string,
  headers: SdkHeaders,
  resourceSpans: ResourceSpans[] = decodeTraceRequest(body, contentType),
): number {
  const observations = processSpans(resourceSpans, headers);
  return db.tx(() => {
    db.run(
      "INSERT INTO otlp_requests (received_at, content_type, headers, body, span_count) VALUES (?, ?, ?, ?, ?)",
      now(),
      contentType.includes("json") ? "application/json" : "application/x-protobuf",
      json(headers),
      body,
      observations.length,
    );
    const requestId = (db.get<{ id: number }>("SELECT last_insert_rowid() AS id") as { id: number }).id;
    for (const o of observations) writeObservation(db, o, requestId);
    return observations.length;
  });
}

const parseModelParameters = (value: unknown) => {
  if (!value) return {};
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const flatObject = (value: unknown) => {
  const { names, values } = flattenJsonToPathArrays(value ?? {});
  return Object.fromEntries(names.map((n, i) => [n, values[i] ?? ""]));
};
const pairsToObject = (names: unknown, values: unknown) =>
  Array.isArray(names) && Array.isArray(values) ? Object.fromEntries(names.map((n, i) => [n, values[i] ?? ""])) : {};

const COLUMNS = [
  "id", "trace_id", "parent_observation_id", "name", "type", "environment", "version", "release", "tags", "public",
  "is_app_root", "trace_name", "user_id", "session_id", "level", "status_message", "start_time", "end_time",
  "completion_start_time", "prompt_name", "prompt_version", "internal_model_id", "model", "model_parameters",
  "provided_usage_details", "usage_details", "provided_cost_details", "cost_details", "total_cost",
  "usage_pricing_tier_id", "usage_pricing_tier_name", "tool_definitions", "tool_calls", "tool_call_names", "input",
  "output", "metadata", "source", "ingestion_sdk_name", "ingestion_sdk_version", "service_name", "service_version",
  "scope_name", "scope_version", "telemetry_sdk_language", "telemetry_sdk_name", "telemetry_sdk_version",
  "experiment_id", "experiment_name", "experiment_metadata", "experiment_description", "experiment_dataset_id",
  "experiment_item_id", "experiment_item_version", "experiment_item_root_observation_id",
  "experiment_item_expected_output", "experiment_item_metadata", "otlp_request_id", "created_at", "updated_at",
] as const;
const UPSERT = `INSERT INTO observations (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})
  ON CONFLICT(id) DO UPDATE SET ${COLUMNS.filter((c) => c !== "id" && c !== "created_at")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ")}`;

function writeObservation(db: Db, e: LangfuseEvent, requestId: number) {
  const ev = e as Record<string, any>;
  const modelParameters = parseModelParameters(ev.modelParameters);
  const metadata = ev.metadata ?? {};
  const providedUsage = ev.providedUsageDetails ?? {};
  const providedCost = ev.providedCostDetails ?? {};
  const enrich =
    Boolean(ev.modelName) || Object.keys(providedUsage).length > 0 || Object.keys(providedCost).length > 0;
  const usage = enrich
    ? usageAndCost({
        modelName: ev.modelName,
        providedUsageDetails: providedUsage,
        providedCostDetails: providedCost,
        modelParameters,
        metadata,
      })
    : null;
  const t = now();
  const row: Record<(typeof COLUMNS)[number], string | number | null> = {
    id: e.spanId,
    trace_id: e.traceId,
    parent_observation_id: e.parentSpanId ?? null,
    name: ev.name ?? "",
    type: ev.type ?? "SPAN",
    environment: ev.environment ?? "default",
    version: ev.version ?? null,
    release: ev.release ?? null,
    tags: json(ev.tags ?? []),
    public: ev.public ? 1 : 0,
    is_app_root: ev.isAppRoot ? 1 : 0,
    trace_name: ev.traceName ?? null,
    user_id: ev.userId ?? null,
    session_id: ev.sessionId ?? null,
    level: ev.level ?? "DEFAULT",
    status_message: ev.statusMessage ?? null,
    start_time: e.startTimeISO,
    end_time: e.endTimeISO ?? null,
    completion_start_time: ev.completionStartTime ?? null,
    prompt_name: ev.promptName ?? null,
    prompt_version: ev.promptVersion == null ? null : Number(ev.promptVersion) || null,
    internal_model_id: usage?.internal_model_id ?? null,
    model: ev.modelName ?? null,
    model_parameters: json(modelParameters),
    provided_usage_details: json(providedUsage),
    usage_details: json(usage?.usage_details ?? ev.usageDetails ?? {}),
    provided_cost_details: json(providedCost),
    cost_details: json(usage?.cost_details ?? ev.costDetails ?? {}),
    total_cost: usage?.total_cost ?? null,
    usage_pricing_tier_id: usage?.usage_pricing_tier_id ?? null,
    usage_pricing_tier_name: usage?.usage_pricing_tier_name ?? null,
    tool_definitions: json(ev.toolDefinitions ?? {}),
    tool_calls: json(ev.toolCalls ?? []),
    tool_call_names: json(ev.toolCallNames ?? []),
    input: stringify(ev.input),
    output: stringify(ev.output),
    metadata: json(flatObject(metadata)),
    source: ev.source ?? "otel",
    ingestion_sdk_name: ev.ingestionSdkName ?? null,
    ingestion_sdk_version: ev.ingestionSdkVersion ?? null,
    service_name: ev.serviceName ?? null,
    service_version: ev.serviceVersion ?? null,
    scope_name: ev.scopeName ?? null,
    scope_version: ev.scopeVersion ?? null,
    telemetry_sdk_language: ev.telemetrySdkLanguage ?? null,
    telemetry_sdk_name: ev.telemetrySdkName ?? null,
    telemetry_sdk_version: ev.telemetrySdkVersion ?? null,
    experiment_id: ev.experimentId ?? null,
    experiment_name: ev.experimentName ?? null,
    experiment_metadata: json(pairsToObject(ev.experimentMetadataNames, ev.experimentMetadataValues)),
    experiment_description: ev.experimentDescription ?? null,
    experiment_dataset_id: ev.experimentDatasetId ?? null,
    experiment_item_id: ev.experimentItemId ?? null,
    experiment_item_version: ev.experimentItemVersion == null ? null : String(ev.experimentItemVersion),
    experiment_item_root_observation_id: ev.experimentItemRootSpanId ?? null,
    experiment_item_expected_output: ev.experimentItemExpectedOutput ?? null,
    experiment_item_metadata: json(pairsToObject(ev.experimentItemMetadataNames, ev.experimentItemMetadataValues)),
    otlp_request_id: requestId,
    created_at: t,
    updated_at: t,
  };
  db.run(UPSERT, ...COLUMNS.map((c) => row[c]));
}
