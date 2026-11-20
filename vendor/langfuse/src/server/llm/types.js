"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LangfuseInternalTraceEnvironment = exports.LLMApiKeySchema = exports.supportedModels = exports.TYPESAFE_UPSTREAMS = exports.typeSafeModels = exports.googleAIStudioModels = exports.vertexAIModels = exports.anthropicModels = exports.openAIModels = exports.ExperimentMetadataSchema = exports.ZodModelConfig = exports.PromptContentSchema = exports.TextPromptContentSchema = exports.PROVIDERS_WITH_REQUIRED_USER_MESSAGE = exports.DECISION_MODEL_CONNECTIONS_HINT = exports.TEXT_ADAPTER_DECISION_MODEL_IDS = exports.DECISION_MODEL_ADAPTERS = exports.LLMAdapter = exports.PromptChatMessageListSchema = exports.PromptChatMessageSchema = exports.ChatMessageSchema = exports.ChatMessageDefaultRoleSchema = exports.PlaceholderMessageSchema = exports.ToolResultMessageSchema = exports.AssistantToolCallMessageSchema = exports.ModelMessageSchema = exports.AssistantTextMessageSchema = exports.UserMessageSchema = exports.DeveloperMessageSchema = exports.SystemMessageSchema = exports.ChatMessageType = exports.ChatMessageRole = exports.ToolCallResponseSchema = exports.OpenAIResponseFormatSchema = exports.OpenAIToolSchema = exports.OpenAIToolCallSchema = exports.LLMToolCallSchema = exports.LLMToolDefinitionSchema = exports.LLMToolNameSchema = exports.JSONSchemaFormSchema = exports.LLMJSONSchema = void 0;
exports.textAdapterForDecisionModel = textAdapterForDecisionModel;
exports.isTextAdapterDecisionModel = isTextAdapterDecisionModel;
exports.isTextDecisionAdapter = isTextDecisionAdapter;
exports.isDecisionModelAdapter = isDecisionModelAdapter;
exports.supportsDecisionModels = supportsDecisionModels;
exports.isAllowedDecisionModel = isAllowedDecisionModel;
exports.unsupportedDecisionModelMessage = unsupportedDecisionModelMessage;
exports.resolveTypeSafeUpstream = resolveTypeSafeUpstream;
const zod_1 = __importDefault(require("zod"));
const customLLMProviderConfigSchemas_1 = require("../../interfaces/customLLMProviderConfigSchemas");
const zod_2 = require("../../utils/zod");
// disable lint as this is exported and used in web/worker
exports.LLMJSONSchema = zod_1.default.record(zod_1.default.string(), zod_1.default.any());
exports.JSONSchemaFormSchema = zod_1.default
    .string()
    .transform((value, ctx) => {
    try {
        const parsed = JSON.parse(value);
        return parsed;
    }
    catch {
        ctx.addIssue({
            code: "custom",
            message: "Parameters must be valid JSON",
        });
        return zod_1.default.NEVER;
    }
})
    .pipe(zod_1.default
    .object({
    type: zod_1.default.literal("object"),
    properties: zod_1.default.record(zod_1.default.string(), zod_1.default.any()),
    required: zod_1.default.array(zod_1.default.string()).optional(),
    additionalProperties: zod_1.default.boolean().optional(),
})
    .loose()
    .transform((data) => JSON.stringify(data, null, 2)));
exports.LLMToolNameSchema = zod_1.default
    .string()
    .regex(/^[a-zA-Z0-9._-]+$/, "Name must contain only alphanumeric letters, hyphens, periods and underscores")
    .min(1, "Name is required");
