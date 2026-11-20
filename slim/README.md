# langfuse-lite (slim server)

A local Langfuse for **experiment runs** and **agent tracing and debugging**:
one process, one SQLite file, the official Langfuse SDKs unchanged.

```bash
npx -y langfuse-lite serve        # or: uvx langfuse-lite serve
```

```bash
export LANGFUSE_BASE_URL=http://localhost:3000 LANGFUSE_PUBLIC_KEY=pk-lf-local LANGFUSE_SECRET_KEY=sk-lf-local
```

Then trace and run experiments with the Langfuse SDKs as usual, or send any
OpenTelemetry traces to `http://localhost:3000/api/public/otel/v1/traces`.
Data goes to `./.langfuse/lite.db`. Open http://localhost:3000 for the viewer.

Not published to npm or PyPI yet; build locally (see Development).
`python test/demo.py http://127.0.0.1:3000` writes demo data (agent traces and
two comparable experiment runs) through the Python SDK.

## For agents: the commands

The commands read the database directly, so they work while the server runs or after.

```text
$ langfuse-lite traces
id                                name                 start                duration  obs  errors  tokens  cost
3df3bfa506e976981d58e04c680d78e7  support-agent        2026-11-20 08:19:04  5ms       4    1       1280    $0.0038

$ langfuse-lite trace 3df3 --io
trace 3df3bfa506e976981d58e04c680d78e7  ·  support-agent  ·  user user-7  ·  5ms  ·  1280 tokens  ·  $0.0038  ·  1 error
└─ AGENT  agent  5ms   0c4a…
   ├─ GENERATION  plan  gpt-4o  1200→80 tok  $0.0038  0ms   1bf5…
   │    in:  [{"role": "user", "content": "Where is my refund?"}]
   │    out: {"role": "assistant", "content": "Let me look it up."}
   ├─ TOOL  lookup_refund  1ms   7e21…
   └─ SPAN  notify  0ms  ERROR: SMTP timeout   9a0d…
scores: helpfulness=0.8 "clear answer", resolved=yes, escalated=false (on 1bf5…)

$ langfuse-lite runs
id                name                                dataset    items  errors  avg latency  cost       scores
a4ea15d60fb5f964  capitals-exp - 2026-11-20T08:14:45Z  capitals   3              0ms          $0.000014  exact_match=0.667 accuracy=0.667

$ langfuse-lite compare capitals-exp-v1 capitals-exp-v2     # by name (latest run) or id
$ langfuse-lite sql "SELECT name, COUNT(*) FROM events WHERE level = 'ERROR' GROUP BY 1"
$ langfuse-lite push --to https://cloud.langfuse.com --public-key pk-lf-… --secret-key sk-lf-…
$ langfuse-lite export --out run.html     # the viewer and its data in one file, to open or send
```

Every command takes `--json`. `--db <path>` (or `LANGFUSE_LITE_DB`) picks
another database. Failed API requests are logged by `serve` on stderr, since
SDKs usually swallow them.

## Python: pytest fixture and `serve()`

The PyPI package ships the executable for the platform and registers two
fixtures: `langfuse_lite` (one server per session, temporary database) and
`langfuse_lite_env` (the same, with `LANGFUSE_*` set for the test).

```python
def test_my_agent(langfuse_lite_env):
    run_my_agent()                                    # traced with the Langfuse SDK as usual
    assert "my-agent" in langfuse_lite_env.cli("traces")

from langfuse_lite import serve
with serve() as lite:                                 # free port, temporary database
    os.environ.update(lite.env)
```

## What it serves

The slice of the Langfuse public API that the SDKs (Python 5.x, JS 6.x) use
for tracing and experiments, plus what agents need to read results back:

| Endpoint | |
|---|---|
| `POST /api/public/otel/v1/traces` | OTLP over HTTP, protobuf or JSON, gzip |
| `POST /api/public/scores` | single or batch (202 / 207 like Langfuse) |
| `GET /api/public/v3/scores` | filters, `fields`, cursor pages |
| `GET/POST /api/public/v2/datasets`, `GET/DELETE …/{name}` | create is an upsert by name |
| `GET/POST /api/public/dataset-items`, `GET/DELETE …/{id}` | |
| `GET /api/public/v2/observations` | filters, `fields`, cursor pages |
| `GET /api/public/experiments`, `GET /api/public/experiment-items` | runs built from span attributes |
| `GET /api/public/projects`, `/health`, `/ready` | any keys are accepted |

Everything else answers 501 with a pointer to `push`. Left out on purpose:
organizations and access control, prompt management, evaluators running in
Langfuse, dashboards, the metrics API (use `sql`), MCP (use the commands),
media, annotation queues, and the legacy `/api/public/ingestion` endpoint.

## How it works

