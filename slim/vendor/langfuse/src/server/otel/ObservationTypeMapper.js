"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ObservationTypeMapperRegistry = void 0;
exports.isClaudeManagedAgentSessionCreation = isClaudeManagedAgentSessionCreation;
exports.isClaudeManagedAgentSpan = isClaudeManagedAgentSpan;
const attributes_1 = require("./attributes");
const __1 = require("../../");
class SimpleAttributeMapper {
    name;
    priority;
    attributeKey;
    mappings;
    constructor(name, priority, attributeKey, mappings) {
        this.name = name;
        this.priority = priority;
        this.attributeKey = attributeKey;
        this.mappings = mappings;
    }
    canMap(attributes, _resourceAttributes, _scopeData, _spanName) {
        return (this.attributeKey in attributes &&
            hasMeaningfulValue(attributes[this.attributeKey]));
    }
    mapToObservationType(attributes, _resourceAttributes, _scopeData, _spanName) {
        const value = attributes[this.attributeKey];
        const mappedType = this.mappings[value];
        if (mappedType &&
            __1.ObservationTypeDomain.safeParse(mappedType.toUpperCase()).success) {
            return mappedType;
        }
        return null;
    }
}
/**
 * Mapper allowing for conditional logic, multiple attribute checks
 */
class CustomAttributeMapper {
    name;
    priority;
    canMapFn;
    mapFn;
    constructor(name, priority, canMapFn, mapFn) {
        this.name = name;
        this.priority = priority;
        this.canMapFn = canMapFn;
        this.mapFn = mapFn;
    }
    canMap(attributes, resourceAttributes, scopeData, spanName) {
        return this.canMapFn(attributes, resourceAttributes, scopeData, spanName);
    }
    mapToObservationType(attributes, resourceAttributes, scopeData, spanName) {
        const result = this.mapFn(attributes, resourceAttributes, scopeData, spanName);
        if (result &&
            typeof result === "string" &&
            __1.ObservationTypeDomain.safeParse(result.toUpperCase()).success) {
            return result;
        }
        return null;
    }
}
// value is not null, undefined, empty string, or empty object/array
function hasMeaningfulValue(value) {
    if (value === null || value === undefined || value === "") {
        return false;
    }
    if (Array.isArray(value)) {
        return value.length > 0;
    }
    if (typeof value === "object" && value !== null) {
        return Object.keys(value).length > 0;
    }
    return true;
}
// for Vercel AI SDK checks attributes operation.name with startsWith and ai.operationId with equals
function matchesVercelAiSdkOperation(attributes, prefixes) {
    const operationName = attributes["operation.name"];
    const operationId = attributes["ai.operationId"];
    if (hasMeaningfulValue(operationName)) {
        const opNameStr = operationName;
        if (prefixes.some((prefix) => opNameStr.startsWith(prefix))) {
            return true;
        }
    }
    if (hasMeaningfulValue(operationId)) {
        const opIdStr = operationId;
        if (prefixes.includes(opIdStr)) {
            return true;
        }
    }
    return false;
}
/**
 * Registry to manage observation type mappers with a unified interface to map
 * span attributes to observation types.
 *
 * Mappers are evaluated in priority order (lower number = higher priority).
 *
 * **NOTE**: This is the constructor to modify if you want to add new mappings.
 */
