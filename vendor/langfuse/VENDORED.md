# Vendored from Langfuse

Compiled files from `@langfuse/shared` (packages/shared, MIT license) and the
worker's `default-model-prices.json`, taken from `docker.langfuse.com/langfuse/langfuse-worker:4`
(Langfuse 4.83.0) by `scripts/vendor-langfuse.sh`. Do not edit by hand:
re-run the script for a new Langfuse version.

Files under `src/` are unchanged, except the entry points listed in
`../shims/`, which replace Langfuse's versions so that nothing pulls in
Redis, ClickHouse, S3, env parsing or logging.

Langfuse: https://github.com/langfuse/langfuse. None of the vendored files are
under an `ee/` folder, so all are MIT-licensed; the license text is in
`../LICENSE-langfuse` (the image does not contain it).
