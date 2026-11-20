"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGenerationLikeTypes = exports.isGenerationLike = exports.EventsObservationSchema = exports.ObservationSchema = exports.ObservationDomain = exports.ObservationLevelDomain = exports.ObservationLevel = exports.ObservationTypeDomain = exports.ObservationType = void 0;
const zod_1 = __importDefault(require("zod"));
const zod_2 = require("../utils/zod");
const traces_1 = require("./traces");
const trace_1 = require("../features/skills/trace");
exports.ObservationType = {
    SPAN: "SPAN",
    EVENT: "EVENT",
    GENERATION: "GENERATION",
    AGENT: "AGENT",
    TOOL: "TOOL",
    CHAIN: "CHAIN",
    RETRIEVER: "RETRIEVER",
    EVALUATOR: "EVALUATOR",
    EMBEDDING: "EMBEDDING",
    GUARDRAIL: "GUARDRAIL",
};
exports.ObservationTypeDomain = zod_1.default.enum([
    "SPAN",
    "EVENT",
    "GENERATION",
    "AGENT",
    "TOOL",
    "CHAIN",
    "RETRIEVER",
    "EVALUATOR",
    "EMBEDDING",
    "GUARDRAIL",
]);
exports.ObservationLevel = {
    DEBUG: "DEBUG",
    DEFAULT: "DEFAULT",
    WARNING: "WARNING",
    ERROR: "ERROR",
};
exports.ObservationLevelDomain = zod_1.default.enum([
    "DEBUG",
    "DEFAULT",
    "WARNING",
    "ERROR",
]);
exports.ObservationDomain = zod_1.default.object({
    id: zod_1.default.string(),
    name: zod_1.default.string(),
    timestamp: zod_1.default.date(),
    environment: zod_1.default.string(),
    tags: zod_1.default.array(zod_1.default.string()),
});
exports.ObservationSchema = zod_1.default.object({
    id: zod_1.default.string(),
    traceId: zod_1.default.string().nullable(),
    projectId: zod_1.default.string(),
    environment: zod_1.default.string(),
    type: exports.ObservationTypeDomain,
    startTime: zod_1.default.date(),
    endTime: zod_1.default.date().nullable(),
    name: zod_1.default.string().nullable(),
    metadata: traces_1.MetadataDomain,
    parentObservationId: zod_1.default.string().nullable(),
    level: exports.ObservationLevelDomain,
    statusMessage: zod_1.default.string().nullable(),
    version: zod_1.default.string().nullable(),
    createdAt: zod_1.default.date(),
    updatedAt: zod_1.default.date(),
    model: zod_1.default.string().nullable(),
    internalModelId: zod_1.default.string().nullable(),
    modelParameters: zod_2.jsonSchema.nullable(),
    input: zod_2.jsonSchema.nullable(),
    output: zod_2.jsonSchema.nullable(),
    completionStartTime: zod_1.default.date().nullable(),
    promptId: zod_1.default.string().nullable(),
    promptName: zod_1.default.string().nullable(),
    promptVersion: zod_1.default.number().nullable(),
    latency: zod_1.default.number().nullable(),
    timeToFirstToken: zod_1.default.number().nullable(),
    providedUsageDetails: zod_1.default.record(zod_1.default.string(), zod_1.default.number()),
    usageDetails: zod_1.default.record(zod_1.default.string(), zod_1.default.number()),
    costDetails: zod_1.default.record(zod_1.default.string(), zod_1.default.number()),
    providedCostDetails: zod_1.default.record(zod_1.default.string(), zod_1.default.number()),
    // aggregated data from cost_details
    inputCost: zod_1.default.number().nullable(),
    outputCost: zod_1.default.number().nullable(),
    totalCost: zod_1.default.number().nullable(),
    // aggregated data from usage_details
    inputUsage: zod_1.default.number(),
    outputUsage: zod_1.default.number(),
    totalUsage: zod_1.default.number(),
    // pricing tier information
    usagePricingTierId: zod_1.default.string().nullable(),
    usagePricingTierName: zod_1.default.string().nullable(),
    // tool data
    toolDefinitions: zod_1.default.record(zod_1.default.string(), zod_1.default.string()).nullable(),
    toolCalls: zod_1.default.array(zod_1.default.string()).nullable(),
    toolCallNames: zod_1.default.array(zod_1.default.string()).nullable(),
    skillsAvailable: trace_1.SkillsAvailableSchema.optional(),
    skillsResourceLoaded: trace_1.SkillsResourceLoadedSchema.optional(),
});
exports.EventsObservationSchema = exports.ObservationSchema.extend({
    userId: zod_1.default.string().nullable(),
    sessionId: zod_1.default.string().nullable(),
    isRootObservation: zod_1.default.boolean().optional(),
    traceName: zod_1.default.string().nullable(),
    release: zod_1.default.string().nullable().optional(),
    tags: zod_1.default.array(zod_1.default.string()).nullable().optional(),
    bookmarked: zod_1.default.boolean().optional(),
    public: zod_1.default.boolean().optional(),
});
/**
 * Returns true if an observation type is generation-like, meaning it could include LLM calls
 * and potentially has similar input/output fields.
 */
const GenerationLikeObservationTypes = [
    exports.ObservationType.GENERATION,
    exports.ObservationType.AGENT,
    exports.ObservationType.TOOL,
    exports.ObservationType.CHAIN,
    exports.ObservationType.RETRIEVER,
    exports.ObservationType.EVALUATOR,
    exports.ObservationType.EMBEDDING,
    exports.ObservationType.GUARDRAIL,
];
const isGenerationLike = (observationType) => {
    return GenerationLikeObservationTypes.includes(observationType);
};
exports.isGenerationLike = isGenerationLike;
/**
 * Returns all generation-like observation types for use in filters and queries.
 */
const getGenerationLikeTypes = () => {
    return [...GenerationLikeObservationTypes];
};
exports.getGenerationLikeTypes = getGenerationLikeTypes;
