"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createIngestionEventSchema = exports.ingestionEvent = exports.legacyObservationUpdateEvent = exports.legacyObservationCreateEvent = exports.datasetRunItemCreateEvent = exports.sdkLogEvent = exports.scoreEvent = exports.guardrailCreateEvent = exports.embeddingCreateEvent = exports.evaluatorCreateEvent = exports.retrieverCreateEvent = exports.chainCreateEvent = exports.toolCreateEvent = exports.agentCreateEvent = exports.generationUpdateEvent = exports.generationCreateEvent = exports.spanUpdateEvent = exports.spanCreateEvent = exports.eventCreateEvent = exports.traceEvent = exports.ScoreBody = exports.BaseScoreBody = exports.UpdateGenerationBody = exports.CreateGenerationBody = exports.UpdateSpanBody = exports.CreateSpanBody = exports.UpdateEventEvent = exports.CreateEventEvent = exports.OptionalObservationBody = exports.TraceBody = exports.SdkLogEvent = exports.LegacyObservationBody = exports.LegacyGenerationPatchSchema = exports.LegacyGenerationsCreateSchema = exports.LegacySpanPatchSchema = exports.LegacySpanPostSchema = exports.eventTypes = exports.normalizeEnvironment = exports.EnvironmentName = exports.DEFAULT_TRACE_ENVIRONMENT = exports.UsageDetails = exports.usage = exports.stringDateTime = exports.Usage = exports.idSchema = void 0;
const isEmpty_1 = __importDefault(require("lodash/isEmpty"));
const zod_1 = require("zod");
const zod_2 = require("../../utils/zod");
const constants_1 = require("../../constants");
const scores_1 = require("../../domain/scores");
const scores_2 = require("../../utils/scores");
exports.idSchema = zod_1.z
    .string()
    .min(1)
    .max(800) // AWS S3 allows for 1024 bytes for object keys and we need enough room to construct the entire key/path. https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-keys.html
    .refine((id) => !id.includes("\r"), {
    message: "ID cannot contain carriage return characters",
});
const ObservationLevel = zod_1.z.enum(["DEBUG", "DEFAULT", "WARNING", "ERROR"]);
exports.Usage = zod_1.z.object({
    input: zod_1.z.number().int().nullish(),
    output: zod_1.z.number().int().nullish(),
    total: zod_1.z.number().int().nullish(),
    unit: zod_1.z.enum(constants_1.ModelUsageUnit).nullish(),
    inputCost: zod_1.z.number().nullish(),
    outputCost: zod_1.z.number().nullish(),
    totalCost: zod_1.z.number().nullish(),
});
const MixedUsage = zod_1.z.object({
    input: zod_1.z.number().int().nullish(),
    output: zod_1.z.number().int().nullish(),
    total: zod_1.z.number().int().nullish(),
    unit: zod_1.z.enum(constants_1.ModelUsageUnit).nullish(),
    promptTokens: zod_1.z.number().int().nullish(),
    completionTokens: zod_1.z.number().int().nullish(),
    totalTokens: zod_1.z.number().int().nullish(),
    inputCost: zod_1.z.number().nullish(),
    outputCost: zod_1.z.number().nullish(),
    totalCost: zod_1.z.number().nullish(),
});
exports.stringDateTime = (0, zod_2.isoDateTime)({ offset: true }).nullish();
exports.usage = MixedUsage.nullish()
    // transform mixed usage model input to new one
    .transform((v) => {
    if (!v) {
        return null;
    }
    // if we get the openai format, we default to TOKENS unit
    if ("promptTokens" in v || "completionTokens" in v || "totalTokens" in v) {
        return {
            input: v.promptTokens,
            output: v.completionTokens,
            total: v.totalTokens,
            unit: constants_1.ModelUsageUnit.Tokens,
        };
    }
    // if the object is empty, we return undefined
    if ((0, isEmpty_1.default)(v)) {
        return undefined;
    }
    return v;
})
    // ensure output is always of new usage model
    .pipe(exports.Usage.nullish());