exports.LLMToolDefinitionSchema = zod_1.default.object({
    name: zod_1.default.string(),
    description: zod_1.default.string(),
    parameters: exports.LLMJSONSchema,
});
exports.LLMToolCallSchema = zod_1.default.object({
    name: zod_1.default.string(),
    id: zod_1.default.string(),
    args: zod_1.default
        .record(zod_1.default.string(), zod_1.default.unknown())
        .nullable()
        .transform((val) => val ?? {}),
});
exports.OpenAIToolCallSchema = zod_1.default.object({
    id: zod_1.default.string(),
    function: zod_1.default.object({
        name: zod_1.default.string(),
        arguments: zod_1.default.union([
            zod_1.default.record(zod_1.default.string(), zod_1.default.unknown()),
            zod_1.default
                .string()
                .transform((v) => {
                try {
                    return JSON.parse(v);
                }
                catch {
                    return v;
                }
            })
                .pipe(zod_1.default.record(zod_1.default.string(), zod_1.default.unknown())),
        ]),
    }),
    type: zod_1.default.literal("function"),
});
exports.OpenAIToolSchema = zod_1.default.object({
    type: zod_1.default.literal("function"),
    function: exports.LLMToolDefinitionSchema,
});
exports.OpenAIResponseFormatSchema = zod_1.default.object({
    type: zod_1.default.literal("json_schema"),
    json_schema: zod_1.default.object({
        name: zod_1.default.string(),
        schema: exports.LLMJSONSchema,
    }),
});
// Legacy playground tool-call content can be either text or an array of
// provider-normalized blocks. Keep the discriminator loose while persisted
// responses migrate to native AI SDK tool-call results.
const StandardContentBlockSchema = zod_1.default
    .object({
    type: zod_1.default.string(),
})
    .loose();
exports.ToolCallResponseSchema = zod_1.default.object({
    content: zod_1.default.union([zod_1.default.string(), zod_1.default.array(StandardContentBlockSchema)]),
    tool_calls: zod_1.default.array(exports.LLMToolCallSchema),
});
var ChatMessageRole;
(function (ChatMessageRole) {
    ChatMessageRole["System"] = "system";
    ChatMessageRole["Developer"] = "developer";
    ChatMessageRole["User"] = "user";
    ChatMessageRole["Assistant"] = "assistant";
    ChatMessageRole["Tool"] = "tool";
    ChatMessageRole["Model"] = "model";
})(ChatMessageRole || (exports.ChatMessageRole = ChatMessageRole = {}));
// Thought: should placeholder not semantically be part of this, because it can be
// PublicAPICreated of type? Works for now though.
var ChatMessageType;
(function (ChatMessageType) {
    ChatMessageType["System"] = "system";
    ChatMessageType["Developer"] = "developer";
    ChatMessageType["User"] = "user";
    ChatMessageType["AssistantText"] = "assistant-text";
    ChatMessageType["AssistantToolCall"] = "assistant-tool-call";
    ChatMessageType["ToolResult"] = "tool-result";
    ChatMessageType["ModelText"] = "model-text";
    ChatMessageType["PublicAPICreated"] = "public-api-created";
    ChatMessageType["Placeholder"] = "placeholder";
})(ChatMessageType || (exports.ChatMessageType = ChatMessageType = {}));
exports.SystemMessageSchema = zod_1.default.object({
    type: zod_1.default.literal(ChatMessageType.System),
    role: zod_1.default.literal(ChatMessageRole.System),
    content: zod_1.default.string(),
});
exports.DeveloperMessageSchema = zod_1.default.object({
    type: zod_1.default.literal(ChatMessageType.Developer),
    role: zod_1.default.literal(ChatMessageRole.Developer),
    content: zod_1.default.string(),
});
exports.UserMessageSchema = zod_1.default.object({
    type: zod_1.default.literal(ChatMessageType.User),
    role: zod_1.default.literal(ChatMessageRole.User),
    content: zod_1.default.string(),
});
exports.AssistantTextMessageSchema = zod_1.default.object({
    type: zod_1.default.literal(ChatMessageType.AssistantText),
    role: zod_1.default.literal(ChatMessageRole.Assistant),
    content: zod_1.default.string(),
});
exports.ModelMessageSchema = zod_1.default.object({
    type: zod_1.default.literal(ChatMessageType.ModelText),
    role: zod_1.default.literal(ChatMessageRole.Model),
    content: zod_1.default.string(),
});
exports.AssistantToolCallMessageSchema = zod_1.default.object({
    type: zod_1.default.literal(ChatMessageType.AssistantToolCall),
    role: zod_1.default.literal(ChatMessageRole.Assistant),
    content: zod_1.default.string(),
    toolCalls: zod_1.default.array(exports.LLMToolCallSchema),
});
exports.ToolResultMessageSchema = zod_1.default.object({
    type: zod_1.default.literal(ChatMessageType.ToolResult),
    role: zod_1.default.literal(ChatMessageRole.Tool),
    content: zod_1.default.string(),
    toolCallId: zod_1.default.string(),
});
exports.PlaceholderMessageSchema = zod_1.default.object({
    type: zod_1.default.literal(ChatMessageType.Placeholder),
    name: zod_1.default
        .string()
        .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "Placeholder name must start with a letter and contain only alphanumeric characters and underscores"),
});
exports.ChatMessageDefaultRoleSchema = zod_1.default.enum(ChatMessageRole);
exports.ChatMessageSchema = zod_1.default.union([
    exports.SystemMessageSchema,
    exports.DeveloperMessageSchema,
    exports.UserMessageSchema,
    exports.AssistantTextMessageSchema,
    exports.AssistantToolCallMessageSchema,
    exports.ToolResultMessageSchema,
    exports.ModelMessageSchema,
    zod_1.default
        .object({
        role: zod_1.default.union([exports.ChatMessageDefaultRoleSchema, zod_1.default.string()]), // Users may ingest any string as role via API/SDK
        content: zod_1.default.union([zod_1.default.string(), zod_1.default.array(zod_1.default.any()), zod_1.default.any()]), // Support arbitrary content types for message placeholders
    })
        .transform((msg) => {
        return {
            ...msg,
            type: ChatMessageType.PublicAPICreated,
        };
    }),
]);
exports.PromptChatMessageSchema = zod_1.default.union([
    zod_1.default.object({
        role: zod_1.default.string(),
        content: zod_1.default.string(),
    }),
    exports.PlaceholderMessageSchema,
]);
exports.PromptChatMessageListSchema = zod_1.default.array(exports.PromptChatMessageSchema);
var LLMAdapter;
(function (LLMAdapter) {
    LLMAdapter["Anthropic"] = "anthropic";
    LLMAdapter["OpenAI"] = "openai";
    LLMAdapter["Azure"] = "azure";
    LLMAdapter["Bedrock"] = "bedrock";
    LLMAdapter["VertexAI"] = "google-vertex-ai";
    LLMAdapter["GoogleAIStudio"] = "google-ai-studio";
    LLMAdapter["TypeSafe"] = "typesafe";
})(LLMAdapter || (exports.LLMAdapter = LLMAdapter = {}));
exports.DECISION_MODEL_ADAPTERS = [
    LLMAdapter.TypeSafe,
];
/**
 * Decision models that text adapters serve, in default-preference order. These
 * APIs take one `input` and plain-text questions, unlike TypeSafe's keyed state.
 */
