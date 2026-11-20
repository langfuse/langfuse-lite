# langfuse-lite

A local Langfuse for **experiment runs** and **agent tracing and debugging**,
made for code agents: one process, one SQLite file, the official Langfuse SDKs
unchanged. No Docker, no databases to run.

```bash
npx -y langfuse-lite serve        # or: uvx langfuse-lite serve, or the standalone executable
```

```bash
export LANGFUSE_BASE_URL=http://localhost:3000 LANGFUSE_PUBLIC_KEY=pk-lf-local LANGFUSE_SECRET_KEY=sk-lf-local
```

Then trace and run experiments with the Langfuse SDKs as usual, or send any
OpenTelemetry spans to `http://localhost:3000/api/public/otel/v1/traces`.
Data goes to `./.langfuse/lite.db`. Open http://localhost:3000 for the viewer:
observations (each run as a waterfall, input/output, usage and cost per step),
datasets (items, the observations they came from and the runs made on each;
read-only, datasets are managed in code) and experiments (runs compared item by item).

**Data model:** Langfuse v4's. Everything is an observation (span, generation,
agent, tool, retriever, …). Observations that belong together share a trace id,
and trace-level attributes such as the trace name, user, session and tags are
fields on the observations. There are no separate trace records.

**Status:** prototype, not published to npm or PyPI yet; build it locally (see
Development). MIT license.
`python test/demo.py http://127.0.0.1:3000` writes demo data (support-agent runs and
two comparable experiment runs) through the Python SDK.

## For agents: the commands

The commands read the database directly, so they work while the server runs or after.

```text
$ langfuse-lite observations                      # root observations, newest first, totals per trace id
trace_id                          name           type   start                duration  obs  errors  tokens  cost
478d02b45e251eadf418f4546f2e2827  support-agent  AGENT  2026-11-20 08:53:40  1.2s      5    1       4720    $0.0107

$ langfuse-lite observations --level ERROR --io   # filter: --level --name --type --trace --experiment --since
id                trace_id                          type  name        level  status                        latency  input
7d50e42ad29b51e1  478d02b45e251eadf418f4546f2e2827  TOOL  send_email  ERROR  SMTP timeout after 3 retries  140ms    {"user": "user-114"}

$ langfuse-lite tree 478d02 --io                   # every observation sharing the trace id
trace id 478d02b45e251eadf418f4546f2e2827  ·  support-agent  ·  user user-114  ·  5 observations  ·  1.2s  ·  4720 tokens  ·  $0.0107  ·  1 error
└─ AGENT  support-agent  1.2s   d0a6d98b090f9e56
     in:  {"message": "Can you email me the receipt?"}
   ├─ GENERATION  plan  claude-sonnet-5-5  2010→64 tok  $0.0047  460ms   a8aa405e661c544b
   ├─ RETRIEVER  search_help_center  71ms   ffd6f53e04956eca
   ├─ TOOL  send_email  140ms  ERROR: SMTP timeout after 3 retries   7d50e42ad29b51e1
   └─ GENERATION  answer  claude-sonnet-5-5  2550→96 tok  $0.0061  520ms   68fae723a6612efb
scores: resolved=no, helpfulness=0.4 "tool failed, offered a workaround"

$ langfuse-lite runs
id                name                                dataset    items  errors  avg latency  cost       scores
a4ea15d60fb5f964  capitals-exp - 2026-11-20T08:14:45Z  capitals   3              0ms          $0.000014  exact_match=0.667 accuracy=0.667

$ langfuse-lite compare capitals-exp-v1 capitals-exp-v2     # by name (latest run) or id
$ langfuse-lite sql "SELECT name, SUM(input_usage), AVG(latency_ms) FROM observations WHERE type = 'GENERATION' GROUP BY name"
$ langfuse-lite push --to https://cloud.langfuse.com --public-key pk-lf-… --secret-key sk-lf-…
$ langfuse-lite export --out run.html     # the viewer and its data in one file, to open or send
```

Every command takes `--json`. `--db <path>` (or `LANGFUSE_LITE_DB`) picks
another database. Failed API requests are logged by `serve` on stderr, since
SDKs usually swallow them. `traces` and `trace` (Langfuse v3 terms) answer with
the v4 command to use instead.

## Python: pytest fixture and `serve()`

The PyPI package ships the executable for the platform and registers two
fixtures: `langfuse_lite` (one server per session, temporary database) and
`langfuse_lite_env` (the same, with `LANGFUSE_*` set for the test).

