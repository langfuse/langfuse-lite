"""Check langfuse-lite against the agent-testing usage suite, without running agents.

    python scripts/check_usage_suite.py --agent-testing ../coding-agent-testing

Uses that repo's own seeding, fixture and state checks unchanged
(sidecars/langfuse-proxy and fixtures/langfuse), so lite gets exactly what a
Cloud usage trial gets:

1. Seed the support-desk-v1 fixture: score configs, prompts, ~100 traces over
   OTLP, scores through the ingestion API. Time until everything is queryable.
2. Read tasks: ask the public API each task's ground-truth question and compare
   with the fixture's known answer.
3. Write tasks: perform each task's correct action through the API, then run
   the suite's state checks, including the collateral-write check.
4. MCP: list tools and call a few, as an agent with MCP access would.

Run it against a freshly started instance (scripts/start.sh --fresh), because
the fixture's answers assume an otherwise empty project.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import sys
import time
import urllib.parse
from collections import Counter, defaultdict
from pathlib import Path

BASE = "http://127.0.0.1:3000"
KEYS = ("pk-lf-lite", "sk-lf-lite")
RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f": {detail}" if detail else ""), flush=True)
    return ok


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--agent-testing", type=Path, required=True, help="path to the coding-agent-testing repo")
    args = p.parse_args()
    repo = args.agent_testing.resolve()
    sys.path[:0] = [str(repo / "sidecars/langfuse-proxy"), str(repo / "fixtures/langfuse")]
    import checks  # noqa: E402 - from the agent-testing repo
    import lf_http as http  # noqa: E402
    import seed  # noqa: E402
    from project import SandboxProject  # noqa: E402

    project = SandboxProject("lite-project", "lite", BASE, *KEYS)
    catalog = {i["metadata"]["slug"]: i for i in json.loads((repo / "suites/usage/catalog.json").read_text())["items"]}

    # 1. Seed -------------------------------------------------------------------
    started = time.monotonic()
    truth = seed.seed(project, timeout_s=300)
    check("seed support-desk-v1", True, f"{truth['observation_count']} observations, {truth['score_count']} scores "
          f"queryable after {time.monotonic() - started:.1f} s")

    with project.client() as c:
        now = dt.datetime.now(dt.UTC)
        iso = lambda t: t.strftime("%Y-%m-%dT%H:%M:%S.000Z")  # noqa: E731
        obs = http.paged(c, "/api/public/v2/observations", limit=1000, fields="core,basic,usage,io,metadata",
                         fromStartTime=iso(now - dt.timedelta(days=60)))
        prod7 = [o for o in obs if o["environment"] == "production"
                 and dt.datetime.fromisoformat(o["startTime"].replace("Z", "+00:00")) > now - dt.timedelta(days=7)]

        def metrics(query: dict) -> list[dict]:
            return http.get_json(c, "/api/public/v2/metrics", query=json.dumps(query))["data"]

        # 2. Read tasks ---------------------------------------------------------
        names = sorted({o["traceName"] for o in obs if o.get("traceName")} | {o["name"] for o in obs if not o.get("parentObservationId")})
        check("orient-project-overview: traced applications", set(truth["trace_names"]) <= set(names), f"{names}")

        failing = [o for o in prod7 if o["level"] == "ERROR"]
        steps = Counter(o["name"] for o in failing)
        errors = Counter(o.get("statusMessage") or "" for o in failing)
        check("debug-refund-failures: failing step and count",
              set(steps) == {"issue-refund"} and len({o["traceId"] for o in failing}) == len(truth["refund_failures"]),
              f"{dict(steps)}, {len({o['traceId'] for o in failing})} traces (truth {len(truth['refund_failures'])}), "
              f"error {list(errors)[0][:60]!r}")

        u042 = [o for o in obs if o.get("userId") == "u-042"]
        slowest = max((o for o in u042 if o.get("parentObservationId")), key=lambda o: o["latency"] or 0, default=None)
        check("slow-session-u042: slowest step", bool(slowest) and slowest["name"] == truth["slow_step"],
              f"{slowest['name'] if slowest else None} ({slowest['latency'] if slowest else '?'} s)")

        window = {"fromTimestamp": iso(now - dt.timedelta(days=7)), "toTimestamp": iso(now + dt.timedelta(hours=1))}
        cost = metrics({"view": "observations", "dimensions": [{"field": "userId"}],
                        "metrics": [{"measure": "totalCost", "aggregation": "sum"}],
                        "filters": [{"column": "environment", "operator": "=", "value": "production", "type": "string"}],
                        # userId is high-cardinality: Langfuse requires a row limit and a descending order.
                        "orderBy": [{"field": "sum_totalCost", "direction": "desc"}], "config": {"row_limit": 10},
                        **window})
        top = max(cost, key=lambda r: r.get("sum_totalCost") or 0)
        check("cost-top-user-production: metrics API", top["userId"] == truth["top_cost_user"]
              and abs(top["sum_totalCost"] - truth["top_cost_usd"]) < 0.01, f"{top}")

        calls = metrics({"view": "observations", "dimensions": [], "metrics": [{"measure": "count", "aggregation": "count"}],
                         "filters": [{"column": "providedModelName", "operator": "=", "value": "claude-sonnet-4-6", "type": "string"}],
                         "fromTimestamp": iso(now - dt.timedelta(days=30)), "toTimestamp": window["toTimestamp"]})
        n = int(calls[0]["count_count"]) if calls else 0
        check("count-model-calls-30d: metrics API", n == truth["sonnet_calls_30d"], f"{n} (truth {truth['sonnet_calls_30d']})")

        scores = http.paged(c, "/api/public/v3/scores", limit=100, fields="core,details,subject", name="helpfulness")
        recent = [s for s in scores if dt.datetime.fromisoformat(s["timestamp"].replace("Z", "+00:00")) > now - dt.timedelta(days=7)]
        lowest = sorted(recent, key=lambda s: s.get("value") or 0)[:len(truth["lowest_helpfulness"])]
        low_traces = {checks._score_trace(s) for s in lowest}
        check("low-helpfulness-theme: lowest scores", low_traces == set(truth["lowest_helpfulness"]),
              f"{len(low_traces & set(truth['lowest_helpfulness']))}/{len(truth['lowest_helpfulness'])} traces match")

        prod = http.get_json(c, "/api/public/v2/prompts/support-system", label="production")
        latest = http.get_json(c, "/api/public/v2/prompts/support-system", label="latest")
        want = truth["prompts"]["support-system"]
        check("prompt-production-vs-latest: labels", (prod["version"], latest["version"]) == (want["production"], want["latest"])
              and "SORRY10" in checks._prompt_text(latest) and "SORRY10" not in checks._prompt_text(prod),
              f"production v{prod['version']}, latest v{latest['version']}")

        # 3. Write tasks: the correct action, then the suite's own state checks ------
        before = checks.snapshot(c)
        configs = truth["score_config_ids"]
        for trace_id in truth["handoffs"]:
            http.request(c, "POST", "/api/public/scores", json={"traceId": trace_id, "name": "resolution",
                         "value": "escalated", "dataType": "CATEGORICAL", "configId": configs["resolution"]})
        http.request(c, "POST", "/api/public/v2/datasets", json={"name": "refund-failures"})
        for trace_id in truth["refund_failures"]:
            http.request(c, "POST", "/api/public/dataset-items", json={"datasetName": "refund-failures",
                         "input": {"trace": trace_id}, "sourceTraceId": trace_id})
        policy = http.get_json(c, "/api/public/v2/prompts/refund-policy", label="production")
        http.request(c, "POST", "/api/public/v2/prompts", json={
            "name": "refund-policy", "type": "text", "labels": ["production"],
            "prompt": checks._prompt_text(policy) + " Refunds above {{max_refund}} must be escalated to a human agent."})
        prod_filter = [{"column": "environment", "operator": "any of", "value": ["production"], "type": "stringOptions"}]
        widget_ids = []
        for name, metric in (("Total LLM cost per day", {"measure": "totalCost", "agg": "sum"}),
                             ("Traces per day", {"measure": "count", "agg": "count"}),
                             ("p95 latency of LLM calls", {"measure": "latency", "agg": "p95"})):
            w = http.request(c, "POST", "/api/public/unstable/dashboard-widgets", json={
                "name": name, "description": "", "view": "observations", "dimensions": [], "metrics": [metric],
                "filters": prod_filter, "chartType": "LINE_TIME_SERIES"}).json()
            widget_ids.append(w["id"])
        dash = http.request(c, "POST", "/api/public/unstable/dashboards", json={
            "name": "Support desk health", "description": "production"}).json()
        for i, widget_id in enumerate(widget_ids):
            http.request(c, "POST", f"/api/public/unstable/dashboards/{dash['id']}/placements", json={
                "type": "widget", "widgetId": widget_id, "x": (i % 2) * 6, "y": (i // 2) * 6, "width": 6, "height": 6})
        time.sleep(5)
        after = checks.snapshot(c)
        for slug in ("score-handoffs", "dataset-from-failed-refunds", "prompt-new-production-version", "dashboard-support-health"):
            expected = catalog[slug]["expected_output"]
            for attempt in range(20):  # scores are ingested asynchronously
                result = checks.evaluate_state(expected, truth, c, before=before, after=checks.snapshot(c))
                if all(r["passed"] for r in result["checks"]):
                    break
                time.sleep(3)
            details = "; ".join(f"{r['check']}: {r['detail']}" for r in result["checks"])
            check(f"{slug}: state checks", all(r["passed"] for r in result["checks"]), details)
        collateral = checks.collateral(before, after, checks.allowed_changes(
            [sc for slug in catalog for sc in catalog[slug]["expected_output"].get("state_checks") or []]))
        check("write tasks: no collateral writes", not collateral, "; ".join(collateral) or "none")

        # 4. MCP ------------------------------------------------------------------
        def mcp(method: str, params: dict | None = None):
            r = c.post("/api/public/mcp", json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}},
                       headers={"Accept": "application/json, text/event-stream"})
            text = r.text
            if text.startswith("event:") or "\ndata:" in text or text.startswith("data:"):
                text = "\n".join(line[5:] for line in text.splitlines() if line.startswith("data:"))
            return r.status_code, json.loads(text) if text.strip() else {}

        status, init = mcp("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                          "clientInfo": {"name": "check", "version": "0"}})
        status, tools = mcp("tools/list")
        names = [t["name"] for t in tools.get("result", {}).get("tools", [])]
        check("MCP tools/list", status == 200 and len(names) > 20, f"{len(names)} tools")
        for tool, arguments, must in [
            ("listObservations", {"fromStartTime": iso(now - dt.timedelta(days=7)), "toStartTime": iso(now + dt.timedelta(hours=1)),
                                  "level": "ERROR", "limit": 50}, "issue-refund"),
            ("getPrompt", {"name": "support-system", "label": "production"}, "Never share internal order notes"),
            ("listScoreConfigs", {}, "resolution"),
        ]:
            if tool not in names:
                check(f"MCP {tool}", False, "tool not listed")
                continue
            status, out = mcp("tools/call", {"name": tool, "arguments": arguments})
            text = json.dumps(out)
            check(f"MCP {tool}", status == 200 and must in text and not out.get("result", {}).get("isError"),
                  f"HTTP {status}, {len(text)} bytes" + ("" if must in text else f", missing {must!r}: {text[:200]}"))

    failed = [name for name, ok, _ in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed" + (f"; failed: {', '.join(failed)}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
