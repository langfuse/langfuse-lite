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

Trace and run experiments with the Langfuse SDKs as usual, or send any
OpenTelemetry spans. Then look at the results with the commands or the viewer
at http://localhost:3000:

```bash
langfuse-lite observations                     # root observations, newest first
langfuse-lite observations --level ERROR --io  # what failed, with inputs and outputs
langfuse-lite tree <trace id>                  # every observation of one run, as a tree
langfuse-lite runs                             # experiment runs and their scores
langfuse-lite compare <run> <run>              # two runs, item by item
langfuse-lite sql "SELECT name, SUM(input_usage) FROM observations GROUP BY name"
langfuse-lite push --to https://cloud.langfuse.com   # everything into a full Langfuse
```

**Data model:** Langfuse v4's. Everything is an observation; observations that
belong together share a trace id, and trace-level attributes (trace name, user,
session, tags) are fields on them.

**Status:** prototype, not published to npm or PyPI yet (build it from
[`slim/`](slim/README.md)). MIT license.

## How it works

- **Langfuse's own code for the hard part.** Spans become observations through
  Langfuse's span conversion, cost calculation and model prices, vendored
  unchanged from the official Langfuse 4.83 worker image. So spans from the
  Langfuse SDKs, OpenAI, Anthropic, Vercel AI SDK, OpenInference, OpenLLMetry
  and GenAI semantic conventions map exactly as in Langfuse.
- **A small server for the rest:** the slice of the Langfuse public API that the
  SDKs use for tracing, scores, datasets and experiments, on one SQLite file.
  Everything else answers 501 and points to `push`.
- **Tested against the real Langfuse:** the same Python and JS SDK scripts run
  against langfuse-lite and a full Langfuse, and every read answer is compared
  field by field: 31 of 31 checks match.
- **Tested with code agents:** the `lite` suite in
  [coding-agent-testing](https://github.com/langfuse/coding-agent-testing/tree/claude/amazing-ride-vgi20z/suites/lite) (in review, PR #41)
  has agents debug and improve a bot with langfuse-lite; what they stumbled over
  shaped the commands.

| | langfuse-lite | Full Langfuse in one container (reference) |
|---|---|---|
| Install | 219 KB npm package, or a 42–54 MB executable | 585 MB image |
| Start, memory | 0.1–0.6 s, 60–70 MB | 12–15 s, 2.4 GB |
| Load | about 6,000 spans/s, fine up to hundreds of thousands of observations | production Langfuse |
| API | tracing, scores, datasets, experiments | everything, incl. UI and MCP |

When the load grows past local use (very large requests, a locked database,
slow requests, a database over 1 million observations or 2 GB), langfuse-lite
says so and points to Langfuse Cloud or self-hosting, with `push` to move the data.

## Repository

| Folder | |
|---|---|
| [`slim/`](slim/README.md) | **langfuse-lite**: the server, CLI, viewer, Python package and their tests. Details, measurements and limits are in its README. |
| [`docs/full-langfuse-image.md`](docs/full-langfuse-image.md) | the **reference image**: the official Langfuse web and worker in one container, on small stand-ins for Postgres (PGlite), ClickHouse (chDB), Redis and S3 (moto). langfuse-lite does not use any of these; the image is the real Langfuse its conformance tests compare against. |
| `docker/`, `shims/`, `scripts/`, `*.env` | the reference image's build and stand-ins |
| [`docs/slim-server.md`](docs/slim-server.md) | the design plan langfuse-lite was built from |

## License

MIT. langfuse-lite vendors Langfuse code (MIT, outside Langfuse's `ee/` folders);
see `slim/vendor/LICENSE-langfuse` and the third-party notices in its builds.
