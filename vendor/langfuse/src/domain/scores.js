"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CORRECTION_SCORES_BILLABLE_FROM = exports.LISTABLE_SCORE_TYPES = exports.AGGREGATABLE_SCORE_TYPES = exports.ScoreSchema = exports.ScoreSchemaExclReferencesAndDates = exports.TextData = exports.BooleanData = exports.CategoricalData = exports.NumericData = exports.ScoreDataTypeDomain = exports.ScoreDataTypeEnum = exports.ScoreDataTypeArray = exports.TEXT_SCORE_MAX_LENGTH = exports.CORRECTION_NAME = exports.isAnnotationScoreMissingConfigId = exports.ANNOTATION_SCORE_REQUIRES_CONFIG_ID_MESSAGE = exports.PublicApiCreateScoreSourceDomain = exports.ScoreSourceDomain = exports.ScoreSourceEnum = exports.ScoreSourceArray = void 0;
/* eslint-disable @typescript-eslint/no-use-before-define */
const zod_1 = __importDefault(require("zod"));
const traces_1 = require("./traces");
exports.ScoreSourceArray = ["API", "EVAL", "ANNOTATION"];
exports.ScoreSourceEnum = {
    API: "API",
    EVAL: "EVAL",
    ANNOTATION: "ANNOTATION",
};
exports.ScoreSourceDomain = zod_1.default.enum(exports.ScoreSourceArray);
/**
 * Source values external callers may set on the public create-score endpoint.
 * EVAL is reserved for internal evaluator outputs. The `satisfies` clause
 * keeps this a provable subset of {@link ScoreSourceArray} at compile time.
 */
exports.PublicApiCreateScoreSourceDomain = zod_1.default.enum([
    exports.ScoreSourceEnum.API,
    exports.ScoreSourceEnum.ANNOTATION,
]);
/**
 * Annotation scores need a matching score config so they can render in the
 * annotation queue UI. CORRECTION scores are the one exception — by design
 * they never carry a configId. This predicate + message are shared by the
 * zod refine on {@link PostScoresBody} (sync 400 on REST) and the check in
 * `validateAndInflateScore` (async drop for ingestion/SDK callers).
 */
exports.ANNOTATION_SCORE_REQUIRES_CONFIG_ID_MESSAGE = "configId is required when source is ANNOTATION (except for CORRECTION scores).";
const isAnnotationScoreMissingConfigId = (body) => body.source === exports.ScoreSourceEnum.ANNOTATION &&
    !body.configId &&
    body.dataType !== exports.ScoreDataTypeEnum.CORRECTION;
exports.isAnnotationScoreMissingConfigId = isAnnotationScoreMissingConfigId;
exports.CORRECTION_NAME = "output";
exports.TEXT_SCORE_MAX_LENGTH = 500;
exports.ScoreDataTypeArray = [
    "NUMERIC",
    "CATEGORICAL",
    "BOOLEAN",
    "CORRECTION",
    "TEXT",
];
exports.ScoreDataTypeEnum = {
    NUMERIC: "NUMERIC",
    CATEGORICAL: "CATEGORICAL",
    BOOLEAN: "BOOLEAN",
    CORRECTION: "CORRECTION",
    TEXT: "TEXT",
};
exports.ScoreDataTypeDomain = zod_1.default.enum(exports.ScoreDataTypeArray);
exports.NumericData = zod_1.default.object({
    stringValue: zod_1.default.null().optional(),
    dataType: zod_1.default.literal("NUMERIC"),
});
exports.CategoricalData = zod_1.default.object({
    stringValue: zod_1.default.string(),
    dataType: zod_1.default.literal("CATEGORICAL"),
});
exports.BooleanData = zod_1.default.object({
    stringValue: zod_1.default.string(),
    dataType: zod_1.default.literal("BOOLEAN"),
});
const CorrectionData = zod_1.default.object({
    stringValue: zod_1.default.null(),
    dataType: zod_1.default.literal("CORRECTION"),
});
exports.TextData = zod_1.default.object({
    stringValue: zod_1.default.string().min(1).max(exports.TEXT_SCORE_MAX_LENGTH),
    dataType: zod_1.default.literal("TEXT"),
});
// Only used for backwards compatibility with old score API schemas
exports.ScoreSchemaExclReferencesAndDates = zod_1.default.object({
    // Core identifiers
    id: zod_1.default.string(),
    projectId: zod_1.default.string(),
    // Metadata
    environment: zod_1.default.string(),
    // Score data
    name: zod_1.default.string(),
    value: zod_1.default.number(),
    source: exports.ScoreSourceDomain,
    authorUserId: zod_1.default.string().nullable(),
    comment: zod_1.default.string().nullable(),
    metadata: traces_1.MetadataDomain,
    // Score associations
    configId: zod_1.default.string().nullable(),
    queueId: zod_1.default.string().nullable(),
    // Score execution
    executionTraceId: zod_1.default.string().nullable(),
});
const ScoreFoundationSchema = exports.ScoreSchemaExclReferencesAndDates.and(zod_1.default.object({
    // Timestamps
    createdAt: zod_1.default.date(),
    updatedAt: zod_1.default.date(),
    timestamp: zod_1.default.date(),
    // Score references; one of the following must be provided
    traceId: zod_1.default.string().nullable(),
    sessionId: zod_1.default.string().nullable(),
    datasetRunId: zod_1.default.string().nullable(),
    observationId: zod_1.default.string().nullable(),
    longStringValue: zod_1.default.string().default(""),
}));
exports.ScoreSchema = ScoreFoundationSchema.and(zod_1.default.discriminatedUnion("dataType", [
    exports.NumericData,
    exports.CategoricalData,
    exports.BooleanData,
    CorrectionData,
    exports.TextData,
]));
// Aggregatable score types - used in most read queries to exclude CORRECTION scores
exports.AGGREGATABLE_SCORE_TYPES = [
    "NUMERIC",
    "BOOLEAN",
    "CATEGORICAL",
];
exports.LISTABLE_SCORE_TYPES = [
    "NUMERIC",
    "BOOLEAN",
    "CATEGORICAL",
    "TEXT",
];
/**
 * CORRECTION scores count as billable usage when `created_at` is at or after
 * this instant. Each stored row counts. Earlier CORRECTION scores stay out
 * of billing counts.
 *
 * 2026-11-23T00:00:00.000Z is 01:00 on that date in Europe/Zurich (CET, UTC+1),
 * a UTC hour boundary and a UTC day boundary.
 */
exports.CORRECTION_SCORES_BILLABLE_FROM = new Date("2026-11-23T00:00:00.000Z");
