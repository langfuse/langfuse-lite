// One run of the official Langfuse JS SDK (v6) against a Langfuse server.
//
//   node test/js/scenario.mjs <base-url> <tag>     # base url must be localhost
//
// Same shape as test/scenario.py: an agent trace (agent, generation, tool,
// failing span), scores, a dataset experiment with item and run evaluators,
// and an experiment on local data. Prints a JSON manifest on stdout.

for (const k of Object.keys(process.env)) if (k.startsWith("LANGFUSE_") || k.startsWith("OTEL_")) delete process.env[k];
const [baseUrl, tag] = process.argv.slice(2);
if (!["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname)) {
  console.error(`refusing to write test data to ${baseUrl}: only localhost`);
  process.exit(1);
}

const { NodeTracerProvider } = await import("@opentelemetry/sdk-trace-node");
const { LangfuseSpanProcessor } = await import("@langfuse/otel");
const { startActiveObservation, propagateAttributes } = await import("@langfuse/tracing");
const { LangfuseClient } = await import("@langfuse/client");

const keys = { publicKey: "pk-lf-lite", secretKey: "sk-lf-lite", baseUrl };
const processor = new LangfuseSpanProcessor({ ...keys, exportMode: "immediate" });
const provider = new NodeTracerProvider({ spanProcessors: [processor] });
provider.register();
const langfuse = new LangfuseClient(keys);
const manifest = { tag };

await propagateAttributes(
  { userId: "user-7", sessionId: `session-${tag}`, tags: ["agent", "lite-test"], traceName: `support-agent-${tag}`, metadata: { team: "evals" } },
  () =>
    startActiveObservation(
      "agent",
      async (agent) => {
        agent.update({ input: { question: "Where is my refund?" } });
        await startActiveObservation(
          "plan",
          async (gen) => {
            gen.update({
              model: "gpt-4o",
              modelParameters: { temperature: 0.2 },
              input: [{ role: "user", content: "Where is my refund?" }],
              output: { role: "assistant", content: "Let me look it up." },
              usageDetails: { input: 1200, output: 80 },
            });
            manifest.generation_id = gen.id;
          },
          { asType: "generation" },
        );
        await startActiveObservation("lookup_refund", async (tool) => tool.update({ input: { order: "A-17" }, output: { status: "pending" } }), { asType: "tool" });
        await startActiveObservation("notify", async (s) => s.update({ level: "ERROR", statusMessage: "SMTP timeout" }));
        agent.update({ output: { answer: "Your refund is pending." } });
        manifest.agent_trace_id = agent.traceId;
      },
      { asType: "agent" },
    ),
);

langfuse.score.create({ name: "helpfulness", value: 0.8, traceId: manifest.agent_trace_id, comment: "clear answer" });
langfuse.score.create({ name: "resolved", value: "yes", dataType: "CATEGORICAL", traceId: manifest.agent_trace_id });
langfuse.score.create({ name: "escalated", value: 0, dataType: "BOOLEAN", traceId: manifest.agent_trace_id, observationId: manifest.generation_id });
langfuse.score.create({ name: "session_quality", value: 3, sessionId: `session-${tag}` });

const dsName = `capitals-${tag}`;
await langfuse.api.datasets.create({ name: dsName, description: "capital cities", metadata: { owner: "lite" } });
for (const [country, capital] of [["France", "Paris"], ["Japan", "Tokyo"], ["Peru", "Lima"]])
  await langfuse.api.datasetItems.create({ datasetName: dsName, input: { country }, expectedOutput: capital, metadata: { region: "x" } });
manifest.dataset = dsName;

const answers = { France: "Paris", Japan: "Kyoto", Peru: "Lima" };
const task = async (item) =>
  startActiveObservation(
    "answer",
    async (g) => {
      const out = answers[item.input.country];
      g.update({ model: "gpt-4o-mini", input: item.input.country, output: out, usageDetails: { input: 20, output: 3 } });
      return out;
    },
    { asType: "generation" },
  );
const exactMatch = async ({ output, expectedOutput }) => ({ name: "exact_match", value: output === expectedOutput ? 1 : 0 });
const accuracy = async ({ itemResults }) => {
  const v = itemResults.flatMap((r) => r.evaluations.filter((e) => e.name === "exact_match").map((e) => e.value));
  return { name: "accuracy", value: v.reduce((a, b) => a + b, 0) / v.length };
};

const dataset = await langfuse.dataset.get(dsName);
const result = await dataset.runExperiment({
  name: `capitals-exp-${tag}`, description: "baseline", task, evaluators: [exactMatch], runEvaluators: [accuracy], metadata: { model: "gpt-4o-mini" },
});
manifest.experiment_id = result.experimentId;
manifest.dataset_experiment_traces = result.itemResults.map((r) => r.traceId);

const local = await langfuse.experiment.run({
  name: `local-exp-${tag}`,
  data: [{ input: { country: "France" }, expectedOutput: "Paris" }, { input: { country: "Japan" }, expectedOutput: "Tokyo" }],
  task,
  evaluators: [exactMatch],
});
manifest.local_experiment_id = local.experimentId;
manifest.local_experiment_traces = local.itemResults.map((r) => r.traceId);

await langfuse.flush();
await processor.forceFlush();
await provider.shutdown();
await langfuse.shutdown();
console.log(JSON.stringify(manifest));
