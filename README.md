# langfuse-lite

A lightweight local Langfuse: the official, unchanged Langfuse web and worker
images, running against small local stand-ins for the four stores they need.

| Langfuse expects | Stand-in | Speaks |
|---|---|---|
| Postgres | [PGlite](https://pglite.dev) (Postgres in WebAssembly) behind `pglite-socket` | the Postgres wire protocol, on 5432 |
| ClickHouse | [chDB](https://github.com/chdb-io/chdb) (embedded ClickHouse) behind `shims/clickhouse.py` | ClickHouse's HTTP interface, on 8123 |
| Redis | a real `redis-server` | Redis, on 6379 |
| S3 | [moto](https://github.com/getmoto/moto)'s S3 server | the S3 API, on 9090 |

No Langfuse code is changed or forked. Upgrading means pulling a newer image
and re-running `scripts/setup.sh`, which copies that image's own migrations.

**Status: step 1 spike.** One trace goes in over OTLP and comes back out of the
public API. It is not a supported Langfuse distribution.

## Run

```bash
scripts/setup.sh            # once: shim dependencies, images, migrations from the image
scripts/start.sh --fresh    # start everything on an empty data folder
python3 scripts/smoke.py    # trace round trip + API probes
scripts/stop.sh
```

Then use the API with `pk-lf-lite` / `sk-lf-lite`, or open http://localhost:3000
(user `lite@example.com`, password `lite-password`; the UI is untested). Settings are in `langfuse-lite.env`.

## Spike results (Langfuse 4.83.0, `langfuse:4` images)

Measured in a 4-core, 15 GB Linux VM.

| | Result |
|---|---|
| Cold start, empty data folder | 15 s to a healthy web; includes 491 Postgres and 56 ClickHouse migrations (3 s and 1.7 s) |
| Trace sent over OTLP → readable from `/api/public/v2/observations` | 1.2 s, with input, output, user, token usage and computed cost |
| Other APIs probed | create/get prompt by label, create dataset, create score + list via v3 scores, metrics v2 count, MCP `initialize` + `tools/call listPrompts`: all pass |
| Memory | about 2.7 GB: web 1.3 GB, worker 0.6 GB, PGlite 0.4 GB, chDB 0.3 GB, moto 64 MB, Redis 15 MB |
| Disk | chDB 541 MB, PGlite + socket 29 MB, Langfuse images 1.06 GB (web) + 821MB (worker) |

For comparison, Langfuse's Docker Compose guide recommends a 4-core / 16 GB VM
and 2–3 minutes until web is ready; that stack was not run for this comparison.

## What it took

- **Postgres:** PGlite rejects `CREATE INDEX CONCURRENTLY` (it has one
  connection). `shims/postgres.mjs` strips the keyword when applying migrations;
  that is safe on a single-user database. `pglite-socket` multiplexes many client
  connections over PGlite's one, and holds other connections back while one is
  inside a transaction: correct, but a long transaction pauses all other queries.
- **ClickHouse:** Langfuse sends parameterized queries as `multipart/form-data`
  bodies, settings as URL parameters, and inserts as `?query=INSERT … FORMAT X`
  with rows in the body. `shims/clickhouse.py` handles those, gzip, `/ping` and
  ClickHouse-style errors. chDB runs one query at a time, so the shim serializes
  requests. Langfuse runs ClickHouse migrations with golang-migrate over the
  native protocol, which the shim does not speak, so the shim applies the image's
  `unclustered` migrations itself.
- **Langfuse settings:** both automatic migrations are switched off
  (`LANGFUSE_AUTO_*_MIGRATION_DISABLED`), and `LANGFUSE_MCP_ALLOWED_HOSTS` must
  list the host names clients use, or MCP answers 403.

## Known gaps

- Only the paths above are tested. The UI, background jobs, evaluations, exports
  and media uploads are untested.
- `system.query_log` does not exist in chDB, so the hourly worker job that scans
  it (legacy API usage reporting) will fail. It does not affect ingestion.
- Web and worker still run as Docker containers. A single binary is a later step.
- Everything binds to `127.0.0.1` and uses fixed demo secrets. Local use only.
