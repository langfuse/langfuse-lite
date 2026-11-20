"""Demo data for langfuse-lite: agent traces and two comparable experiment runs.

    python test/demo.py http://127.0.0.1:3100      # localhost only

Uses the Langfuse Python SDK only (no LLM calls; outputs are scripted):
  - three support-agent traces with planning, retrieval, tool calls and one
    failing tool, with user, session, usage and cost
  - a dataset "support-tickets" made from those traces (items link back to them)
  - a dataset "refund-policy-qa" with 8 questions
  - two experiment runs on it, prompt v1 and prompt v2, each with an
    exact-match and a grounded evaluator plus a run-level accuracy score
"""
from __future__ import annotations

import os
import sys
import time
from urllib.parse import urlparse

for key in [k for k in os.environ if k.startswith(("LANGFUSE_", "OTEL_"))]:
    del os.environ[key]

from langfuse import Evaluation, Langfuse, propagate_attributes  # noqa: E402

base_url = sys.argv[1]
if urlparse(base_url).hostname not in ("127.0.0.1", "localhost"):
    sys.exit(f"refusing to write demo data to {base_url}: only localhost")
lf = Langfuse(public_key="pk-lf-local", secret_key="sk-lf-local", base_url=base_url)


def pause(ms: float):
    time.sleep(ms / 1000)


# --- agent traces --------------------------------------------------------------
tickets = [
    ("user-114", "Where is my refund for order A-1734?", "pending", None),
    ("user-208", "I was charged twice for my subscription.", "duplicate charge refunded", None),
    ("user-114", "Can you email me the receipt?", None, "SMTP timeout after 3 retries"),
]
ticket_traces = []
for i, (user, question, status, failure) in enumerate(tickets):
    with propagate_attributes(user_id=user, session_id=f"support-{user}", tags=["support-agent", "demo"],
                              trace_name="support-agent", metadata={"channel": "chat", "agent_version": "1.4.0"}):
        with lf.start_as_current_observation(name="support-agent", as_type="agent", input={"message": question}) as agent:
            with lf.start_as_current_observation(name="plan", as_type="generation", model="claude-sonnet-5-5",
                                                 model_parameters={"temperature": 0.2, "max_tokens": 1024},
                                                 input=[{"role": "system", "content": "You are a support agent for Acme Billing."},
                                                        {"role": "user", "content": question}]) as gen:
                pause(380 + 40 * i)
                gen.update(output={"role": "assistant", "content": "I'll check the billing system, then answer."},
                           usage_details={"input": 1830 + 90 * i, "output": 64})
            with lf.start_as_current_observation(name="search_help_center", as_type="retriever",
                                                 input={"query": question, "top_k": 3}) as ret:
                pause(70)
                ret.update(output=[{"doc": "refund-policy.md", "score": 0.91}, {"doc": "billing-faq.md", "score": 0.84}])
            tool_name = "send_email" if failure else "lookup_billing"
            with lf.start_as_current_observation(name=tool_name, as_type="tool", input={"user": user}) as tool:
                pause(140)
                if failure:
                    tool.update(level="ERROR", status_message=failure, output={"error": failure})
                else:
                    tool.update(output={"status": status})
            with lf.start_as_current_observation(name="answer", as_type="generation", model="claude-sonnet-5-5",
                                                 input=[{"role": "user", "content": question}]) as ans:
                pause(520)
                text = (f"I couldn't send the email ({failure}); here is the receipt link instead." if failure
                        else f"Your request is {status}. You'll see it on your statement within 5 business days.")
                ans.update(output={"role": "assistant", "content": text}, usage_details={"input": 2410 + 70 * i, "output": 96})
            agent.update(output={"reply": text})
            trace_id = agent.trace_id
            ticket_traces.append((trace_id, question, text))
    lf.create_score(name="resolved", value="no" if failure else "yes", data_type="CATEGORICAL", trace_id=trace_id)
    lf.create_score(name="helpfulness", value=0.4 if failure else 0.9, trace_id=trace_id,
                    comment="tool failed, offered a workaround" if failure else None)

# A dataset grown from production traces: each item points at its source trace.
lf.create_dataset(name="support-tickets", description="Real tickets from the support agent, kept as regression cases",
                  metadata={"owner": "support-team"})
for trace_id, question, reply in ticket_traces:
    lf.create_dataset_item(dataset_name="support-tickets", input={"message": question},
                           expected_output={"reply": reply}, source_trace_id=trace_id,
                           metadata={"from": "production"})

# --- dataset and two experiment runs ----------------------------------------------
questions = [
    ("How long do refunds take?", "5 business days"),
    ("Can I get a refund after 30 days?", "no"),
    ("Are digital purchases refundable?", "within 14 days"),
    ("Who pays return shipping?", "the customer"),
    ("Can I refund a gift card?", "no"),
    ("Do you refund partial months?", "yes, prorated"),
    ("How do I request a refund?", "from the orders page"),
    ("Is the restocking fee refundable?", "no"),
]
ds = "refund-policy-qa"
lf.create_dataset(name=ds, description="Questions about the Acme refund policy", metadata={"source": "help center"})
for q, a in questions:
    lf.create_dataset_item(dataset_name=ds, input={"question": q}, expected_output=a)

answers = {
    "v1": ["5 business days", "yes", "within 14 days", "Acme", "no", "no", "from the orders page", "yes"],
    "v2": ["5 business days", "no", "within 14 days", "the customer", "no", "yes, prorated", "from the orders page", "yes"],
}


def make_task(version: str):
    def task(*, item, **_):
        q = item.input["question"]
        idx = [x for x, _ in questions].index(q)
        with lf.start_as_current_observation(name="answer-question", as_type="generation", model="claude-haiku-5-5",
                                             model_parameters={"prompt_version": version},
                                             input=[{"role": "user", "content": q}]) as g:
            pause(60 + (idx % 3) * 25 if version == "v1" else 90 + (idx % 3) * 30)
            out = answers[version][idx]
            g.update(output=out, usage_details={"input": 420 if version == "v1" else 610, "output": 12})
        return out
    return task


def exact_match(*, output, expected_output, **_):
    return Evaluation(name="exact_match", value=1.0 if output == expected_output else 0.0)


def grounded(*, output, **_):
    return Evaluation(name="grounded", value=0.0 if output == "Acme" else 1.0,
                      comment="answer not in the policy" if output == "Acme" else None)


def accuracy(*, item_results, **_):
    values = [e.value for r in item_results for e in r.evaluations if e.name == "exact_match"]
    return Evaluation(name="accuracy", value=sum(values) / len(values))


dataset = lf.get_dataset(ds)
for version, description in [("v1", "baseline prompt"), ("v2", "prompt with policy excerpts")]:
    dataset.run_experiment(name=f"refund-qa-{version}", description=description, task=make_task(version),
                           evaluators=[exact_match, grounded], run_evaluators=[accuracy],
                           metadata={"prompt_version": version, "model": "claude-haiku-5-5"}, max_concurrency=4)

lf.flush()
lf.shutdown()
print("demo data written")
