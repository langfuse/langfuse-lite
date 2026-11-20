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

No Langfuse code is changed or forked. Upgrading means rebuilding on a newer
Langfuse image; the schema always comes from that image's own migrations.

**Status: prototype, step 3.** One image, one `docker run`. The base public API
and MCP work for everything the agent-testing usage suite does. It is not a
supported Langfuse distribution.

**Next (planned, not started):** a slim server for experiment runs and local
agent tracing: one TypeScript process and one SQLite file, about 1 MB, under
1 s to start, `npx -y langfuse-lite`. See [docs/slim-server.md](docs/slim-server.md).

## Run: one container

```bash
scripts/setup.sh              # once: shim dependencies, Langfuse images, their migrations
scripts/build-image.sh        # -> langfuse-lite:latest (about 1.5 minutes)
docker run -d --name langfuse-lite -p 3000:3000 langfuse-lite:latest
python3 scripts/smoke.py      # trace round trip + API probes
```

Then use the API at http://localhost:3000 with `pk-lf-lite` / `sk-lf-lite`, or
log in as `lite@example.com` / `lite-password` (the UI is untested).

- **Healthy** when `docker inspect -f '{{.State.Health.Status}}' langfuse-lite` says
  `healthy`, so compose files can use `depends_on: {langfuse-lite: {condition: service_healthy}}`.
- **Data** lives in `/data`. Without a volume every container starts from the
  built-in snapshot; add `-v langfuse-lite-data:/data` to keep data across restarts.
- **Settings** default to `langfuse-lite.env` + `worker.env`; `docker run -e` overrides
  any of them. Keep `SALT` and `ENCRYPTION_KEY` as they are: the snapshot's API
  keys were created with them. Extra `LANGFUSE_INIT_*` values add another org,
  project and key next to `lite-org`.
- **Stop** with `docker stop`: Langfuse gets 3 s (`LITE_STOP_GRACE`), then the
  stand-ins close their files. Takes about 4 s.

The image is `FROM` the official web image, with the worker app copied from the
worker image, `redis-server` from the official Redis image, a portable Python
with the shims, and one entrypoint (`docker/entrypoint.sh`) that starts the four
stand-ins on `127.0.0.1`, then the worker (`127.0.0.1:3030`) and web (`0.0.0.0:3000`).

`build-image.sh` bakes in a snapshot that is already migrated and already
through Langfuse's first start: it starts the image once and waits for web to
seed ~200 default model prices, the built-in dashboards and `lite-org`, which
takes about 20 s through PGlite and would otherwise happen in every fresh
container.

`.github/workflows/image.yml` builds, smoke-tests and pushes
`ghcr.io/langfuse/langfuse-lite:<langfuse tag>`; it runs only when started by hand.

## Run: processes on the host (for working on the shims)

```bash
scripts/setup.sh            # once (also needs redis-server on the host)
scripts/start.sh --fresh    # stand-ins as host processes, web and worker as containers
python3 scripts/smoke.py
scripts/stop.sh
```

## Check against the agent-testing usage suite

No agents involved; run with the agent-testing repo's Python environment:

```bash
../coding-agent-testing/.venv/bin/python scripts/check_usage_suite.py --agent-testing ../coding-agent-testing
```

## Results (Langfuse 4.83.0, `langfuse:4` images)

Measured in a 4-core, 15 GB Linux VM.

**The image**

| | Result |
|---|---|
| Download | 585 MB compressed (the official web + worker images: 224 + 164 MB) |
| Unpacked | 2.77 GB: web image 1.06 GB, worker app, chDB 551 MB, Python 109 MB, moto/flask/aiohttp 120 MB, snapshot 50 MB |
| `docker load` on a daemon without any Langfuse layers | 13.6 s (a registry pull adds the 585 MB download) |
| `docker run` → healthy | 12–15 s on every fresh container (no migrations, no seeding); stand-ins ready after 2 s, the rest is Langfuse web booting |
| `docker stop` | 3.6 s, exit code 0; data on a volume survives restarts |
| Build (`build-image.sh`, images already pulled) | 60–105 s, including the 40 s warm-up start |
| Memory | 2.4 GB |
| `smoke.py`, `check_usage_suite.py` against the container | 8/8, 17/17 |

Trimmed from the image, 330 MB together: pandas and pyarrow (chDB's
dependencies, unused by the shim; about 210 MB) and moto's `[server]` extra,
which pulls in every AWS service's dependencies; S3 needs only flask.

**Behavior (same in the container and on the host)**

| | Result |
|---|---|
| Cold start, host processes, empty data folder | about 15 s to a healthy web, including 491 Postgres and 56 ClickHouse migrations |
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
- The image is not published yet: run the `image` workflow, or build locally.
- x86-64 only (chDB and the portable Python are built per architecture; arm64 would need its own build).
- About 10 of the 12–15 s start is Langfuse web booting, which the image does not change.
- Fixed demo secrets; web listens on all interfaces inside the container. Local use only.