const CostDetails = zod_1.z
    .record(zod_1.z.string(), zod_1.z.unknown())
    .nullish()
    .transform((val) => {
    if (!val)
        return val;
    const result = {};
    for (const [key, value] of Object.entries(val)) {
        if (typeof value === "number" && !isNaN(value) && value >= 0) {
            result[key] = value;
        }
    }
    return Object.keys(result).length > 0 ? result : undefined;
})
    .nullish();
const RawUsageDetails = zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).transform((val) => {
    if (!val)
        return;
    const result = extractUsageCounts(val);
    return Object.keys(result).length > 0 ? result : undefined;
});
function extractUsageCounts(val) {
    const result = {};
    for (const [key, value] of Object.entries(val)) {
        if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
            result[key] = value;
        }
        else if (typeof value === "string") {
            const parsed = parseInt(value, 10);
            if (!isNaN(parsed) && parsed >= 0) {
                result[key] = parsed;
            }
        }
    }
    splitAnthropicCacheCreation(val.cache_creation, result);
    return result;
}
/**
 * Native Anthropic usage nests cache writes by TTL under `cache_creation`.
 * The 5-minute and 1-hour writes are priced differently, so they are stored
 * as `input_cache_creation_5m` / `input_cache_creation_1h`; the aggregate
 * `cache_creation_input_tokens` keeps only the unattributed remainder so no
 * write is priced twice.
 */
function splitAnthropicCacheCreation(cacheCreation, result) {
    if (typeof cacheCreation !== "object" || cacheCreation === null)
        return;
    const split = cacheCreation;
    const isCount = (value) => typeof value === "number" && Number.isInteger(value) && value >= 0;
    const fiveMinute = split["ephemeral_5m_input_tokens"];
    const oneHour = split["ephemeral_1h_input_tokens"];
    if (!isCount(fiveMinute) && !isCount(oneHour))
        return;
    let attributed = 0;
    if (isCount(fiveMinute)) {
        result["input_cache_creation_5m"] = fiveMinute;
        attributed += fiveMinute;
    }
    if (isCount(oneHour)) {
        result["input_cache_creation_1h"] = oneHour;
        attributed += oneHour;
    }
    const remainder = (result["cache_creation_input_tokens"] ?? 0) - attributed;
    if (remainder > 0) {
        result["cache_creation_input_tokens"] = remainder;
    }
    else {
        delete result["cache_creation_input_tokens"];
    }
}
// The OpenAI schemas accept unknown top-level keys: OpenAI-compatible providers
// add fields such as `cost`, and rejecting those would route the payload to
// `RawUsageDetails` and lose the normalization. Unknown keys are kept under the
// same rules as `RawUsageDetails`; normalized keys take precedence.
const OpenAICompletionUsageSchema = zod_1.z
    .object({
    prompt_tokens: zod_1.z.number().int().nonnegative(),
    completion_tokens: zod_1.z.number().int().nonnegative(),
    total_tokens: zod_1.z.number().int().nonnegative(),
    prompt_tokens_details: zod_1.z
        .record(zod_1.z.string(), zod_1.z.number().int().nonnegative().nullish())
        .nullish(),
    completion_tokens_details: zod_1.z
        .record(zod_1.z.string(), zod_1.z.number().int().nonnegative().nullish())
        .nullish(),
})
    .loose()
    .transform((v) => {
    if (!v)
        return;
    const { prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details, completion_tokens_details, ...unknownFields } = v;
    const result = {
        ...extractUsageCounts(unknownFields),
        input: prompt_tokens,
        output: completion_tokens,
        total: total_tokens,
    };
    if (prompt_tokens_details) {
        for (const [key, value] of Object.entries(prompt_tokens_details)) {
            if (value !== null && value !== undefined) {
                result[`input_${key}`] = value;
                result.input = Math.max(result.input - (value ?? 0), 0);
            }
        }
    }
    if (completion_tokens_details) {
        for (const [key, value] of Object.entries(completion_tokens_details)) {
            if (value !== null && value !== undefined) {
                result[`output_${key}`] = value;
                result.output = Math.max(result.output - (value ?? 0), 0);
            }
        }
    }
    return result;
});
// The new OpenAI Response API uses a new Usage schema that departs from the Completion API Usage schema
const OpenAIResponseUsageSchema = zod_1.z
    .object({
    input_tokens: zod_1.z.number().int().nonnegative(),
    output_tokens: zod_1.z.number().int().nonnegative(),
    total_tokens: zod_1.z.number().int().nonnegative(),
    input_tokens_details: zod_1.z
        .record(zod_1.z.string(), zod_1.z.number().int().nonnegative().nullish())
        .nullish(),
    output_tokens_details: zod_1.z
        .record(zod_1.z.string(), zod_1.z.number().int().nonnegative().nullish())
        .nullish(),
})
    .loose()
    .transform((v) => {
    if (!v)
        return;
    const { input_tokens, output_tokens, total_tokens, input_tokens_details, output_tokens_details, ...unknownFields } = v;
    const result = {
        ...extractUsageCounts(unknownFields),
        input: input_tokens,
        output: output_tokens,
        total: total_tokens,
    };
    if (input_tokens_details) {
        for (const [key, value] of Object.entries(input_tokens_details)) {
            if (value !== null && value !== undefined) {
                result[`input_${key}`] = value;
                result.input = Math.max(result.input - (value ?? 0), 0);
            }
        }
    }
    if (output_tokens_details) {
        for (const [key, value] of Object.entries(output_tokens_details)) {
            if (value !== null && value !== undefined) {
                result[`output_${key}`] = value;
                result.output = Math.max(result.output - (value ?? 0), 0);
            }
        }
    }
    return result;
});
exports.UsageDetails = zod_1.z
    .union([
    OpenAICompletionUsageSchema,
    OpenAIResponseUsageSchema,
    RawUsageDetails,
])
    .nullish();
