// Where langfuse-lite stops being the right tool, and what to say when it gets there.
// It runs one request at a time on one SQLite file: fine for local development,
// experiments and agent runs (measured: about 6,000 spans/s, 350,000 observations
// with fast reads), not for production traffic.

export const SCALE_HINT =
  "langfuse-lite is built for local development and experiments. For higher volume and performance, " +
  "use Langfuse Cloud (https://cloud.langfuse.com) or self-host Langfuse (https://langfuse.com/self-hosting); " +
  "`langfuse-lite push --to <url>` copies your data over.";

export const MAX_BODY_BYTES = 64 * 1024 * 1024;
export const SLOW_REQUEST_MS = 2000;
export const LARGE_DB_OBSERVATIONS = 1_000_000;
export const LARGE_DB_BYTES = 2 * 1024 * 1024 * 1024;

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
