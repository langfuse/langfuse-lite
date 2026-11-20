"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AI_FEATURE_OTEL_SDK_NAME = exports.LangfuseOtelSpanAttributes = void 0;
exports.buildEvaluationAttributes = buildEvaluationAttributes;
var LangfuseOtelSpanAttributes;
(function (LangfuseOtelSpanAttributes) {
    // Langfuse-Trace attributes
    LangfuseOtelSpanAttributes["TRACE_NAME"] = "langfuse.trace.name";
    LangfuseOtelSpanAttributes["TRACE_USER_ID"] = "user.id";
    LangfuseOtelSpanAttributes["TRACE_SESSION_ID"] = "session.id";
    LangfuseOtelSpanAttributes["TRACE_TAGS"] = "langfuse.trace.tags";
    LangfuseOtelSpanAttributes["TRACE_PUBLIC"] = "langfuse.trace.public";
    LangfuseOtelSpanAttributes["TRACE_METADATA"] = "langfuse.trace.metadata";
    LangfuseOtelSpanAttributes["TRACE_INPUT"] = "langfuse.trace.input";
    LangfuseOtelSpanAttributes["TRACE_OUTPUT"] = "langfuse.trace.output";
    // Langfuse-observation attributes
    LangfuseOtelSpanAttributes["OBSERVATION_TYPE"] = "langfuse.observation.type";
    LangfuseOtelSpanAttributes["OBSERVATION_METADATA"] = "langfuse.observation.metadata";
    LangfuseOtelSpanAttributes["OBSERVATION_LEVEL"] = "langfuse.observation.level";
    LangfuseOtelSpanAttributes["OBSERVATION_STATUS_MESSAGE"] = "langfuse.observation.status_message";
    LangfuseOtelSpanAttributes["OBSERVATION_INPUT"] = "langfuse.observation.input";
    LangfuseOtelSpanAttributes["OBSERVATION_OUTPUT"] = "langfuse.observation.output";
    LangfuseOtelSpanAttributes["OBSERVATION_SKILLS_AVAILABLE"] = "langfuse.observation.skills_available";
    // Langfuse-observation of type Generation attributes
    LangfuseOtelSpanAttributes["OBSERVATION_COMPLETION_START_TIME"] = "langfuse.observation.completion_start_time";
    LangfuseOtelSpanAttributes["OBSERVATION_MODEL"] = "langfuse.observation.model.name";
    LangfuseOtelSpanAttributes["OBSERVATION_MODEL_PARAMETERS"] = "langfuse.observation.model.parameters";
    LangfuseOtelSpanAttributes["OBSERVATION_USAGE_DETAILS"] = "langfuse.observation.usage_details";
    LangfuseOtelSpanAttributes["OBSERVATION_COST_DETAILS"] = "langfuse.observation.cost_details";
    LangfuseOtelSpanAttributes["OBSERVATION_PROMPT_NAME"] = "langfuse.observation.prompt.name";
    LangfuseOtelSpanAttributes["OBSERVATION_PROMPT_VERSION"] = "langfuse.observation.prompt.version";
    //   General
    LangfuseOtelSpanAttributes["ENVIRONMENT"] = "langfuse.environment";
    LangfuseOtelSpanAttributes["RELEASE"] = "langfuse.release";
    LangfuseOtelSpanAttributes["VERSION"] = "langfuse.version";
    // Internal
    LangfuseOtelSpanAttributes["AS_ROOT"] = "langfuse.internal.as_root";
    LangfuseOtelSpanAttributes["IS_APP_ROOT"] = "langfuse.internal.is_app_root";
    // Compatibility - Map properties that were documented in https://langfuse.com/docs/opentelemetry/get-started#property-mapping,
    // but have a new assignment
    LangfuseOtelSpanAttributes["TRACE_COMPAT_USER_ID"] = "langfuse.user.id";
    LangfuseOtelSpanAttributes["TRACE_COMPAT_SESSION_ID"] = "langfuse.session.id";
    // Experiment attributes
    LangfuseOtelSpanAttributes["EXPERIMENT_ID"] = "langfuse.experiment.id";
    LangfuseOtelSpanAttributes["EXPERIMENT_NAME"] = "langfuse.experiment.name";
    LangfuseOtelSpanAttributes["EXPERIMENT_METADATA"] = "langfuse.experiment.metadata";
    LangfuseOtelSpanAttributes["EXPERIMENT_DESCRIPTION"] = "langfuse.experiment.description";
    LangfuseOtelSpanAttributes["EXPERIMENT_DATASET_ID"] = "langfuse.experiment.dataset.id";
    LangfuseOtelSpanAttributes["EXPERIMENT_ITEM_ID"] = "langfuse.experiment.item.id";
    LangfuseOtelSpanAttributes["EXPERIMENT_ITEM_VERSION"] = "langfuse.experiment.item.version";
    LangfuseOtelSpanAttributes["EXPERIMENT_ITEM_METADATA"] = "langfuse.experiment.item.metadata";
    LangfuseOtelSpanAttributes["EXPERIMENT_ITEM_ROOT_OBSERVATION_ID"] = "langfuse.experiment.item.root_observation_id";
    LangfuseOtelSpanAttributes["EXPERIMENT_ITEM_EXPECTED_OUTPUT"] = "langfuse.experiment.item.expected_output";
    // Evaluator execution attributes
    LangfuseOtelSpanAttributes["EVALUATOR_ID"] = "langfuse.evaluator.id";
    LangfuseOtelSpanAttributes["EVALUATION_RULE_ID"] = "langfuse.evaluation.rule.id";
    LangfuseOtelSpanAttributes["EVALUATOR_EXECUTION_IS_TEST"] = "langfuse.evaluator.execution.is_test";
})(LangfuseOtelSpanAttributes || (exports.LangfuseOtelSpanAttributes = LangfuseOtelSpanAttributes = {}));
function buildEvaluationAttributes(evaluationContext) {
    return {
        ...(evaluationContext.evaluatorId
            ? {
                [LangfuseOtelSpanAttributes.EVALUATOR_ID]: evaluationContext.evaluatorId,
            }
            : {}),
        ...(evaluationContext.evaluationRuleId
            ? {
                [LangfuseOtelSpanAttributes.EVALUATION_RULE_ID]: evaluationContext.evaluationRuleId,
            }
            : {}),
        [LangfuseOtelSpanAttributes.EVALUATOR_EXECUTION_IS_TEST]: evaluationContext.evaluatorExecutionIsTest,
    };
}
/** SDK name for internally published AI-feature product traces. */
exports.AI_FEATURE_OTEL_SDK_NAME = "langfuse-internal-ai-features";