/** Default environment name used when no environment is specified. */
exports.DEFAULT_TRACE_ENVIRONMENT = "default";
const PublicEnvironmentName = zod_1.z
    .string()
    .toLowerCase()
    .transform((val) => {
    // Strip all leading "langfuse" prefixes (with optional separator). The
    // repeated strip keeps normalization idempotent — values now pass through
    // this schema twice on the OTel path (extractEnvironment, then the
    // ingestion event parse) — and closes the reserved-namespace bypass where
    // "langfuselangfuse-x" survived a single-pass strip as "langfuse-x".
    const stripped = val.replace(/^(?:langfuse[-_]?)+/, "");
    // Truncate to 40 chars, validate allowed chars
    const truncated = stripped.slice(0, 40);
    if (!truncated || !/^[a-z0-9-_]+$/.test(truncated)) {
        return exports.DEFAULT_TRACE_ENVIRONMENT;
    }
    return truncated;
})
    .catch(exports.DEFAULT_TRACE_ENVIRONMENT)
    .default(exports.DEFAULT_TRACE_ENVIRONMENT);
const InternalEnvironmentName = zod_1.z
    .string()
    .transform((val) => {
    const truncated = val.slice(0, 40);
    if (!truncated || !/^[a-z0-9-_]+$/.test(truncated)) {
        return exports.DEFAULT_TRACE_ENVIRONMENT;
    }
    return truncated;
})
    .catch(exports.DEFAULT_TRACE_ENVIRONMENT)
    .default(exports.DEFAULT_TRACE_ENVIRONMENT);
/** @deprecated Use PublicEnvironmentName or InternalEnvironmentName instead */
exports.EnvironmentName = PublicEnvironmentName;
/**
 * Normalizes an environment value outside of a full ingestion event parse,
 * e.g. for the direct OTel events_full write path. Applies the same rules as
 * the ingestion event schemas: public values are lowercased and lose the
 * reserved "langfuse" prefix; internal values keep it so internal traces stay
 * in the "langfuse-*" namespace (see createIngestionEventSchema).
 */
const normalizeEnvironment = (value, opts) => (opts?.isLangfuseInternal
    ? InternalEnvironmentName
    : PublicEnvironmentName).parse(value);
