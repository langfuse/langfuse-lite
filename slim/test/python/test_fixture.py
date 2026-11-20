"""The pytest fixture from the langfuse-lite wheel, with the real Langfuse SDK."""
import json

from langfuse import Evaluation, Langfuse


def test_experiment_is_recorded(langfuse_lite_env):
    lf = Langfuse()  # reads LANGFUSE_* set by the fixture
    result = lf.run_experiment(
        name="fixture-exp",
        data=[{"input": 2, "expected_output": 4}, {"input": 3, "expected_output": 9}],
        task=lambda *, item, **_: item["input"] * 2,
        evaluators=[lambda *, output, expected_output, **_: Evaluation(name="correct", value=float(output == expected_output))],
    )
    lf.flush()
    runs = json.loads(langfuse_lite_env.cli("runs", "--json"))
    assert runs[0]["name"].startswith("fixture-exp")
    assert runs[0]["items"] == 2
    assert runs[0]["scores"] == {"correct": 0.5}
    assert result.item_results[0].trace_id in langfuse_lite_env.cli("traces")