exports.TEXT_ADAPTER_DECISION_MODEL_IDS = {
    [LLMAdapter.OpenAI]: ["gpt-6-luna"],
    [LLMAdapter.GoogleAIStudio]: ["gemini-decision-1"],
};
exports.DECISION_MODEL_CONNECTIONS_HINT = `an OpenAI connection with ${exports.TEXT_ADAPTER_DECISION_MODEL_IDS[LLMAdapter.OpenAI]?.join(", ")}, a Google AI Studio connection with ${exports.TEXT_ADAPTER_DECISION_MODEL_IDS[LLMAdapter.GoogleAIStudio]?.join(", ")}, or a TypeSafe connection`;
function textAdapterForDecisionModel(model) {
    return Object.values(LLMAdapter).find((adapter) => exports.TEXT_ADAPTER_DECISION_MODEL_IDS[adapter]?.includes(model));
}
function isTextAdapterDecisionModel(model) {
    return textAdapterForDecisionModel(model) !== undefined;
}
function isTextDecisionAdapter(adapter) {
    return exports.TEXT_ADAPTER_DECISION_MODEL_IDS[adapter] !== undefined;
}
function isDecisionModelAdapter(adapter) {
    return exports.DECISION_MODEL_ADAPTERS.includes(adapter);
}
/** Adapters that can answer a decision-model evaluator. Text adapters keep generating text too. */
function supportsDecisionModels(adapter) {
    return adapter === LLMAdapter.TypeSafe || isTextDecisionAdapter(adapter);
}
function isAllowedDecisionModel(adapter, model) {
    if (adapter === LLMAdapter.TypeSafe)
        return model.length > 0;
    return (exports.TEXT_ADAPTER_DECISION_MODEL_IDS[adapter]?.includes(model) ??
        false);
}
/** Null when the adapter has no decision-model allowlist to point at. */
function unsupportedDecisionModelMessage(adapter, model) {
    const models = exports.TEXT_ADAPTER_DECISION_MODEL_IDS[adapter];
    if (models === undefined)
        return null;
    return `Model "${model}" is not supported for decision models. Use ${models.join(", ")}.`;
}
// Some providers require at least one user message. The persisted-message
// conversion boundary turns a lone message into a user message for them.
exports.PROVIDERS_WITH_REQUIRED_USER_MESSAGE = [
    LLMAdapter.VertexAI,
    LLMAdapter.GoogleAIStudio,
    LLMAdapter.Anthropic,
    LLMAdapter.Bedrock,
];
exports.TextPromptContentSchema = zod_1.default.string().min(1, "Enter a prompt");
exports.PromptContentSchema = zod_1.default.union([
    exports.PromptChatMessageListSchema,
    exports.TextPromptContentSchema,
]);
exports.ZodModelConfig = zod_1.default.object({
    max_tokens: zod_1.default.coerce.number().optional(),
    temperature: zod_1.default.coerce.number().optional(),
    top_p: zod_1.default.coerce.number().optional(),
    maxReasoningTokens: zod_1.default.coerce.number().optional(),
    providerOptions: zod_2.JSONObjectSchema.optional(),
});
// Experiment config
exports.ExperimentMetadataSchema = zod_1.default
    .object({
    prompt_id: zod_1.default.string(),
    provider: zod_1.default.string(),
    model: zod_1.default.string(),
    model_params: exports.ZodModelConfig,
    structured_output_schema: exports.LLMJSONSchema.optional(),
    experiment_name: zod_1.default.string().optional(),
    experiment_run_name: zod_1.default.string().optional(),
    error: zod_1.default.string().optional(),
    dataset_version: zod_1.default.coerce.date().optional(),
})
    .strict();
