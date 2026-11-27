// Where langfuse-lite stops being the right tool, and what to say when it gets there.
// It runs one request at a time on one SQLite file: fine for local development,
// experiments and agent runs (measured: about 6,000 spans/s, 350,000 observations
// with fast reads), not for production traffic.

export const SCALE_HINT =
  "langfuse-lite is built for local development and experiments. For higher volume and performance, " +
  "use Langfuse Cloud (https://cloud.langfuse.com) or self-host Langfuse (https://langfuse.com/self-hosting); " +
  "`langfuse-lite push --to <url>` copies your data over.";

/** Appended to the warning when `serve` listens beyond this machine. */
export const SHARE_HINT =
  "To share with a team, use Langfuse Cloud (https://cloud.langfuse.com) or self-host Langfuse (https://langfuse.com/self-hosting), " +
  "which have authentication and access control; `langfuse-lite push --to <url>` moves your data.";

export const MAX_BODY_BYTES = 64 * 1024 * 1024;
export const SLOW_REQUEST_MS = 2000;
export const LARGE_DB_OBSERVATIONS = 1_000_000;
export const LARGE_DB_BYTES = 2 * 1024 * 1024 * 1024;
// Well below the limits above: lite still works fine here, but a project this size is past
// "local experiment", so `serve` and the viewer mention the move once, without a warning.
export const GROWING_DB_OBSERVATIONS = 100_000;
export const GROWING_DB_BYTES = 250 * 1024 * 1024;

export type DbSize = { level: "ok" | "growing" | "large"; note: string | null };

/** Where a database of this size stands, and the one line to say about it (null while it is small). */
export function dbSize(observations: number, bytes: number): DbSize {
  const size = `${observations.toLocaleString("en")} observations, ${bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`}`;
  if (observations > LARGE_DB_OBSERVATIONS || bytes > LARGE_DB_BYTES)
    return { level: "large", note: `This database holds ${size}. ${SCALE_HINT}` };
  if (observations > GROWING_DB_OBSERVATIONS || bytes > GROWING_DB_BYTES)
    return {
      level: "growing",
      note: `This project is growing (${size}). Langfuse Cloud (https://cloud.langfuse.com) or a self-hosted Langfuse ` +
        "(https://langfuse.com/self-hosting) gives you better performance, security and features; " +
        "`langfuse-lite push --to <url>` copies your data over.",
    };
  return { level: "ok", note: null };
}

// What the unimplemented parts of the Langfuse public API are called, keyed by the first
// path segment after /api/public/ (and an optional version), so a 501 can name the feature
// the caller wanted instead of only the path. `docs` is set only for pages known to exist.
const DOCS = "https://langfuse.com/docs";
const FEATURES: Record<string, { name: string; docs?: string; local?: string }> = {
  prompts: { name: "Prompt Management", docs: `${DOCS}/prompt-management/overview` },
  metrics: {
    name: "The Metrics API",
    docs: `${DOCS}/metrics/features/metrics-api`,
    local: "Locally, aggregate with `langfuse-lite sql`.",
  },
  "annotation-queues": { name: "Annotation Queues", docs: `${DOCS}/evaluation/evaluation-methods/annotation-queues` },
  comments: { name: "Comments", docs: `${DOCS}/observability/features/comments` },
  media: { name: "Media (multi-modal attachments)", docs: `${DOCS}/observability/features/multi-modality` },
  models: {
    name: "Custom model definitions and prices",
    docs: `${DOCS}/observability/features/token-and-cost-tracking`,
    local: "langfuse-lite computes cost with Langfuse's default model prices.",
  },
  "score-configs": { name: "Score configuration" },
  sessions: {
    name: "Sessions",
    docs: `${DOCS}/observability/features/sessions`,
    local: "Locally, session ids are fields on observations: GET /api/public/v2/observations?sessionId=<id>.",
  },
};
// The pre-v4 endpoints exist in a full Langfuse too, but what the caller needs here is the v4 route.
const LEGACY: Record<string, string> = {
  ingestion: "the legacy ingestion API",
  traces: "the legacy traces API",
};

/** The message of a 501: which Langfuse feature was asked for and where it exists. */
export function notImplementedMessage(method: string, pathname: string) {
  const head = `langfuse-lite does not implement ${method} ${pathname}`;
  const segment = pathname.replace(/^\/api\/public\/(v\d+\/)?/, "").split("/")[0];
  if (LEGACY[segment])
    return `${head}, ${LEGACY[segment]}. Like Langfuse v4 it stores observations only: send spans to POST /api/public/otel/v1/traces ` +
      "(the current Langfuse SDKs do) and read them with GET /api/public/v2/observations.";
  const feature = FEATURES[segment];
  if (!feature)
    return `${head}. It serves tracing (OTLP), scores, datasets and experiments; for the rest, push to a full Langfuse.`;
  return `${head}. ${feature.name} is part of Langfuse Cloud (https://cloud.langfuse.com) and self-hosted Langfuse, not of langfuse-lite ` +
    `(${feature.docs ?? DOCS}).${feature.local ? ` ${feature.local}` : ""} langfuse-lite serves tracing (OTLP), scores, datasets and experiments; ` +
    "for the rest, push to a full Langfuse with `langfuse-lite push --to <url>`.";
}

let lastSlowWarning = 0;

/** Logs a slow request once every few minutes, with the hint. */
export function noteRequestTime(method: string, path: string, ms: number) {
  if (ms < SLOW_REQUEST_MS || Date.now() - lastSlowWarning < 5 * 60_000) return;
  lastSlowWarning = Date.now();
  console.error(`warning: ${method} ${path} took ${(ms / 1000).toFixed(1)} s; requests are queuing. ${SCALE_HINT}`);
}

export function isBusy(e: unknown) {
  const text = e instanceof Error ? `${e.message} ${(e as { code?: string }).code ?? ""}` : String(e);
  return /database is locked|SQLITE_BUSY/i.test(text);
}
