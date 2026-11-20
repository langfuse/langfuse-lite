# Plan: slim server (built: see [slim/README.md](../slim/README.md))

The Docker image runs the real Langfuse and stays the full-fidelity option.
The slim server is a much lighter, separate option for what code agents need
locally: **experiment runs on the Langfuse data model, and tracing and
debugging local agent runs.**

**Status:** built as planned, with these changes:
- The span → observation conversion and cost calculation are not ported but
  **vendored unchanged** from the Langfuse worker image (41 compiled files,
  `slim/scripts/vendor-langfuse.sh`), with small shims for Redis, ClickHouse, S3,
  env and logging. That removes most of the drift risk below.
- Langfuse v4's data model throughout: one `observations` table, grouped by
  trace id, no trace records (the first build had an `events` table and a
  `traces` view; existing databases migrate on start).
- Experiment runs are read through Langfuse v4's `/api/public/experiments` and
  `/api/public/experiment-items`; v4 turns off the older dataset-run endpoints.
- The JS SDK (6.1.1) uses the same OTLP endpoint, sending OTLP/JSON; the
  Python SDK sends protobuf. Both pass the conformance suite.
- The Python SDK posts scores as batches (202, or 207 with per-score errors).

## Goal

| | Docker image (measured) | Slim server (target) |
|---|---|---|
| Install | 585 MB download, 14 s unpack | `npx -y langfuse-lite` or `uvx langfuse-lite`; about 1 MB of JS, or one binary |
| Start | 12–15 s | under 1 s |
| Memory | 2.4 GB | under 100 MB |
| Needs Docker | yes | no |
| Langfuse API | everything in the base features | the slice below; exact again after `push` |

## Principle: same SDK, same settings

Agents and scripts keep using the official Langfuse SDKs and
`LANGFUSE_BASE_URL=http://localhost:3000`. Switching to Langfuse Cloud or a
self-hosted Langfuse means changing the URL, not the code.

## API slice

What the Python SDK (langfuse 5.2.0) calls for tracing and `run_experiment`:

| Purpose | Endpoint |
|---|---|
| Traces, observations, experiment runs | `POST /api/public/otel/v1/traces` (OTLP over HTTP; protobuf from the Python SDK, also accept JSON) |
| Scores (evaluators; run-level evaluators set `datasetRunId` to the experiment id) | `POST /api/public/scores` |
| Datasets | `GET`/`POST /api/public/v2/datasets`, `GET`/`POST /api/public/dataset-items` |
| Key check | `GET /api/public/projects` |
| Health | `GET /api/public/health` |

Experiment runs are not separate API calls. Each item's span carries
`langfuse.experiment.id`, `.name`, `.description`, `.metadata`, `.dataset.id`,
`.item.id`, `.item.version`, `.item.expected_output`, `.item.metadata` and
`.item.root_observation_id`, with environment `sdk-experiment`. The server
derives runs and run items from these.

Read side, with Langfuse's response shapes, so SDKs and agents can read back:
`GET /api/public/v2/observations`, `GET /api/public/v3/scores`, dataset runs
and run items.

Verify against the JS SDK before building; it is expected to use the same
OTLP endpoint.

## Design

- **One process, one SQLite file**: `.langfuse/lite.db` in the project folder.
  Tables follow the Langfuse data model: observations, scores, datasets,
  dataset items, experiment runs and run items. Agents can query it with `sqlite3`.
- **Raw OTLP is kept**: every trace payload is stored as received, next to
  the parsed tables, so a gap in the span → observation conversion loses
  nothing and can be re-run.
- **`push`**: `langfuse-lite push --to <url>` replays the raw payloads,
  datasets and scores into Langfuse Cloud or a self-hosted Langfuse, which then
  does the full processing (model matching, cost) and shows the full UI.
- **Commands for agents**:
  - `observations`: root observations with totals per trace id, or any
    observations by level, name, type, trace id or run.
  - `tree <trace id>`: all observations sharing a trace id, as a tree with
    timings, errors, tokens and cost.
  - `runs`: list experiment runs.
  - `compare <runA> <runB>`: per item, outputs, scores, latency and cost side by side.
  - `sql`: run any query on the database.
- **One static HTML page** for people: observation trees and a run comparison.
- **Auth**: any key is accepted; one fixed project.

Left out:
- organisations and access control
- the full UI
- evaluators that run inside Langfuse
- dashboards
- the metrics API (`sql` instead)
- MCP (the commands instead)
- media uploads
- annotation queues
- the legacy `/api/public/ingestion` endpoint
- prompt management: a candidate add-on later, since experiments often use prompts

## Language and distribution (decided)

Written in **TypeScript** with a runtime-neutral core: web-standard HTTP
handlers and a small SQLite adapter over `node:sqlite` and `bun:sqlite`. It
runs on Node and on Bun.

- **TypeScript:** Langfuse is TypeScript (MIT outside `ee/`). The span →
  observation conversion and model-price matching can be ported from it
  closely instead of rewritten, and kept in sync.
- **Shipped three ways:**
  1. **npm (main channel):** plain JS for Node 22.13+ (`node:sqlite` built in).
     `npx -y langfuse-lite`. Node is in nearly every coding-agent environment,
     because the agent CLIs ship through npm.
  2. **PyPI:** wheels with a Bun-compiled binary per platform, the way ruff and
     uv ship theirs, so `uvx langfuse-lite` and `pip install langfuse-lite` need
     no Node. This package also has the pytest fixture that starts the server on
     a random port.
  3. **GitHub releases:** the same binaries, for environments with neither.
- **Bun** is the build and test tool and compiles the binaries
  (`bun build --compile`, Linux, macOS and Windows on x64 and arm64). Users
  never need Bun.

## Conformance

The Docker image is the reference. A test suite sends the same SDK scripts to
both and compares what the shared read endpoints return:
- observations with generations, tools, errors and nesting
- `run_experiment` with item and run evaluators, on a stored dataset and on local data
- an agent's OTel trace

Run it in CI and when moving to a new Langfuse version.

## Risks

- **Conversion drift**: the span → observation conversion re-implements part of
  Langfuse, and Langfuse adds attributes over time. Mitigations: port from
  Langfuse's code, keep the raw OTLP, run the conformance suite.
- **Cost**: ship Langfuse's default model prices with simple model-name
  matching, or show cost only after `push`.
- **Older SDKs** that use `/api/public/ingestion` are not supported at first.
- **Release pipeline**: builds for every platform and two registries; a one-time setup.

## First prototype (about a day)

1. Server, SQLite schema, OTLP protobuf and JSON decoding.
2. Span → observation conversion; experiment runs from span attributes; scores; datasets.
3. Read endpoints, then `observations`, `tree`, `runs`, `compare` and `sql`.
4. Conformance tests against the Docker image.
5. `push`, the HTML page, then packaging (npm first, then PyPI wheels).
