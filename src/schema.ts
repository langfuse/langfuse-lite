// The SQLite schema, on Langfuse v4's data model: `observations` holds one row
// per observation. Observations that belong together share a trace_id; trace-level
// attributes (trace_name, user_id, session_id, tags) sit on the observations that
// set them. Experiment fields are inline. Column names follow Langfuse's
// observation fields in snake_case. JSON columns hold JSON text; times are ISO 8601 UTC.

import type { Db } from "./db";

export const SCHEMA_VERSION = 2;

// Columns computed from others, for plain SQL: SUM(input_usage), AVG(latency_ms).
const DERIVED: [string, string, string][] = [
  ["input_usage", "INTEGER", "json_extract(usage_details, '$.input')"],
  ["output_usage", "INTEGER", "json_extract(usage_details, '$.output')"],
  ["total_usage", "INTEGER", "json_extract(usage_details, '$.total')"],
  ["input_cost", "REAL", "json_extract(cost_details, '$.input')"],
  ["output_cost", "REAL", "json_extract(cost_details, '$.output')"],
  ["latency_ms", "REAL", "ROUND((julianday(end_time) - julianday(start_time)) * 86400000)"],
];

const DDL = `
CREATE TABLE IF NOT EXISTS lite_meta (key TEXT PRIMARY KEY, value TEXT);

-- Every OTLP request exactly as received, so nothing is lost if the conversion
-- below misses something, and so push can replay it into a real Langfuse.
CREATE TABLE IF NOT EXISTS otlp_requests (
  id INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL,
  content_type TEXT NOT NULL,
  headers TEXT NOT NULL,          -- JSON: Langfuse SDK headers
  body BLOB NOT NULL,             -- decompressed request body
  span_count INTEGER NOT NULL,
  pushed_at TEXT
);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,            -- the OTel span id
  trace_id TEXT NOT NULL,         -- groups the observations of one run
  parent_observation_id TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,             -- SPAN, GENERATION, EVENT, AGENT, TOOL, CHAIN, RETRIEVER, EVALUATOR, EMBEDDING, GUARDRAIL
  environment TEXT NOT NULL,
  version TEXT,
  release TEXT,
  tags TEXT NOT NULL,             -- JSON array
  public INTEGER NOT NULL,
  is_app_root INTEGER NOT NULL,
  trace_name TEXT,
  user_id TEXT,
  session_id TEXT,
  level TEXT NOT NULL,            -- DEBUG, DEFAULT, WARNING, ERROR
  status_message TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT,
  completion_start_time TEXT,
  prompt_name TEXT,
  prompt_version INTEGER,
  internal_model_id TEXT,         -- matched model in Langfuse's default prices
  model TEXT,                     -- the model name the instrumentation reported
  model_parameters TEXT NOT NULL, -- JSON object
  provided_usage_details TEXT NOT NULL,
  usage_details TEXT NOT NULL,    -- JSON {usageType: units}, with total
  provided_cost_details TEXT NOT NULL,
  cost_details TEXT NOT NULL,     -- JSON {usageType: USD}, with total
  total_cost REAL,
  usage_pricing_tier_id TEXT,
  usage_pricing_tier_name TEXT,
  tool_definitions TEXT NOT NULL,
  tool_calls TEXT NOT NULL,
  tool_call_names TEXT NOT NULL,
  input TEXT,
  output TEXT,
  metadata TEXT NOT NULL,         -- JSON object of flattened path -> string value
  source TEXT,
  ingestion_sdk_name TEXT,
  ingestion_sdk_version TEXT,
  service_name TEXT,
  service_version TEXT,
  scope_name TEXT,
  scope_version TEXT,
  telemetry_sdk_language TEXT,
  telemetry_sdk_name TEXT,
  telemetry_sdk_version TEXT,
  experiment_id TEXT,
  experiment_name TEXT,
  experiment_metadata TEXT NOT NULL,
  experiment_description TEXT,
  experiment_dataset_id TEXT,
  experiment_item_id TEXT,
  experiment_item_version TEXT,
  experiment_item_root_observation_id TEXT,
  experiment_item_expected_output TEXT,
  experiment_item_metadata TEXT NOT NULL,
  otlp_request_id INTEGER REFERENCES otlp_requests(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ${DERIVED.map(([name, type, expr]) => `${name} ${type} GENERATED ALWAYS AS (${expr}) VIRTUAL`).join(",\n  ")}
);
CREATE INDEX IF NOT EXISTS observations_trace ON observations (trace_id, start_time);
CREATE INDEX IF NOT EXISTS observations_start ON observations (start_time);
CREATE INDEX IF NOT EXISTS observations_session ON observations (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS observations_experiment ON observations (experiment_id, experiment_item_id) WHERE experiment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS scores (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  value REAL,
  string_value TEXT,
  data_type TEXT NOT NULL,        -- NUMERIC, CATEGORICAL, BOOLEAN, CORRECTION, TEXT
  source TEXT NOT NULL,
  trace_id TEXT,
  observation_id TEXT,
  session_id TEXT,
  dataset_run_id TEXT,            -- experiment id for run-level scores
  comment TEXT,
  metadata TEXT NOT NULL,
  config_id TEXT,
  queue_id TEXT,
  author_user_id TEXT,
  environment TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scores_trace ON scores (trace_id);
CREATE INDEX IF NOT EXISTS scores_run ON scores (dataset_run_id) WHERE dataset_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  metadata TEXT,
  input_schema TEXT,
  expected_output_schema TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dataset_items (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  input TEXT,
  expected_output TEXT,
  metadata TEXT,
  source_trace_id TEXT,
  source_observation_id TEXT,
  status TEXT NOT NULL,           -- ACTIVE, ARCHIVED
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS dataset_items_dataset ON dataset_items (dataset_id, created_at);
`;

/** Schema 1 (builds before the rename) stored observations as `events`, with a
 * `traces` and an `observations` view on top. Renames in place. */
function migrateFromV1(db: Db) {
  for (const v of db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'view' AND name IN ('traces', 'observations')",
  ))
    db.exec(`DROP VIEW ${v.name}`);
  const hasEvents = db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'");
  const hasObservations = db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'observations'");
  if (!hasEvents || hasObservations) return;
  db.tx(() => {
    db.exec(`ALTER TABLE events RENAME TO observations;
      ALTER TABLE observations RENAME COLUMN parent_span_id TO parent_observation_id;
      ALTER TABLE observations RENAME COLUMN provided_model_name TO model;
      ALTER TABLE observations RENAME COLUMN model_id TO internal_model_id;
      ALTER TABLE observations RENAME COLUMN experiment_item_root_span_id TO experiment_item_root_observation_id;
      DROP INDEX IF EXISTS events_trace; DROP INDEX IF EXISTS events_start;
      DROP INDEX IF EXISTS events_session; DROP INDEX IF EXISTS events_experiment;`);
    for (const [name, type, expr] of DERIVED)
      db.exec(`ALTER TABLE observations ADD COLUMN ${name} ${type} GENERATED ALWAYS AS (${expr}) VIRTUAL`);
  });
}

export function migrate(db: Db) {
  migrateFromV1(db);
  db.exec(DDL);
  db.run("INSERT OR REPLACE INTO lite_meta (key, value) VALUES ('schema_version', ?)", String(SCHEMA_VERSION));
}
