# Development, conformance and measurements

Details moved out of the [README](../README.md).

## Development

```bash
npm install                     # dev dependencies (bundled into dist)
bun run scripts/build.ts        # dist/cli.js
bun test test/                  # API and CLI tests
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

## Load

langfuse-lite handles one request at a time on one SQLite file. Under more load it
gets slower rather than failing: requests queue (p99 about 0.2 s at 16 parallel
senders). It answers with an error, and points to Langfuse Cloud or a self-hosted
Langfuse (with `push` to move the data), when:

- a request body is over 64 MB (HTTP 413)
- the database stays locked for more than 5 s, usually by a second langfuse-lite
  process on the same file (HTTP 503)

It logs a warning with the same pointer when a request takes more than 2 s, and at
start when the database holds more than 1 million observations or 2 GB.


## Known gaps

- Prompts are not served; experiments that fetch prompts need a full Langfuse.
- Trace-level attributes are not propagated to every observation of a trace
  the way Langfuse's worker does; the SDKs already set them on every span.
- `GET /api/public/v3/scores` accepts `value` and `operator` but does not filter by them yet.
- Custom model prices need `push` to a full Langfuse.