exports.normalizeEnvironment = normalizeEnvironment;
exports.eventTypes = {
    TRACE_CREATE: "trace-create",
    SCORE_CREATE: "score-create",
    EVENT_CREATE: "event-create",
    SPAN_CREATE: "span-create",
    SPAN_UPDATE: "span-update",
    GENERATION_CREATE: "generation-create",
    GENERATION_UPDATE: "generation-update",
    AGENT_CREATE: "agent-create",
    TOOL_CREATE: "tool-create",
    CHAIN_CREATE: "chain-create",
    RETRIEVER_CREATE: "retriever-create",
    EVALUATOR_CREATE: "evaluator-create",
    EMBEDDING_CREATE: "embedding-create",
    GUARDRAIL_CREATE: "guardrail-create",
    SDK_LOG: "sdk-log",
    DATASET_RUN_ITEM_CREATE: "dataset-run-item-create",
    // LEGACY, only required for backwards compatibility
    OBSERVATION_CREATE: "observation-create",
    OBSERVATION_UPDATE: "observation-update",
};
// LEGACY, only required for backwards compatibility
exports.LegacySpanPostSchema = zod_1.z.object({
    id: exports.idSchema.nullish(),
    traceId: exports.idSchema.nullish(),
    name: zod_1.z.string().nullish(),
    startTime: exports.stringDateTime,
    endTime: exports.stringDateTime,
    metadata: zod_2.jsonSchema.nullish(),
    input: zod_2.jsonSchema.nullish(),
    output: zod_2.jsonSchema.nullish(),
    parentObservationId: zod_1.z.string().nullish(),
    level: ObservationLevel.nullish(),
    statusMessage: zod_1.z.string().nullish(),
    version: zod_1.z.string().nullish(),
});
exports.LegacySpanPatchSchema = zod_1.z.object({
    spanId: exports.idSchema,
    traceId: exports.idSchema.nullish(),
    name: zod_1.z.string().nullish(),
    startTime: exports.stringDateTime,
    endTime: exports.stringDateTime,
    metadata: zod_2.jsonSchema.nullish(),
    input: zod_2.jsonSchema.nullish(),
    output: zod_2.jsonSchema.nullish(),
    level: ObservationLevel.nullish(),
    statusMessage: zod_1.z.string().nullish(),
    version: zod_1.z.string().nullish(),
});
exports.LegacyGenerationsCreateSchema = zod_1.z.object({
    id: exports.idSchema.nullish(),
    traceId: exports.idSchema.nullish(),
    name: zod_1.z.string().nullish(),
    startTime: exports.stringDateTime,
    endTime: exports.stringDateTime,
    completionStartTime: exports.stringDateTime,
    model: zod_1.z.string().nullish(),
    modelParameters: zod_1.z
        .record(zod_1.z.string(), zod_1.z.union([zod_1.z.string(), zod_1.z.number(), zod_1.z.boolean()]).nullish())
        .nullish(),
    prompt: zod_2.jsonSchema.nullish(),
    completion: zod_2.jsonSchema.nullish(),
    usage: exports.usage,
    metadata: zod_2.jsonSchema.nullish(),
    parentObservationId: zod_1.z.string().nullish(),
    level: ObservationLevel.nullish(),
    statusMessage: zod_1.z.string().nullish(),
    version: zod_1.z.string().nullish(),
});
exports.LegacyGenerationPatchSchema = zod_1.z.object({
    generationId: exports.idSchema,
    traceId: exports.idSchema.nullish(),
    name: zod_1.z.string().nullish(),
    startTime: exports.stringDateTime,
    endTime: exports.stringDateTime,
    completionStartTime: exports.stringDateTime,
    model: zod_1.z.string().nullish(),
    modelParameters: zod_1.z
        .record(zod_1.z.string(), zod_1.z.union([zod_1.z.string(), zod_1.z.number(), zod_1.z.boolean()]).nullish())
        .nullish(),
    prompt: zod_2.jsonSchema.nullish(),
    completion: zod_2.jsonSchema.nullish(),
    usage: exports.usage,
    metadata: zod_2.jsonSchema.nullish(),
    level: ObservationLevel.nullish(),
    statusMessage: zod_1.z.string().nullish(),
    version: zod_1.z.string().nullish(),
});
exports.LegacyObservationBody = zod_1.z.object({
    id: exports.idSchema.nullish(),
    traceId: exports.idSchema.nullish(),
    type: zod_1.z.enum(["GENERATION", "SPAN", "EVENT"]),
    name: zod_1.z.string().nullish(),
    startTime: exports.stringDateTime,
    endTime: exports.stringDateTime,
    completionStartTime: exports.stringDateTime,
    model: zod_1.z.string().nullish(),
    modelParameters: zod_1.z
        .record(zod_1.z.string(), zod_1.z.union([zod_1.z.string(), zod_1.z.number(), zod_1.z.boolean()]).nullish())
        .nullish(),
    input: zod_2.jsonSchema.nullish(),
    output: zod_2.jsonSchema.nullish(),
    usage: exports.usage,
    usageDetails: exports.UsageDetails,
    costDetails: CostDetails,
    metadata: zod_2.jsonSchema.nullish(),
    parentObservationId: zod_1.z.string().nullish(),
    level: ObservationLevel.nullish(),
    statusMessage: zod_1.z.string().nullish(),
    version: zod_1.z.string().nullish(),
});
exports.SdkLogEvent = zod_1.z.object({
    log: zod_2.jsonSchema,
    id: zod_1.z.string().nullish(), // Not used, but makes downstream processing easier.
});
// Using z.any instead of jsonSchema for input/output as we saw huge CPU overhead for large numeric arrays.
// With this setup parsing should be more lightweight and doesn't block other requests.
// As we allow plain values, arrays, and objects the JSON parse via bodyParser should suffice.
// Values outside the supported shapes (e.g. a structured-output
// `response_format`) are stored as JSON strings instead of rejecting the whole
// generation. OTel ingestion applies the same rule before reaching this schema.
const ModelParameters = zod_1.z
    .record(zod_1.z.string(), zod_1.z
    .union([
    zod_1.z.string(),
    zod_1.z.number(),
    zod_1.z.boolean(),
    zod_1.z.array(zod_1.z.string()),
    zod_1.z.record(zod_1.z.string(), zod_1.z.string()),
    zod_1.z.unknown().transform((value) => JSON.stringify(value)),
])
    .nullish())
    .nullish();