class ObservationTypeMapperRegistry {
    mappers = [
        // Priority 0: Python SDK <= 3.3.0 override
        // If generation-like attributes are set even though observation type is span, override to 'generation'
        // Issue: https://github.com/langfuse/langfuse/issues/8682
        // Affected SDK versions: Python SDK <= 3.3.0
        new CustomAttributeMapper("PythonSDKv330Override", 0, // Priority
        // canMap?
        (attributes, resourceAttributes, scopeData) => {
            return (attributes[attributes_1.LangfuseOtelSpanAttributes.OBSERVATION_TYPE] === "span" &&
                scopeData?.name === "langfuse-sdk" &&
                resourceAttributes?.["telemetry.sdk.language"] === "python");
        }, 
        // map!
        (attributes, resourceAttributes, scopeData) => {
            // Check version <= 3.3.0
            const scopeVersion = scopeData?.version;
            if (scopeVersion) {
                const [major, minor] = scopeVersion.split(".").map(Number);
                if (major > 3 || (major === 3 && minor > 3)) {
                    return null;
                }
            }
            // Check for generation-like attributes
            const generationKeys = [
                attributes_1.LangfuseOtelSpanAttributes.OBSERVATION_MODEL,
                attributes_1.LangfuseOtelSpanAttributes.OBSERVATION_COST_DETAILS,
                attributes_1.LangfuseOtelSpanAttributes.OBSERVATION_USAGE_DETAILS,
                attributes_1.LangfuseOtelSpanAttributes.OBSERVATION_COMPLETION_START_TIME,
                attributes_1.LangfuseOtelSpanAttributes.OBSERVATION_MODEL_PARAMETERS,
                attributes_1.LangfuseOtelSpanAttributes.OBSERVATION_PROMPT_NAME,
                attributes_1.LangfuseOtelSpanAttributes.OBSERVATION_PROMPT_VERSION,
            ];
            const hasGenerationAttributes = Object.keys(attributes).some((key) => generationKeys.includes(key));
            if (hasGenerationAttributes) {
                return "GENERATION";
            }
            return null;
        }),
        // Priority 1: maps langfuse.observation.type directly
        new SimpleAttributeMapper("LangfuseObservationTypeDirectMapping", 1, attributes_1.LangfuseOtelSpanAttributes.OBSERVATION_TYPE, {
            span: "SPAN",
            generation: "GENERATION",
            event: "EVENT",
            embedding: "EMBEDDING",
            agent: "AGENT",
            tool: "TOOL",
            chain: "CHAIN",
            retriever: "RETRIEVER",
            guardrail: "GUARDRAIL",
            evaluator: "EVALUATOR",
        }),
        // Priority 2: OpenInference span kind
        new SimpleAttributeMapper("OpenInference", 2, "openinference.span.kind", {
            // Format:
            // OpenInference Value: Langfuse ObservationType
            CHAIN: "CHAIN",
            RETRIEVER: "RETRIEVER",
            LLM: "GENERATION",
            EMBEDDING: "EMBEDDING",
            AGENT: "AGENT",
            TOOL: "TOOL",
            GUARDRAIL: "GUARDRAIL",
            EVALUATOR: "EVALUATOR",
        }),
        // Priority 3: OpenTelemetry GenAI operation
        new SimpleAttributeMapper("OTel_GenAI_Operation", 3, "gen_ai.operation.name", {
            // Format:
            // GenAI Value: Langfuse ObservationType
            chat: "GENERATION",
            // completion was used historically (keeping it for backward compatibility), text_completion is per spec as of 2025-12-04
            completion: "GENERATION",
            text_completion: "GENERATION",
            generate_content: "GENERATION",
            generate: "GENERATION",
            embeddings: "EMBEDDING",
            invoke_agent: "AGENT",
            create_agent: "AGENT",
            execute_tool: "TOOL",
        }),
        // Priority 4: Genkit subtype
        new SimpleAttributeMapper("Genkit", 4, "genkit:metadata:subtype", {
            // Format:
            // Genkit Value: Langfuse ObservationType
            "background-model": "GENERATION",
            model: "GENERATION",
            embedder: "EMBEDDING",
            tool: "TOOL",
            "tool.v2": "TOOL",
            retriever: "RETRIEVER",
            evaluator: "EVALUATOR",
        }),
        // Priority 5: Vercel AI SDK generation/embedding operations (require model information)
        new CustomAttributeMapper(
        // NAME
        "Vercel_AI_SDK_Operation_Generation_Like", 
        // PRIORITY
        5, 
        // CANMAP?
        (attributes) => {
            const modelKeys = [
                attributes_1.LangfuseOtelSpanAttributes.OBSERVATION_MODEL,
                "ai.model.id",
                "gen_ai.request.model",
                "gen_ai.response.model",
            ];
            const hasModelInformation = modelKeys.some((key) => hasMeaningfulValue(attributes[key]));
            // Only handle generation and embedding operations
            const generationEmbeddingPrefixes = [
                "ai.generateText.doGenerate",
                "ai.streamText.doStream",
                "ai.generateObject.doGenerate",
                "ai.streamObject.doStream",
                "ai.embedMany.doEmbed",
                "ai.embed.doEmbed",
            ];
            const isGenerationOrEmbedding = matchesVercelAiSdkOperation(attributes, generationEmbeddingPrefixes);
            return hasModelInformation && isGenerationOrEmbedding;
        }, 
        // MAPPER
        (attributes) => {
            // IMPORTANT: prefixes inversely ordered by length to avoid false matches
            // AI SDK may append function ID after operation name (e.g., "ai.embed my-function")
            const prefixMappings = [
                [
                    [
                        "ai.generateText.doGenerate",
                        "ai.streamText.doStream",
                        "ai.generateObject.doGenerate",
                        "ai.streamObject.doStream",
                    ],
                    "GENERATION",
                ],
                [["ai.embedMany.doEmbed", "ai.embed.doEmbed"], "EMBEDDING"],
            ];
            for (const [prefixes, type] of prefixMappings) {
                if (matchesVercelAiSdkOperation(attributes, prefixes)) {
                    return type;
                }
            }
            return null;
        }),
        // Priority 6: Vercel AI SDK span-like operations (no model info)
        new CustomAttributeMapper(
        // NAME
        "Vercel_AI_SDK_Operation_Span_Like", 
        // PRIORITY
        6, 
        // CANMAP?
        (attributes) => {
            // Check if it's a Vercel AI SDK operation (starts with "ai.")
            const operationName = attributes["operation.name"];
            const operationId = attributes["ai.operationId"];
            const hasAiOperation = (hasMeaningfulValue(operationName) &&
                operationName.startsWith("ai.")) ||
                (hasMeaningfulValue(operationId) &&
                    operationId.startsWith("ai."));
            if (!hasAiOperation) {
                return false;
            }
            // Exclude generation and embedding operations (handled by Generation_Like mapper)
            // technically, not required here because the generation-like mapper has higher priority
            // but to keep them interchangeable, we reject them here
            const generationEmbeddingPrefixes = [
                "ai.generateText.doGenerate",
                "ai.streamText.doStream",
                "ai.generateObject.doGenerate",
                "ai.streamObject.doStream",
                "ai.embedMany.doEmbed",
                "ai.embed.doEmbed",
            ];
            const isGenerationOrEmbedding = matchesVercelAiSdkOperation(attributes, generationEmbeddingPrefixes);
            return !isGenerationOrEmbedding;
        }, 
        // MAPPER
        (attributes) => {
            // for now, there are only tools. further mappings should be added here
            if (matchesVercelAiSdkOperation(attributes, ["ai.toolCall"])) {
                return "TOOL";
            }
            return null;
        }),
        // Priority 7: GenAI tool call detection (e.g., Pydantic AI, any framework using gen_ai.tool.* attributes)
        // unfortunately, Pydantic does not set the gen_ai.operation.name attribute on tool calls
        // therefore, we need another mapper here.
        new CustomAttributeMapper("GenAI_Tool_Call", 7, (attributes) => {
            // Check for standard GenAI tool call attributes
            return (hasMeaningfulValue(attributes["gen_ai.tool.name"]) ||
                hasMeaningfulValue(attributes["gen_ai.tool.call.id"]));
        }, () => "TOOL"),
        // Priority 8: Flue (https://flueframework.com) tool and delegated-task spans.
        // The @flue/opentelemetry adapter emits model-turn spans with
        // gen_ai.operation.name (handled above as GENERATION); tool and task spans
        // only carry flue.* attributes, so they are detected here.
        new CustomAttributeMapper("Flue", 8, (attributes) => hasMeaningfulValue(attributes["flue.tool.name"]) ||
            hasMeaningfulValue(attributes["flue.tool.call_id"]) ||
            hasMeaningfulValue(attributes["flue.task.id"]) ||
            hasMeaningfulValue(attributes["flue.task.agent"]), (attributes) => {
            if (hasMeaningfulValue(attributes["flue.tool.name"]) ||
                hasMeaningfulValue(attributes["flue.tool.call_id"])) {
                return "TOOL";
            }
            // A Flue `task` is a delegated sub-agent run.
            return "AGENT";
        }),
        // Priority 9: LiveKit spans: use span name to determine observation type
        new CustomAttributeMapper("LiveKit_SpanName", 9, (_attributes, _resourceAttributes, scopeData, spanName) => {
            if (scopeData?.name !== "livekit-agents")
                return false;
            return (spanName === "agent_turn" ||
                spanName === "start_agent_activity" ||
                spanName === "function_tool");
        }, (_attributes, _resourceAttributes, _scopeData, spanName) => {
            if (spanName === "agent_turn" || spanName === "start_agent_activity")
                return "AGENT";
            if (spanName === "function_tool")
                return "TOOL";
            return null;
        }),
        // Priority 10: Claude Managed Agents session creation is a lifecycle span.
        new CustomAttributeMapper("ClaudeManagedAgentSessionCreation", 10, (attributes, _resourceAttributes, scopeData, spanName) => isClaudeManagedAgentSessionCreation(attributes, scopeData?.name, spanName), () => "SPAN"),
        // Priority 11: Model-based fallback
        new CustomAttributeMapper("ModelBased", 11, (attributes, _resourceAttributes, _scopeData) => {
            const modelKeys = [
                attributes_1.LangfuseOtelSpanAttributes.OBSERVATION_MODEL,
                "gen_ai.request.model",
                "gen_ai.response.model",
                "llm.model_name",
                "model",
            ];
            return modelKeys.some((key) => hasMeaningfulValue(attributes[key]));
        }, () => "GENERATION"),
    ];
    sortedMappersCache = null;
    getSortedMappers() {
        if (!this.sortedMappersCache) {
            this.sortedMappersCache = [...this.mappers].sort((a, b) => a.priority - b.priority);
        }
        return this.sortedMappersCache;
    }
    mapToObservationType(attributes, resourceAttributes, scopeData, spanName) {
        const sortedMappers = this.getSortedMappers();
        for (const mapper of sortedMappers) {
            if (mapper.canMap(attributes, resourceAttributes, scopeData, spanName)) {
                const result = mapper.mapToObservationType(attributes, resourceAttributes, scopeData, spanName);
                if (result) {
                    return result;
                }
            }
        }
        return "SPAN";
    }
    getMappersForDebugging() {
        return [...this.mappers];
    }
}
exports.ObservationTypeMapperRegistry = ObservationTypeMapperRegistry;
/** CMA session creation configures a model without executing a model call. */
function isClaudeManagedAgentSessionCreation(attributes, scopeName, spanName) {
    return (spanName === "anthropic.sessions.create" &&
        !hasMeaningfulValue(attributes["gen_ai.operation.name"]) &&
        isClaudeManagedAgentSpan(attributes, scopeName));
}
/** Anthropic scopes also emit regular API spans; a session ID identifies Claude Managed Agents. */
function isClaudeManagedAgentSpan(attributes, scopeName) {
    const sessionId = attributes["anthropic.session.id"];
    return (typeof scopeName === "string" &&
        (scopeName === "com.anthropic.claude-platform" ||
            scopeName.startsWith("com.anthropic.sdk.")) &&
        typeof sessionId === "string" &&
        sessionId.trim().length > 0);
}
