"""One run of the official Langfuse Python SDK against a Langfuse server.

    python test/scenario.py <base-url> <tag>     # base url must be localhost

Writes, through the SDK only:
  - an agent-style trace: a root agent span, a generation with model, usage and
    model parameters, a tool call, a failing step, user, session, tags, metadata
  - a dataset with three items, and an experiment on it with an item-level and
    a run-level evaluator
  - an experiment on local data (no dataset)
  - a score on the agent trace

Prints a JSON manifest (ids and names) on stdout for test/conformance.py.
<tag> keeps names unique per run.
"""
from __future__ import annotations

import json
import os
import sys
from urllib.parse import urlparse

# Never inherit Langfuse settings from the environment: this script writes test
# data and must only ever reach a local server.
for key in [k for k in os.environ if k.startswith(("LANGFUSE_", "OTEL_"))]:
    del os.environ[key]

from langfuse import Evaluation, Langfuse, propagate_attributes  # noqa: E402

base_url, tag = sys.argv[1], sys.argv[2]
if urlparse(base_url).hostname not in ("127.0.0.1", "localhost"):
    sys.exit(f"refusing to write test data to {base_url}: only localhost")
lf = Langfuse(public_key="pk-lf-lite", secret_key="sk-lf-lite", base_url=base_url)
assert lf.auth_check(), "auth_check failed"
manifest: dict = {"tag": tag}

# --- agent trace ------------------------------------------------------------
with propagate_attributes(user_id="user-7", session_id=f"session-{tag}", tags=["agent", "lite-test"],
                          trace_name=f"support-agent-{tag}", metadata={"team": "evals"}):
    with lf.start_as_current_observation(name="agent", as_type="agent", input={"question": "Where is my refund?"}) as agent:
        with lf.start_as_current_observation(
            name="plan", as_type="generation", model="gpt-4o",
            model_parameters={"temperature": 0.2},
            input=[{"role": "user", "content": "Where is my refund?"}],
        ) as gen:
            gen.update(output={"role": "assistant", "content": "Let me look it up."},
                       usage_details={"input": 1200, "output": 80})
        with lf.start_as_current_observation(name="lookup_refund", as_type="tool", input={"order": "A-17"}) as tool:
            tool.update(output={"status": "pending"})
        with lf.start_as_current_observation(name="notify", as_type="span") as failing:
            failing.update(level="ERROR", status_message="SMTP timeout")
        agent.update(output={"answer": "Your refund is pending."})
        manifest["agent_trace_id"] = agent.trace_id
        manifest["generation_id"] = gen.id

lf.create_score(name="helpfulness", value=0.8, trace_id=manifest["agent_trace_id"], comment="clear answer")
lf.create_score(name="resolved", value="yes", data_type="CATEGORICAL", trace_id=manifest["agent_trace_id"])
lf.create_score(name="escalated", value=0, data_type="BOOLEAN", trace_id=manifest["agent_trace_id"],
                observation_id=manifest["generation_id"])
lf.create_score(name="session_quality", value=3, session_id=f"session-{tag}")

# --- an agent framework's own OTel spans (no Langfuse SDK) --------------------
# GenAI semantic conventions, as OpenInference / OpenLLMetry / custom agents send them.
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter  # noqa: E402
from opentelemetry.sdk.resources import Resource  # noqa: E402
from opentelemetry.sdk.trace import TracerProvider  # noqa: E402
from opentelemetry.sdk.trace.export import SimpleSpanProcessor  # noqa: E402
from opentelemetry.trace import Status, StatusCode  # noqa: E402

provider = TracerProvider(resource=Resource.create({"service.name": "my-agent", "service.version": "1.2.3"}))
provider.add_span_processor(SimpleSpanProcessor(OTLPSpanExporter(
    endpoint=f"{base_url}/api/public/otel/v1/traces",
    headers={"Authorization": "Basic " + __import__("base64").b64encode(b"pk-lf-lite:sk-lf-lite").decode()})))