// Complete schema factory - single source of truth for ALL schemas
const createAllIngestionSchemas = ({ isPublic = true, }) => {
    const environmentSchema = isPublic
        ? PublicEnvironmentName
        : InternalEnvironmentName;
    // Base schemas with environment
    const TraceBody = zod_1.z.object({
        id: exports.idSchema.nullish(),
        timestamp: exports.stringDateTime,
        name: zod_1.z.string().max(1000).nullish(),
        externalId: zod_1.z.string().nullish(),
        input: zod_1.z.any().nullish(),
        output: zod_1.z.any().nullish(),
        sessionId: zod_1.z.string().nullish(),
        userId: zod_1.z.string().nullish(),
        environment: environmentSchema,
        metadata: zod_2.jsonSchema.nullish(),
        release: zod_1.z.string().nullish(),
        version: zod_1.z.string().nullish(),
        public: zod_1.z.boolean().nullish(),
        tags: zod_1.z.array(zod_1.z.string()).nullish(),
    });
    const OptionalObservationBody = zod_1.z.object({
        traceId: exports.idSchema.nullish(),
        environment: environmentSchema,
        name: zod_1.z.string().nullish(),
        startTime: exports.stringDateTime,
        metadata: zod_2.jsonSchema.nullish(),
        input: zod_1.z.any().nullish(),
        output: zod_1.z.any().nullish(),
        level: ObservationLevel.nullish(),
        statusMessage: zod_1.z.string().nullish(),
        parentObservationId: zod_1.z.string().nullish(),
        version: zod_1.z.string().nullish(),
    });
    // Derivative schemas
    const CreateEventEvent = OptionalObservationBody.extend({
        id: exports.idSchema,
    });
    const UpdateEventEvent = OptionalObservationBody.extend({
        id: exports.idSchema,
    });
    const CreateSpanBody = CreateEventEvent.extend({
        endTime: exports.stringDateTime,
    });
    const UpdateSpanBody = UpdateEventEvent.extend({
        endTime: exports.stringDateTime,
    });
    const CreateGenerationBody = CreateSpanBody.extend({
        completionStartTime: exports.stringDateTime,
        model: zod_1.z.string().nullish(),
        modelParameters: ModelParameters,
        usage: exports.usage,
        usageDetails: exports.UsageDetails,
        costDetails: CostDetails,
        promptName: zod_1.z.string().nullish(),
        promptVersion: zod_1.z.number().int().nullish(),
    }).refine((value) => {
        // ensure that either promptName and promptVersion are set, or none
        if (!value.promptName && !value.promptVersion)
            return true;
        if (value.promptName && value.promptVersion)
            return true;
        return false;
    });
    const UpdateGenerationBody = UpdateSpanBody.extend({
        completionStartTime: exports.stringDateTime,
        model: zod_1.z.string().nullish(),
        modelParameters: ModelParameters,
        usage: exports.usage,
        usageDetails: exports.UsageDetails,
        costDetails: CostDetails,
        promptName: zod_1.z.string().nullish(),
        promptVersion: zod_1.z.number().int().nullish(),
    }).refine((value) => {
        // ensure that either promptName and promptVersion are set, or none
        if (!value.promptName && !value.promptVersion)
            return true;
        if (value.promptName && value.promptVersion)
            return true;
        return false;
    });
    const BaseScoreBody = zod_1.z.object({
        id: exports.idSchema.nullish(),
        name: zod_2.NonEmptyString,
        traceId: zod_1.z.string().nullish(),
        sessionId: zod_1.z.string().nullish(),
        datasetRunId: zod_1.z.string().nullish(),
        environment: environmentSchema,
        observationId: zod_1.z.string().nullish(),
        comment: zod_1.z.string().nullish(),
        metadata: zod_2.jsonSchema.nullish(),
        source: zod_1.z
            .enum(["API", "EVAL", "ANNOTATION"])
            .default("API"),
        executionTraceId: zod_1.z.string().nullish(),
        queueId: zod_1.z.string().nullish(),
    });
    const ScoreBody = (0, scores_2.applyScoreValidation)(zod_1.z.discriminatedUnion("dataType", [
        BaseScoreBody.extend(zod_1.z.object({
            value: zod_1.z.number(),
            dataType: zod_1.z.literal("NUMERIC"),
            configId: zod_1.z.string().nullish(),
        }).shape),
        BaseScoreBody.extend(zod_1.z.object({
            value: zod_1.z.string(),
            dataType: zod_1.z.literal("CATEGORICAL"),
            configId: zod_1.z.string().nullish(),
        }).shape),
        BaseScoreBody.extend(zod_1.z.object({
            value: zod_1.z.number().refine((value) => value === 0 || value === 1, {
                message: "Value must be a number equal to either 0 or 1 for data type BOOLEAN",
            }),
            dataType: zod_1.z.literal("BOOLEAN"),
            configId: zod_1.z.string().nullish(),
        }).shape),
        BaseScoreBody.extend(zod_1.z.object({
            value: zod_1.z.string(),
            dataType: zod_1.z.literal("CORRECTION"),
            configId: zod_1.z.undefined().nullish(), // Cannot have config
        }).shape),
        BaseScoreBody.extend(zod_1.z.object({
            value: zod_1.z.string().min(1).max(scores_1.TEXT_SCORE_MAX_LENGTH),
            dataType: zod_1.z.literal("TEXT"),
            configId: zod_1.z.string().nullish(),
        }).shape),
        BaseScoreBody.extend(zod_1.z.object({
            value: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]),
            dataType: zod_1.z.undefined().optional(),
            configId: zod_1.z.string().nullish(),
        }).shape),
    ]));
    const DatasetRunItemBody = zod_1.z.object({
        // Core identifiers
        id: exports.idSchema.nullish(),
        traceId: zod_1.z.string(),
        observationId: zod_1.z.string().nullish(),
        error: zod_1.z.string().nullish(),
        // Metadata (optional)
        createdAt: exports.stringDateTime.nullish(),
        // Dataset identification
        datasetId: zod_1.z.string(),
        // Run identification
        runId: zod_1.z.string(),
        // Dataset item identification
        datasetItemId: zod_1.z.string(),
        // Dataset version: User-provided timestamp for temporal queries (can be any version)
        datasetVersion: exports.stringDateTime.optional(),
    });
    // Event schemas
    const base = zod_1.z.object({
        id: exports.idSchema,
        timestamp: (0, zod_2.isoDateTime)({ offset: true }),
        metadata: zod_2.jsonSchema.nullish(),
    });
    const traceEvent = base.extend({
        type: zod_1.z.literal(exports.eventTypes.TRACE_CREATE),
        body: TraceBody,
    });
    const eventCreateEvent = base.extend({
        type: zod_1.z.literal(exports.eventTypes.EVENT_CREATE),
        body: CreateEventEvent,
    });
    const spanCreateEvent = base.extend({
        type: zod_1.z.literal(exports.eventTypes.SPAN_CREATE),
        body: CreateSpanBody,
    });
    const spanUpdateEvent = base.extend({
        type: zod_1.z.literal(exports.eventTypes.SPAN_UPDATE),
        body: UpdateSpanBody,
    });
    const generationCreateEvent = base.extend({
        type: zod_1.z.literal(exports.eventTypes.GENERATION_CREATE),
        body: CreateGenerationBody,
    });
    const generationUpdateEvent = base.extend({
        type: zod_1.z.literal(exports.eventTypes.GENERATION_UPDATE),
        body: UpdateGenerationBody,
    });
    const agentCreateEvent = base.extend({
        type: zod_1.z.literal(exports.eventTypes.AGENT_CREATE),
        body: CreateGenerationBody,
    });
    const toolCreateEvent = base.extend({
        type: zod_1.z.literal(exports.eventTypes.TOOL_CREATE),
        body: CreateGenerationBody,
    });
    const chainCreateEvent = base.extend({
        type: zod_1.z.literal(exports.eventTypes.CHAIN_CREATE),
        body: CreateGenerationBody,
    });
    const retrieverCreateEvent = base.extend({
        type: zod_1.z.literal(exports.eventTypes.RETRIEVER_CREATE),
        body: CreateGenerationBody,
    });
    const evaluatorCreateEvent = base.extend({
        type: zod_1.z.literal(exports.eventTypes.EVALUATOR_CREATE),
        body: CreateGenerationBody,
    });
    const embeddingCreateEvent = base.extend({
        type: zod_1.z.literal(exports.eventTypes.EMBEDDING_CREATE),
        body: CreateGenerationBody,
    });
    const guardrailCreateEvent = base.extend({
        type: zod_1.z.literal(exports.eventTypes.GUARDRAIL_CREATE),
        body: CreateGenerationBody,
    });
    const scoreEvent = base.extend({
        type: zod_1.z.literal(exports.eventTypes.SCORE_CREATE),
        body: ScoreBody,
    });
    const baseDatasetRunItemCreateEvent = base.extend({
        type: zod_1.z.literal(exports.eventTypes.DATASET_RUN_ITEM_CREATE),
        body: DatasetRunItemBody,
    });
    const datasetRunItemCreateEvent = isPublic
        ? baseDatasetRunItemCreateEvent.refine(() => false, {
            message: "Dataset run item creation is only allowed for internal usage",
        })
        : baseDatasetRunItemCreateEvent;
    const sdkLogEvent = base.extend({
        type: zod_1.z.literal(exports.eventTypes.SDK_LOG),
        body: exports.SdkLogEvent,
    });
    const legacyObservationCreateEvent = base.extend({
        type: zod_1.z.literal(exports.eventTypes.OBSERVATION_CREATE),
        body: exports.LegacyObservationBody,
    });
    const legacyObservationUpdateEvent = base.extend({
        type: zod_1.z.literal(exports.eventTypes.OBSERVATION_UPDATE),
        body: exports.LegacyObservationBody,
    });
    const ingestionEvent = zod_1.z.discriminatedUnion("type", [
        traceEvent,
        scoreEvent,
        eventCreateEvent,
        spanCreateEvent,
        spanUpdateEvent,
        generationCreateEvent,
        generationUpdateEvent,
        agentCreateEvent,
        toolCreateEvent,
        chainCreateEvent,
        retrieverCreateEvent,
        evaluatorCreateEvent,
        embeddingCreateEvent,
        guardrailCreateEvent,
        sdkLogEvent,
        datasetRunItemCreateEvent,
        // LEGACY, only required for backwards compatibility
        legacyObservationCreateEvent,
        legacyObservationUpdateEvent,
    ]);
    return {
        // Body schemas
        TraceBody,
        OptionalObservationBody,
        CreateEventEvent,
        UpdateEventEvent,
        CreateSpanBody,
        UpdateSpanBody,
        CreateGenerationBody,
        UpdateGenerationBody,
        BaseScoreBody,
        ScoreBody,
        // Event schemas
        traceEvent,
        eventCreateEvent,
        spanCreateEvent,
        spanUpdateEvent,
        generationCreateEvent,
        generationUpdateEvent,
        agentCreateEvent,
        toolCreateEvent,
        chainCreateEvent,
        retrieverCreateEvent,
        evaluatorCreateEvent,
        embeddingCreateEvent,
        guardrailCreateEvent,
        scoreEvent,
        datasetRunItemCreateEvent,
        sdkLogEvent,
        legacyObservationCreateEvent,
        legacyObservationUpdateEvent,
        // Complete schema
        ingestionEvent,
    };
};
// Create both public and internal schema instances
const publicSchemas = createAllIngestionSchemas({ isPublic: true });
const internalSchemas = createAllIngestionSchemas({ isPublic: false });
// Export individual schemas for backwards compatibility
exports.TraceBody = publicSchemas.TraceBody;
exports.OptionalObservationBody = publicSchemas.OptionalObservationBody;
exports.CreateEventEvent = publicSchemas.CreateEventEvent;
exports.UpdateEventEvent = publicSchemas.UpdateEventEvent;
exports.CreateSpanBody = publicSchemas.CreateSpanBody;
exports.UpdateSpanBody = publicSchemas.UpdateSpanBody;
exports.CreateGenerationBody = publicSchemas.CreateGenerationBody;
exports.UpdateGenerationBody = publicSchemas.UpdateGenerationBody;
exports.BaseScoreBody = publicSchemas.BaseScoreBody;
/**
 * ScoreBody exactly mirrors `PostScoresBody` in the public API. Please refer there for source of truth.
 */