// NOTE: Update docs page when changing this! https://langfuse.com/docs/prompt-management/features/playground#openai-playground--anthropic-playground
// WARNING: The first entry in the array is chosen as the default model to add LLM API keys
exports.openAIModels = [
    "gpt-4.1",
    "gpt-4.1-2025-04-14",
    "gpt-4.1-mini",
    "gpt-4.1-mini-2025-04-14",
    "gpt-6.2-astra",
    "gpt-6.2-sol",
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6.1-sol",
    "gpt-6.1-terra",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.5-2026-04-23",
    "gpt-5.5-pro",
    "gpt-5.5-pro-2026-04-23",
    "gpt-5.4",
    "gpt-5.4-2026-03-05",
    "gpt-5.4-pro",
    "gpt-5.4-pro-2026-03-05",
    "gpt-5.4-mini",
    "gpt-5.4-mini-2026-03-17",
    "gpt-5.4-nano",
    "gpt-5.4-nano-2026-03-17",
    "gpt-5.3-codex",
    "gpt-5.2-2025-12-11",
    "gpt-5.1",
    "gpt-5.1-2025-11-13",
    "gpt-5",
    "gpt-5-2025-08-07",
    "gpt-5-mini",
    "gpt-5-mini-2025-08-07",
    "gpt-5-nano",
    "gpt-5-nano-2025-08-07",
    "o3",
    "o3-2025-04-16",
    "gpt-4o",
    "gpt-4o-2024-08-06",
    "gpt-4o-mini",
    "gpt-4o-mini-2024-07-18",
    "gpt-3.5-turbo-16k",
];
// NOTE: Update docs page when changing this! https://langfuse.com/docs/prompt-management/features/playground#openai-playground--anthropic-playground
// WARNING: The first entry in the array is chosen as the default model to add LLM API keys
exports.anthropicModels = [
    "claude-sonnet-5",
    "claude-sonnet-5-5",
    "claude-sonnet-4-5-20250929",
    "claude-fable-5",
    "claude-fable-5-1",
    "claude-fable-5-2",
    "claude-mythos-5",
    "claude-mythos-5-1",
    "claude-mythos-5-2",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-haiku-5-5",
    "claude-haiku-4-5-20251001",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-opus-4-5-20251101",
];
// WARNING: The first entry in the array is chosen as the default model to add LLM API keys
// Only models Vertex AI still serves. Gemini 3.x is served from the "global"
// location only (the default for Vertex connections). Retired 1.0/1.5/2.0
// models, superseded previews and the Live API audio model are not listed.
exports.vertexAIModels = [
    "gemini-3.5-flash",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-pro-preview",
    "gemini-3.1-flash-lite",
    "gemini-3-flash-preview",
    "gemini-2.5-flash-lite",
];
// WARNING: The first entry in the array is chosen as the default model to add LLM API keys. Make sure it supports top_p, max_tokens and temperature.
exports.googleAIStudioModels = [
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-4-carbon",
    "gemini-4-neon",
    "gemini-4-hydrogen",
    "gemini-4-argon",
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-pro-preview",
    "gemini-3.1-flash-lite",
    "gemini-3-flash-preview",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash-thinking-exp-01-21",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
    "gemini-1.5-flash-8b",
];
exports.typeSafeModels = ["jev-latest"];
/**
 * Providers that serve Jev through TypeSafe's `/v1/systemone` API. A TypeSafe
 * connection stores a gateway's `baseURL`, or none for TypeSafe itself, which
 * the AI SDK provider then defaults to. Presets only prefill the base URL; a
 * `custom` connection stores any base URL the provider appends `/systemone`
 * to.
 */
