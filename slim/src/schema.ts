// The SQLite schema. `events` follows Langfuse v4's events table (one row per
// observation, trace-level fields on every row, experiment fields inline);
// column names match Langfuse's ClickHouse columns so queries read the same.
// JSON columns hold JSON text. Times are ISO 8601 UTC strings.

import type { Db } from "./db";

export const SCHEMA_VERSION = 1;

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

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,            -- span id
  trace_id TEXT NOT NULL,
  parent_span_id TEXT,
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
  model_id TEXT,                  -- matched model in Langfuse's default prices
  provided_model_name TEXT,
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
  experiment_item_root_span_id TEXT,
  experiment_item_expected_output TEXT,
  experiment_item_metadata TEXT NOT NULL,
  otlp_request_id INTEGER REFERENCES otlp_requests(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_trace ON events (trace_id, start_time);
CREATE INDEX IF NOT EXISTS events_start ON events (start_time);
CREATE INDEX IF NOT EXISTS events_session ON events (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_experiment ON events (experiment_id, experiment_item_id) WHERE experiment_id IS NOT NULL;

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

-- One row per trace, for listing: trace-level fields come from whichever span set them.
CREATE VIEW IF NOT EXISTS traces AS
SELECT
  trace_id AS id,
  COALESCE(MAX(trace_name), MAX(CASE WHEN parent_span_id IS NULL THEN name END)) AS name,
  MAX(user_id) AS user_id,
  MAX(session_id) AS session_id,
  MAX(environment) AS environment,
  MIN(start_time) AS start_time,
  MAX(COALESCE(end_time, start_time)) AS end_time,
  COUNT(*) AS observation_count,
  SUM(CASE WHEN level = 'ERROR' THEN 1 ELSE 0 END) AS error_count,
  SUM(COALESCE(total_cost, 0)) AS total_cost,
  SUM(COALESCE(json_extract(usage_details, '$.total'), 0)) AS total_tokens,
  MAX(experiment_id) AS experiment_id
FROM events
GROUP BY trace_id;
`;

export function migrate(db: Db) {
  db.exec(DDL);
  db.run("INSERT OR REPLACE INTO lite_meta (key, value) VALUES ('schema_version', ?)", String(SCHEMA_VERSION));
}