- **Langfuse's own conversion.** OTel spans become Langfuse observations through
  Langfuse's `OtelIngestionProcessor`, its cost calculation and its default model
  prices, vendored unchanged from the official worker image
  (`vendor/langfuse/`, MIT; `scripts/vendor-langfuse.sh` refreshes it). So OpenAI,
  Anthropic, Vercel AI SDK, OpenInference, OpenLLMetry and GenAI-semantic-convention
  spans map exactly as in Langfuse.
- **One SQLite file.** `events` follows Langfuse v4's events table (one row per
  observation, trace and experiment fields inline, same column names), plus
  `scores`, `datasets`, `dataset_items` and a `traces` view. Query it with `sql`
  or `sqlite3`.
- **Raw OTLP is kept.** Every request is stored as received (`otlp_requests`),
  so nothing is lost if the conversion misses something.
- **`push`** replays the raw spans (as OTLP/JSON), datasets, items and scores into a
  full Langfuse, rewriting local dataset ids to the target's. Ids are kept, so a
  second push updates instead of duplicating.
- **Runtime-neutral TypeScript.** Web-standard handlers and a small SQLite
  adapter over `node:sqlite` (Node 22.13+) and `bun:sqlite`. Shipped as plain JS
  for Node (npm), as Bun-compiled executables (GitHub releases), and as PyPI
  wheels wrapping those executables.

## Measured (4-core Linux VM)

| | |
|---|---|
| npm package | 219 KB (`dist/cli.js` 1.2 MB, no dependencies) |
| `npx` from an empty folder → healthy | 0.56 s (`node dist/cli.js serve`: 0.13 s) |
| Executable | 86–111 MB, 42–54 MB compressed; healthy in 0.12 s; no Node or Bun needed |
| PyPI wheels | 39–52 MB; `uvx` start 0.3 s |
| Memory | 60–70 MB |
| Python SDK scenario (agent trace, 2 experiments, scores) | 0.6 s, readable at once (the Docker image: 4 s, then a few seconds of queue) |
| Database | 660 KB for 205 observations, 80 scores and their raw OTLP |

The Docker image with the full Langfuse, for comparison: 585 MB download, 2.4 GB
memory, 12–15 s start.

## Conformance

`test/conformance.py` runs the same SDK scenario against the full Langfuse (the
Docker image in `../docker`) and langfuse-lite, sends the same read requests to
both and compares the answers field by field. Ids only have to map one-to-one,
and timestamps only have to be timestamps.

| | Python SDK 5.2.0 | JS SDK 6.1.1 |
|---|---|---|
| on Node 22 | 16/16 endpoints match | 15/15 |
| on Bun 1.4 | 16/16 | 15/15 |
| compiled executable | 16/16 | 15/15 |

Covered: an agent trace with a generation, a tool call, an error, user, session,
tags and metadata, including usage, cost and model matching; a plain-OpenTelemetry
GenAI trace from an agent framework (Python); a dataset experiment with item and
run evaluators; an experiment on local data; numeric, categorical, boolean,
trace, observation, session and run scores; datasets and items; error responses.

## Development

```bash
npm install                     # dev dependencies (bundled into dist)
bun run scripts/build.ts        # dist/cli.js
bun test test/                  # API tests
npx tsc -p .                    # type check
bun run scripts/build.ts --compile && python3 scripts/build-wheels.py   # executables + wheels
```

Conformance needs the full Langfuse on port 3000 (`../scripts/build-image.sh`,
then `docker run -p 3000:3000 langfuse-lite:latest`) and langfuse-lite on 3100:

```bash
uv venv .venv-test && VIRTUAL_ENV=.venv-test uv pip install -r test/requirements.txt
(cd test/js && npm install)
node dist/cli.js serve --port 3100 --db /tmp/lite.db &
.venv-test/bin/python test/conformance.py
```

The scenarios refuse any URL that is not localhost and ignore `LANGFUSE_*`
variables from the environment.

For a new Langfuse version: `LANGFUSE_IMAGE_TAG=<tag> scripts/vendor-langfuse.sh`,
rebuild, run the conformance tests.

## Limits

- Experiment runs, traces and scores only. Prompts are not served (experiments
  that fetch prompts from Langfuse need a full Langfuse).
- Trace-level fields are not propagated across a trace's observations the way
  Langfuse's worker does; the SDKs already set them on every span.
- Cost uses Langfuse's default model prices only; custom models need `push`.
- One local user: any API key is accepted and requests run one at a time.
- Not published yet: the npm and PyPI names (`langfuse-lite`) were free when checked.

## License

MIT. The vendored Langfuse code is MIT as well (`vendor/LICENSE-langfuse`);
`dist/THIRD_PARTY_NOTICES.md` lists everything the bundle contains.