exports.TYPESAFE_UPSTREAMS = [
    {
        id: "typesafe",
        label: "TypeSafe",
        baseURL: null,
        apiKeyLabel: "TypeSafe API key",
    },
    {
        id: "vercel-ai-gateway",
        label: "Vercel AI Gateway",
        baseURL: "https://ai-gateway.vercel.sh/typesafe/v1",
        apiKeyLabel: "Vercel AI Gateway API key",
    },
    {
        id: "openrouter",
        label: "OpenRouter",
        baseURL: "https://openrouter.ai/api/v1",
        apiKeyLabel: "OpenRouter API key",
    },
    {
        id: "custom",
        label: "Custom",
        baseURL: null,
        apiKeyLabel: "API key",
    },
];
function resolveTypeSafeUpstream(baseURL) {
    if (!baseURL)
        return exports.TYPESAFE_UPSTREAMS[0];
    return (exports.TYPESAFE_UPSTREAMS.find((upstream) => upstream.baseURL === baseURL) ??
        exports.TYPESAFE_UPSTREAMS[exports.TYPESAFE_UPSTREAMS.length - 1]);
}
exports.supportedModels = {
    [LLMAdapter.Anthropic]: exports.anthropicModels,
    [LLMAdapter.OpenAI]: exports.openAIModels,
    [LLMAdapter.VertexAI]: exports.vertexAIModels,
    [LLMAdapter.GoogleAIStudio]: exports.googleAIStudioModels,
    [LLMAdapter.Azure]: [],
    [LLMAdapter.Bedrock]: [],
    [LLMAdapter.TypeSafe]: exports.typeSafeModels,
};
exports.LLMApiKeySchema = zod_1.default
    .object({
    id: zod_1.default.string(),
    projectId: zod_1.default.string(),
    createdAt: zod_1.default.date(),
    updatedAt: zod_1.default.date(),
    adapter: zod_1.default.enum(LLMAdapter),
    provider: zod_1.default.string(),
    displaySecretKey: zod_1.default.string(),
    secretKey: zod_1.default.string(),
    externalId: zod_1.default.string().nullish(),
    extraHeaders: zod_1.default.string().nullish(),
    extraHeaderKeys: zod_1.default.array(zod_1.default.string()),
    baseURL: zod_1.default.string().nullable(),
    customModels: zod_1.default.array(zod_1.default.string()),
    withDefaultModels: zod_1.default.boolean(),
    config: zod_1.default
        .union([customLLMProviderConfigSchemas_1.BedrockConfigSchema, customLLMProviderConfigSchemas_1.VertexAIConfigSchema, customLLMProviderConfigSchemas_1.OpenAIConfigSchema])
        .nullish(),
})
    // strict mode to prevent extra keys. Thorws error otherwise
    // https://github.com/colinhacks/zod?tab=readme-ov-file#strict
    .strict();
var LangfuseInternalTraceEnvironment;
(function (LangfuseInternalTraceEnvironment) {
    LangfuseInternalTraceEnvironment["PromptExperiments"] = "langfuse-prompt-experiment";
    LangfuseInternalTraceEnvironment["LLMJudge"] = "langfuse-llm-as-a-judge";
    LangfuseInternalTraceEnvironment["CodeEval"] = "langfuse-code-eval";
    LangfuseInternalTraceEnvironment["NaturalLanguageFilter"] = "langfuse-natural-language-filter";
    LangfuseInternalTraceEnvironment["InAppAgent"] = "langfuse-in-app-agent";
    LangfuseInternalTraceEnvironment["Topics"] = "langfuse-topics";
})(LangfuseInternalTraceEnvironment || (exports.LangfuseInternalTraceEnvironment = LangfuseInternalTraceEnvironment = {}));
