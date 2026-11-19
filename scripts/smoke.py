"""Smoke test for a running langfuse-lite: one trace round trip plus a probe of other APIs.

    python3 scripts/smoke.py

Prints one line per check and exits non-zero if the trace round trip fails.
The other checks are informational: they show which parts of the public API
already work on the stand-ins.
"""

from __future__ import annotations

import base64
import datetime as dt
import json
import secrets
import sys
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:3000"
AUTH = "Basic " + base64.b64encode(b"pk-lf-lite:sk-lf-lite").decode()
SINCE = (dt.datetime.now(dt.UTC) - dt.timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")


def call(method: str, path: str, body=None, headers=None) -> tuple[int, object]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={
        "Authorization": AUTH, "Content-Type": "application/json", "Accept": "application/json, text/event-stream",
        **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode()
            status = r.status
    except urllib.error.HTTPError as e:
        raw, status = e.read().decode(), e.code
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, raw


def report(name: str, ok: bool, detail: str) -> bool:
    print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}")
    return ok


def trace_round_trip() -> bool:
    trace_id, now = secrets.token_hex(16), time.time_ns()
    attrs = {"langfuse.trace.name": "support-chat", "langfuse.user.id": "u-001", "langfuse.session.id": "s-1",
             "langfuse.observation.type": "generation", "gen_ai.request.model": "claude-sonnet-5-5",
             "langfuse.observation.input": "Where is my order?", "langfuse.observation.output": "Tomorrow."}
    span = {"traceId": trace_id, "spanId": secrets.token_hex(8), "name": "support-chat", "kind": 1,
            "startTimeUnixNano": str(now - 2_000_000_000), "endTimeUnixNano": str(now),
            "attributes": [{"key": k, "value": {"stringValue": v}} for k, v in attrs.items()]
            + [{"key": "gen_ai.usage.input_tokens", "value": {"intValue": "120"}},
               {"key": "gen_ai.usage.output_tokens", "value": {"intValue": "40"}}]}
    body = {"resourceSpans": [{"resource": {"attributes": []}, "scopeSpans": [{"scope": {"name": "smoke"}, "spans": [span]}]}]}
    sent = time.monotonic()
    status, _ = call("POST", "/api/public/otel/v1/traces", body, {"x-langfuse-ingestion-version": "4"})
    if status != 200:
        return report("trace ingest", False, f"HTTP {status}")
    while time.monotonic() - sent < 120:
        status, out = call("GET", f"/api/public/v2/observations?fields=core,basic,usage,io&traceId={trace_id}&fromStartTime={SINCE}")
        rows = out.get("data") if isinstance(out, dict) else None
        if rows:
            o = rows[0]
            ok = o["input"] == "Where is my order?" and o["usageDetails"].get("input") == 120
            return report("trace round trip", ok, f"readable after {time.monotonic() - sent:.1f} s; "
                          f"type {o['type']}, user {o['userId']}, usage {o['usageDetails']}, cost {o.get('totalCost')}")
        if status != 200:
            return report("trace round trip", False, f"HTTP {status}: {str(out)[:200]}")
        time.sleep(1)
    return report("trace round trip", False, "not readable after 120 s")


def probes() -> None:
    name = "smoke-" + secrets.token_hex(3)
    s, out = call("POST", "/api/public/v2/prompts", {"name": name, "type": "text", "prompt": "Hi {{x}}", "labels": ["production"]})
    report("create prompt", s in (200, 201), f"HTTP {s}")
    s, out = call("GET", f"/api/public/v2/prompts/{name}?label=production")
    report("get prompt by label", s == 200 and isinstance(out, dict) and out.get("prompt") == "Hi {{x}}", f"HTTP {s}")
    s, out = call("POST", "/api/public/v2/datasets", {"name": name})
    report("create dataset", s in (200, 201), f"HTTP {s}")
    s, out = call("POST", "/api/public/scores", {"name": "helpfulness", "value": 0.5, "dataType": "NUMERIC",
                                                  "sessionId": "s-1"})
    report("create score", s in (200, 201), f"HTTP {s}")
    for _ in range(30):
        s, out = call("GET", "/api/public/v3/scores?name=helpfulness&limit=5")
        if s == 200 and isinstance(out, dict) and out.get("data"):
            break
        time.sleep(1)
    report("list scores (v3)", s == 200 and bool(isinstance(out, dict) and out.get("data")), f"HTTP {s}, "
           f"{len(out.get('data', [])) if isinstance(out, dict) else '?'} rows")
    query = {"view": "observations", "metrics": [{"measure": "count", "aggregation": "count"}], "dimensions": [],
             "filters": [], "fromTimestamp": SINCE, "toTimestamp": (dt.datetime.now(dt.UTC) + dt.timedelta(hours=1)).isoformat()}
    s, out = call("GET", "/api/public/v2/metrics?query=" + urllib.request.quote(json.dumps(query)))
    report("metrics v2 (count observations)", s == 200, f"HTTP {s}: {str(out)[:160]}")
    s, out = call("POST", "/api/public/mcp", {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "smoke", "version": "0"}}})
    report("MCP initialize", s == 200, f"HTTP {s}: {str(out)[:120]}")


def main() -> int:
    ok = trace_round_trip()
    probes()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
