"""Conformance: the same SDK scenario against a real Langfuse and langfuse-lite,
then the same read requests to both, compared field by field.

    python test/conformance.py --ref http://127.0.0.1:3000 --lite http://127.0.0.1:3100

The reference is any full Langfuse on localhost with the project keys
pk-lf-lite / sk-lf-lite, for example Langfuse's Docker Compose setup with
headless initialization (see docs/development.md). Both URLs must be localhost; the
scenario writes test data.

Comparison rules:
  - same keys, same JSON types, same values
  - ids (hex, uuid, cuid) only need to map one-to-one between the two sides
  - timestamps only need to be timestamps; latencies only need to be numbers
  - the run tag and run start times inside names are masked
Lists are compared after sorting by content, since items with equal
timestamps come back in either order.
Exit code 1 on any difference.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from urllib.parse import quote, urlparse

HERE = Path(__file__).parent
KEYS = ("pk-lf-lite", "sk-lf-lite")
ALL_OBS = "core,basic,time,io,metadata,model,usage,prompt,metrics"
ALL_ITEM = "core,dataset,io,metadata,itemMetadata,experimentMetadata,scores"
ALL_SCORE = "core,details,subject,annotation"

ID = re.compile(r"^(?:[0-9a-f]{16}|[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|c[a-z0-9]{24})$")
TS = re.compile(r"^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(\.\d+)?Z?$")
RUN_TIME = re.compile(r" - \d{4}-\d\d-\d\dT[\d:.]+Z")
# Values that differ by design and are only checked for presence.
VOLATILE_KEYS = {"latency", "timeToFirstToken", "projectId", "cursor"}
# Langfuse-internal fields with no meaning locally.
IGNORED_KEYS = {"scope.attributes.public_key"}


def get(base: str, path: str):
    req = urllib.request.Request(base + path, headers={
        "Authorization": "Basic " + base64.b64encode(f"{KEYS[0]}:{KEYS[1]}".encode()).decode()})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return [r.status, json.loads(r.read() or b"null")]
    except urllib.error.HTTPError as e:
        return [e.code, json.loads(e.read() or b"null")]


def run_scenario(base: str, tag: str, sdk: str) -> dict:
    cmd = ([sys.executable, str(HERE / "scenario.py")] if sdk == "python"
           else ["node", str(HERE / "js" / "scenario.mjs")])
    out = subprocess.run([*cmd, base, tag], check=True, capture_output=True, text=True)
    return json.loads(out.stdout.strip().splitlines()[-1])


def snapshot(base: str, m: dict, since: str) -> dict:
    tag = m["tag"]
    snap: dict = {}
    status, projects = get(base, "/api/public/projects")
    # Project and organization names differ by design; compare the shape.
    snap["projects"] = [status, {"data": [sorted(d.keys()) + sorted(d["organization"].keys()) for d in projects["data"]]}]
    snap["agent trace observations"] = get(base, f"/api/public/v2/observations?traceId={m['agent_trace_id']}&fields={ALL_OBS}")
    snap["agent trace observations, default fields"] = get(base, f"/api/public/v2/observations?traceId={m['agent_trace_id']}")
    snap["experiment item traces"] = [
        get(base, f"/api/public/v2/observations?traceId={t}&fields={ALL_OBS}") for t in m["dataset_experiment_traces"]
    ]
    if m.get("otel_trace_id"):
        snap["agent framework OTel trace"] = get(base, f"/api/public/v2/observations?traceId={m['otel_trace_id']}&fields={ALL_OBS}")
    snap["agent trace scores"] = get(base, f"/api/public/v3/scores?traceId={m['agent_trace_id']}&fields={ALL_SCORE}")
    snap["session scores"] = get(base, f"/api/public/v3/scores?sessionId=session-{tag}&fields={ALL_SCORE}")
    snap["run scores"] = get(base, f"/api/public/v3/scores?experimentId={m['experiment_id']}&fields={ALL_SCORE}")
    snap["dataset"] = get(base, f"/api/public/v2/datasets/{quote(m['dataset'])}")
    snap["dataset items"] = get(base, f"/api/public/dataset-items?datasetName={quote(m['dataset'])}")
    exps = get(base, f"/api/public/experiments?fromStartTime={since}&fields=core,metadata,scores")
    if exps[0] == 200:
        exps[1]["data"] = [e for e in exps[1]["data"] if tag in e["name"]]
    snap["experiments"] = exps
    snap["experiment items (dataset run)"] = get(
        base, f"/api/public/experiment-items?experimentId={m['experiment_id']}&fromStartTime={since}&fields={ALL_ITEM}")
    snap["experiment items (local data)"] = get(
        base, f"/api/public/experiment-items?experimentId={m['local_experiment_id']}&fromStartTime={since}&fields={ALL_ITEM}")
    snap["error: experiments without fromStartTime"] = get(base, "/api/public/experiments")
    snap["error: unknown dataset"] = get(base, "/api/public/v2/datasets/does-not-exist")
    snap["error: scores unknown filter"] = get(base, "/api/public/v3/scores?bogus=1")
    return snap


def wait_until_ingested(base: str, m: dict, timeout: float = 120):
    """The reference ingests through a queue; wait for every trace and score."""
    deadline = time.time() + timeout
    traces = [m["agent_trace_id"], *([m["otel_trace_id"]] if m.get("otel_trace_id") else []),
              *m["dataset_experiment_traces"], *m["local_experiment_traces"]]
    while time.time() < deadline:
        ready = all(len(get(base, f"/api/public/v2/observations?traceId={t}")[1].get("data", [])) > 0 for t in traces)
        scores = get(base, f"/api/public/v3/scores?traceId={m['agent_trace_id']}")[1].get("data", [])
        run_scores = get(base, f"/api/public/v3/scores?experimentId={m['experiment_id']}")[1].get("data", [])
        if ready and len(scores) >= 3 and run_scores:
            time.sleep(2)  # let trailing updates land
            return
        time.sleep(1)
    raise SystemExit(f"{base}: data not ingested after {timeout} s")


class Diff:
    def __init__(self):
        self.ids: dict[str, str] = {}
        self.back: dict[str, str] = {}
        self.problems: list[str] = []

    def norm_str(self, s: str, tag: str) -> str:
        return RUN_TIME.sub(" - <time>", s.replace(tag, "<tag>"))

    def compare(self, a, b, path: str, tags: tuple[str, str]):
        key = path.rsplit(".", 1)[-1]
        if key in IGNORED_KEYS:
            return
        if key in VOLATILE_KEYS:
            # Durations come from two different runs: a 0 ms span on one side can
            # take 1 ms on the other, and Langfuse reports 0 as null.
            small = lambda v: v is None or (isinstance(v, (int, float)) and v < 0.005)
            if key in {"latency", "timeToFirstToken"} and small(a) and small(b):
                return
            if (a is None) != (b is None) and key not in {"projectId", "cursor"}:
                self.problems.append(f"{path}: ref {a!r} vs lite {b!r}")
            return
        if isinstance(a, dict) and isinstance(b, dict):
            a = {k: v for k, v in a.items() if k not in IGNORED_KEYS}
            b = {k: v for k, v in b.items() if k not in IGNORED_KEYS}
            for k in sorted(set(a) | set(b)):
                if k not in b:
                    self.problems.append(f"{path}.{k}: missing in lite (ref: {json.dumps(a[k])[:120]})")
                elif k not in a:
                    self.problems.append(f"{path}.{k}: extra in lite ({json.dumps(b[k])[:120]})")
                else:
                    self.compare(a[k], b[k], f"{path}.{k}", tags)
            return
        if isinstance(a, list) and isinstance(b, list):
            if len(a) != len(b):
                self.problems.append(f"{path}: {len(a)} items in ref, {len(b)} in lite")
                return
            sa, sb = self.sorted(a, tags[0]), self.sorted(b, tags[1])
            for i, (x, y) in enumerate(zip(sa, sb)):
                self.compare(x, y, f"{path}[{i}]", tags)
            return
        if isinstance(a, str) and isinstance(b, str):
            if ID.match(a) and ID.match(b):
                if self.ids.setdefault(a, b) != b or self.back.setdefault(b, a) != a:
                    self.problems.append(f"{path}: id {a} maps to both {self.ids[a]} and {b}")
                return
            if TS.match(a) and TS.match(b):
                return
            # JSON inside strings (input/output/metadata values): compare parsed.
            try:
                pa, pb = json.loads(a), json.loads(b)
                if isinstance(pa, (dict, list)) and isinstance(pb, (dict, list)):
                    self.compare(pa, pb, path + "<json>", tags)
                    return
            except (ValueError, TypeError):
                pass
            if self.norm_str(a, tags[0]) != self.norm_str(b, tags[1]):
                self.problems.append(f"{path}: ref {a!r} vs lite {b!r}")
            return
        if type(a) is not type(b) or (a != b and not (isinstance(a, float) and abs(a - b) < 1e-12)):
            self.problems.append(f"{path}: ref {a!r} vs lite {b!r}")

    def sorted(self, items: list, tag: str) -> list:
        def masked(v):
            if isinstance(v, dict):
                return {k: masked(x) for k, x in v.items() if k not in VOLATILE_KEYS and k not in IGNORED_KEYS}
            if isinstance(v, list):
                return sorted((masked(x) for x in v), key=lambda x: json.dumps(x, sort_keys=True))
            if isinstance(v, str):
                if ID.match(v) or TS.match(v):
                    return ""
                return self.norm_str(v, tag)
            return v
        return sorted(items, key=lambda x: json.dumps(masked(x), sort_keys=True))


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--ref", default="http://127.0.0.1:3000")
    p.add_argument("--lite", default="http://127.0.0.1:3100")
    p.add_argument("--sdk", choices=["python", "js", "both"], default="both")
    p.add_argument("--keep", help="write both snapshots into this folder")
    args = p.parse_args()
    for url in (args.ref, args.lite):
        if urlparse(url).hostname not in ("127.0.0.1", "localhost"):
            sys.exit(f"refusing to write test data to {url}: only localhost")
    failed = 0
    for sdk in (["python", "js"] if args.sdk == "both" else [args.sdk]):
        print(f"== {sdk} SDK")
        failed += check(args, sdk)
    return 1 if failed else 0


def check(args, sdk: str) -> int:
    since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    stamp = dt.datetime.now().strftime("%H%M%S")
    mr = run_scenario(args.ref, f"ref{sdk[:2]}{stamp}", sdk)
    ml = run_scenario(args.lite, f"lite{sdk[:2]}{stamp}", sdk)
    wait_until_ingested(args.ref, mr)
    wait_until_ingested(args.lite, ml, timeout=10)
    sr, sl = snapshot(args.ref, mr, since), snapshot(args.lite, ml, since)
    if args.keep:
        Path(args.keep).mkdir(parents=True, exist_ok=True)
        Path(args.keep, f"ref-{sdk}.json").write_text(json.dumps(sr, indent=1))
        Path(args.keep, f"lite-{sdk}.json").write_text(json.dumps(sl, indent=1))
    total = 0
    for name in sr:
        d = Diff()
        d.compare(sr[name], sl[name], "", (mr["tag"], ml["tag"]))
        status = "PASS" if not d.problems else "FAIL"
        print(f"{status}  {name}")
        for prob in d.problems[:25]:
            print(f"        {prob}")
        if len(d.problems) > 25:
            print(f"        … {len(d.problems) - 25} more")
        total += bool(d.problems)
    print(f"{len(sr) - total}/{len(sr)} endpoints match\n")
    return total


if __name__ == "__main__":
    sys.exit(main())