exports.ScoreBody = publicSchemas.ScoreBody;
// Export individual event schemas for backwards compatibility
exports.traceEvent = publicSchemas.traceEvent;
exports.eventCreateEvent = publicSchemas.eventCreateEvent;
exports.spanCreateEvent = publicSchemas.spanCreateEvent;
exports.spanUpdateEvent = publicSchemas.spanUpdateEvent;
exports.generationCreateEvent = publicSchemas.generationCreateEvent;
exports.generationUpdateEvent = publicSchemas.generationUpdateEvent;
exports.agentCreateEvent = publicSchemas.agentCreateEvent;
exports.toolCreateEvent = publicSchemas.toolCreateEvent;
exports.chainCreateEvent = publicSchemas.chainCreateEvent;
exports.retrieverCreateEvent = publicSchemas.retrieverCreateEvent;
exports.evaluatorCreateEvent = publicSchemas.evaluatorCreateEvent;
exports.embeddingCreateEvent = publicSchemas.embeddingCreateEvent;
exports.guardrailCreateEvent = publicSchemas.guardrailCreateEvent;
exports.scoreEvent = publicSchemas.scoreEvent;
exports.sdkLogEvent = publicSchemas.sdkLogEvent;
exports.datasetRunItemCreateEvent = publicSchemas.datasetRunItemCreateEvent;
exports.legacyObservationCreateEvent = publicSchemas.legacyObservationCreateEvent;
exports.legacyObservationUpdateEvent = publicSchemas.legacyObservationUpdateEvent;
/** @deprecated Use createIngestionEventSchema() instead */
exports.ingestionEvent = publicSchemas.ingestionEvent;
/**
 * Creates an ingestion event schema with appropriate environment validation.
 * @param isLangfuseInternal - Whether the events are being ingested by Langfuse internally (e.g. traces created for prompt experiments).
 * @returns The ingestion event schema.
 */
const createIngestionEventSchema = (isLangfuseInternal = false) => {
    return isLangfuseInternal
        ? internalSchemas.ingestionEvent
        : publicSchemas.ingestionEvent;
};
exports.createIngestionEventSchema = createIngestionEventSchema;