```python
def test_my_agent(langfuse_lite_env):
    run_my_agent()                                    # traced with the Langfuse SDK as usual
    assert "my-agent" in langfuse_lite_env.cli("observations")

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
- **One SQLite file.** `observations` holds one row per observation, with
  Langfuse's field names in snake_case (`trace_id`, `parent_observation_id`, `model`,
  `usage_details`, …), trace-level and experiment fields inline, and derived columns
  for plain SQL: `input_usage`, `output_usage`, `total_usage`, `input_cost`,
  `output_cost`, `latency_ms`. Next to it: `scores`, `datasets`, `dataset_items`.
  Query it with `sql` or `sqlite3`.
- **Raw OTLP is kept.** Every request is stored as received (`otlp_requests`),
  so nothing is lost if the conversion misses something.
- **`push`** replays the raw spans (as OTLP/JSON), datasets, items and scores into a
  full Langfuse, rewriting local dataset ids to the target's. Ids are kept, so a
  second push updates instead of duplicating.
- **Tested against the real Langfuse and with code agents.** The same SDK scripts
  run against langfuse-lite and a full Langfuse and every read answer is compared
  (see Conformance). The `lite` suite in
  [coding-agent-testing](https://github.com/langfuse/coding-agent-testing/tree/claude/amazing-ride-vgi20z/suites/lite)
  (in review, PR #41) has agents debug and improve a bot with langfuse-lite; what
  they stumbled over shaped the commands.
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
| Python SDK scenario (agent trace, 2 experiments, scores) | 0.6 s, readable at once (a full Langfuse: 4 s, then a few seconds of queue) |
| Database | 660 KB for 205 observations, 80 scores and their raw OTLP |
| Ingest (16 parallel senders, 50-span batches) | about 6,000 spans/s up to 350,000 observations (1.3 GB); no errors |
| Reads while ingesting | root-observation list 25 ms, observation filters under 0.3 s at 350,000 observations |

For comparison, the official Langfuse web and worker images in the same VM, on
lightweight stand-ins for their stores, needed 2.4 GB of memory and 12–15 s to
start; Langfuse's own Docker Compose setup recommends a 4-core, 16 GB machine.

## Conformance

`test/conformance.py` runs the same SDK scenario against a full Langfuse and
langfuse-lite, sends the same read requests to both and compares the answers
field by field. Ids only have to map one-to-one,
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

Conformance needs a full Langfuse on port 3000 with the project keys
`pk-lf-lite` / `sk-lf-lite`, for example Langfuse's own Docker Compose setup with
[headless initialization](https://langfuse.com/self-hosting/headless-initialization),
and langfuse-lite on port 3100:

```bash
git clone --depth 1 https://github.com/langfuse/langfuse && cd langfuse
LANGFUSE_INIT_ORG_ID=lite-org LANGFUSE_INIT_PROJECT_ID=lite-project \
  LANGFUSE_INIT_PROJECT_PUBLIC_KEY=pk-lf-lite LANGFUSE_INIT_PROJECT_SECRET_KEY=sk-lf-lite \
  docker compose up -d
cd -
```

```bash
uv venv .venv-test && VIRTUAL_ENV=.venv-test uv pip install -r test/requirements.txt
(cd test/js && npm install)
node dist/cli.js serve --port 3100 --db /tmp/lite.db &
.venv-test/bin/python test/conformance.py
```

The scenarios refuse any URL that is not localhost and ignore `LANGFUSE_*`
variables from the environment.

For a new Langfuse version: `LANGFUSE_IMAGE_TAG=<tag> scripts/vendor-langfuse.sh`
(pulls the official worker image, so it needs Docker), rebuild, run the
conformance tests.

## Repository

| | |
|---|---|
| `src/` | server, CLI, ingestion, API, viewer |
| `vendor/` | Langfuse's span conversion, cost code and model prices (vendored, MIT) and the shims that let them run alone |
| `python/` | the PyPI package: executable wrapper, `serve()`, pytest fixtures |
| `test/` | API tests, conformance against a full Langfuse, SDK scenarios, demo data |
| `scripts/` | build, wheels, vendoring |
| [`docs/slim-server.md`](docs/slim-server.md) | the design plan langfuse-lite was built from |

## Load and limits

langfuse-lite handles one request at a time on one SQLite file. Under more load it
gets slower rather than failing: requests queue (p99 about 0.2 s at 16 parallel
senders). It answers with an error, and points to Langfuse Cloud or a self-hosted
Langfuse (with `push` to move the data), when:

- a request body is over 64 MB (HTTP 413)
- the database stays locked for more than 5 s, usually by a second langfuse-lite
  process on the same file (HTTP 503)

It logs a warning with the same pointer when a request takes more than 2 s, and at
start when the database holds more than 1 million observations or 2 GB.

## Limits

- Experiment runs, observations and scores only. Prompts are not served
  (experiments that fetch prompts from Langfuse need a full Langfuse).
- Trace-level attributes are not propagated to every observation with the same
  trace id the way Langfuse's worker does; the SDKs already set them on every span.
- Cost uses Langfuse's default model prices only; custom models need `push`.
- One local user: any API key is accepted and requests run one at a time.
- Not published yet: the npm and PyPI names (`langfuse-lite`) were free when checked.

## License

MIT. The vendored Langfuse code is MIT as well (`vendor/LICENSE-langfuse`);
`dist/THIRD_PARTY_NOTICES.md` lists everything the bundle contains.