tracer = provider.get_tracer("my-agent-framework", "0.9")
with tracer.start_as_current_span("invoke_agent support-bot") as root:
    root.set_attribute("gen_ai.operation.name", "invoke_agent")
    root.set_attribute("gen_ai.agent.name", "support-bot")
    root.set_attribute("session.id", f"otel-session-{tag}")
    with tracer.start_as_current_span("chat claude-sonnet-5-5") as chat:
        chat.set_attribute("gen_ai.operation.name", "chat")
        chat.set_attribute("gen_ai.system", "anthropic")
        chat.set_attribute("gen_ai.request.model", "claude-sonnet-5-5")
        chat.set_attribute("gen_ai.request.temperature", 0.0)
        chat.set_attribute("gen_ai.usage.input_tokens", 950)
        chat.set_attribute("gen_ai.usage.output_tokens", 120)
        chat.set_attribute("gen_ai.input.messages", json.dumps([{"role": "user", "parts": [{"type": "text", "content": "Reset my password"}]}]))
        chat.set_attribute("gen_ai.output.messages", json.dumps([{"role": "assistant", "parts": [{"type": "text", "content": "Done."}]}]))
    with tracer.start_as_current_span("execute_tool reset_password") as tool:
        tool.set_attribute("gen_ai.operation.name", "execute_tool")
        tool.set_attribute("gen_ai.tool.name", "reset_password")
        tool.set_status(Status(StatusCode.ERROR, "rate limited"))
    manifest["otel_trace_id"] = format(root.get_span_context().trace_id, "032x")
provider.shutdown()

# --- dataset experiment -----------------------------------------------------
ds_name = f"capitals-{tag}"
lf.create_dataset(name=ds_name, description="capital cities", metadata={"owner": "lite"})
for country, capital in [("France", "Paris"), ("Japan", "Tokyo"), ("Peru", "Lima")]:
    lf.create_dataset_item(dataset_name=ds_name, input={"country": country},
                           expected_output=capital, metadata={"region": "x"})
manifest["dataset"] = ds_name


def task(*, item, **_):
    country = item["input"]["country"] if isinstance(item, dict) else item.input["country"]
    answers = {"France": "Paris", "Japan": "Kyoto", "Peru": "Lima"}
    with lf.start_as_current_observation(name="answer", as_type="generation", model="gpt-4o-mini",
                                         input=country) as g:
        g.update(output=answers[country], usage_details={"input": 20, "output": 3})
    return answers[country]


def exact_match(*, output, expected_output, **_):
    return Evaluation(name="exact_match", value=1.0 if output == expected_output else 0.0)


def accuracy(*, item_results, **_):
    values = [e.value for r in item_results for e in r.evaluations if e.name == "exact_match"]
    return Evaluation(name="accuracy", value=sum(values) / len(values))


dataset = lf.get_dataset(ds_name)
result = dataset.run_experiment(name=f"capitals-exp-{tag}", description="baseline", task=task,
                                evaluators=[exact_match], run_evaluators=[accuracy],
                                metadata={"model": "gpt-4o-mini"})
manifest["experiment_id"] = result.experiment_id
manifest["experiment_run_name"] = result.run_name
manifest["dataset_experiment_traces"] = [r.trace_id for r in result.item_results]

# --- local-data experiment --------------------------------------------------
local = lf.run_experiment(
    name=f"local-exp-{tag}",
    data=[{"input": {"country": "France"}, "expected_output": "Paris"},
          {"input": {"country": "Japan"}, "expected_output": "Tokyo"}],
    task=task, evaluators=[exact_match],
)
manifest["local_run_name"] = local.run_name
manifest["local_experiment_traces"] = [r.trace_id for r in local.item_results]
manifest["local_experiment_id"] = getattr(local, "experiment_id", None) or getattr(local, "dataset_run_id", None)

lf.flush()
lf.shutdown()
print(json.dumps(manifest))
