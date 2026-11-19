# langfuse-lite

A lightweight local Langfuse with only the base features: tracing, sessions,
scores, prompts, datasets, metrics, dashboards and MCP. It runs the official,
unchanged Langfuse web and worker images against small local stand-ins for the
four stores they need.

| Langfuse expects | Stand-in | Speaks |
|---|---|---|
| Postgres | [PGlite](https://pglite.dev) (Postgres in WebAssembly) behind `shims/postgres.mjs` | the Postgres wire protocol, on 5432 |
| ClickHouse | [chDB](https://github.com/chdb-io/chdb) (embedded ClickHouse) behind `shims/clickhouse.py` | ClickHouse's HTTP interface, on 8123 |
| Redis | a real `redis-server` | Redis, on 6379 |
| S3 | [moto](https://github.com/getmoto/moto)'s S3 server | the S3 API, on 9090 |

No Langfuse code is changed or forked. Upgrading means pulling a newer image
and re-running `scripts/setup.sh`, which copies that image's own migrations.

**Status: prototype, step 2.** The base public API and MCP work for everything
the agent-testing usage suite does. It is not a supported Langfuse distribution.

## Run

```bash
scripts/setup.sh            # once: shim dependencies, images, migrations from the image
scripts/start.sh --fresh    # start everything on an empty data folder
python3 scripts/smoke.py    # trace round trip + API probes
scripts/stop.sh
```

Then use the API with `pk-lf-lite` / `sk-lf-lite`, or open http://localhost:3000
(user `lite@example.com`, password `lite-password`; the UI is untested).
Settings are in `langfuse-lite.env`; `worker.env` switches the worker to base features.

To check it against the agent-testing usage suite (no agents involved):

```bash
python scripts/check_usage_suite.py --agent-testing ../coding-agent-testing
```

## Results (Langfuse 4.83.0, `langfuse:4` images)

Measured in a 4-core, 15 GB Linux VM.

| | Result |
|---|---|
| Cold start, empty data folder | about 15 s to a healthy web, including 491 Postgres and 56 ClickHouse migrations |
| One trace sent over OTLP → readable from `/api/public/v2/observations` | 1–2.5 s, with input, output, user, token usage and computed cost |
| Usage-suite fixture (`support-desk-v1`) seeded and queryable | 34 s for 697 observations and 135 scores (Langfuse Cloud: 1–3 minutes) |
| `check_usage_suite.py` | 17/17: all 7 read tasks give the fixture's known answers, all 4 write tasks pass the suite's state checks with no collateral writes, MCP lists 99 tools and returns seeded data |
| Memory | about 2.7 GB: web 1.3 GB, worker 0.6 GB, PGlite 0.4 GB, chDB 0.3 GB, moto 64 MB, Redis 15 MB |
| Disk | chDB 541 MB, PGlite 29 MB, Langfuse images 1.06 GB (web) + 821 MB (worker) |

For comparison, Langfuse's Docker Compose guide recommends a 4-core / 16 GB VM
and 2–3 minutes until web is ready; that stack was not run for this comparison.

## What it took

**Postgres** (`shims/postgres.mjs`):
- PGlite is one Postgres session shared by all client connections. The server
  queues each connection's protocol messages as a unit up to the next Sync,
  the point where Postgres treats a request as complete. Queuing single messages
  (as `pglite-socket` does) let one connection's Parse land between another's
  Parse and Bind (`unnamed prepared statement does not exist`).
- While a connection is inside a transaction, only that connection's requests
  run. A connection that drops mid-transaction is rolled back.
- `pgbouncer=true` in the database URL turns off Prisma's named prepared
  statements, which would collide across connections on the shared session.
- `pool_timeout=120`: requests run one at a time, so a burst (the worker looks
  up a prompt for each ingested observation) can exceed Prisma's default
  10-second wait for a connection.
- `CREATE INDEX CONCURRENTLY` is rewritten to a plain `CREATE INDEX` when
  migrations are applied; that is safe on a single-user database.

**ClickHouse** (`shims/clickhouse.py`):
- Langfuse sends parameterized queries as `multipart/form-data` bodies, settings
  as URL parameters, and inserts as `?query=INSERT … FORMAT X` with rows in the
  body. The shim handles those, gzip, `/ping` and ClickHouse-style errors.
- Settings are per request. `SET` lasts for the whole chDB session, so the shim
  restores settings the previous request changed; otherwise one query's settings
  leaked into the next and broke date parsing in the scores API.
- chDB runs one query at a time, so requests are serialized.
- Langfuse applies ClickHouse migrations with golang-migrate over the native
  protocol, which the shim does not speak, so the shim applies the image's
  `unclustered` migrations itself.

**Langfuse settings, no code changes:**
- Both automatic migrations are off (`LANGFUSE_AUTO_*_MIGRATION_DISABLED`).
- `LANGFUSE_MCP_ALLOWED_HOSTS` lists the host names clients use; otherwise MCP answers 403.
- `worker.env` keeps 13 of the worker's 35 job types on (ingestion, event
  propagation and dispatch, dataset run items, deletions, batch actions, retries)
  and turns off evaluations, exports, integrations, alerts, webhooks, topics,
  usage metering, the in-app agent, retention, background migrations and the
  legacy-API usage report (which needs `system.query_log`, missing in chDB).

## Known gaps

- Tested: the public API endpoints and MCP tools in `scripts/smoke.py` and
  `scripts/check_usage_suite.py`. Untested: the UI and everything turned off in `worker.env`.
- Throughput is low by design: every Postgres and ClickHouse request runs one at
  a time. Fine for one user or one test; not for load.
- Web and worker still run as Docker containers. A single binary is a later step.
- Everything binds to `127.0.0.1` and uses fixed demo secrets. Local use only.
