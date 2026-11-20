"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LegacyPromptSchema = exports.LegacyCreatePromptSchema = exports.PromptSchema = exports.ChatPromptSchema = exports.BaseChatPromptSchema = exports.TextPromptSchema = exports.GetPromptByNameSchema = exports.GetPromptSchema = exports.GetPromptsMetaSchema = exports.CreatePromptTRPCSchema = exports.CreatePromptSchema = exports.CreateChatPromptSchema = exports.CreateTextPromptSchema = exports.PromptLabelSchema = exports.PromptType = exports.SingleChatMessageSchema = void 0;
const zod_1 = require("zod");
const zod_2 = require("../../utils/zod");
const filters_1 = require("../../interfaces/filters");
const constants_1 = require("./constants");
const types_1 = require("../../server/llm/types");
const validation_1 = require("./validation");
exports.SingleChatMessageSchema = types_1.PromptChatMessageSchema;
var PromptType;
(function (PromptType) {
    PromptType["Chat"] = "chat";
    PromptType["Text"] = "text";
})(PromptType || (exports.PromptType = PromptType = {}));
exports.PromptLabelSchema = zod_1.z
    .string()
    .min(1)
    .max(constants_1.PROMPT_LABEL_MAX_LENGTH)
    .regex(constants_1.PROMPT_LABEL_REGEX, constants_1.PROMPT_LABEL_REGEX_ERROR);
const BaseCreateTextPromptSchema = zod_1.z.object({
    name: validation_1.PromptNameSchema,
    labels: zod_1.z.array(exports.PromptLabelSchema).default([]),
    type: zod_1.z.literal(PromptType.Text).optional(),
    prompt: zod_1.z.string(),
    config: zod_2.jsonSchema.nullable().default({}),
    tags: zod_1.z.array(zod_1.z.string()).nullish(),
});
const LegacyCreateTextPromptSchema = BaseCreateTextPromptSchema;
exports.CreateTextPromptSchema = BaseCreateTextPromptSchema.extend({
    commitMessage: zod_1.z.string().max(constants_1.COMMIT_MESSAGE_MAX_LENGTH).nullish(),
});
const BaseCreateChatPromptSchema = zod_1.z.object({
    name: validation_1.PromptNameSchema,
    labels: zod_1.z.array(exports.PromptLabelSchema).default([]),
    type: zod_1.z.literal(PromptType.Chat),
    prompt: zod_1.z.array(types_1.PromptChatMessageSchema),
    config: zod_2.jsonSchema.nullable().default({}),
    tags: zod_1.z.array(zod_1.z.string()).nullish(),
});
const LegacyCreateChatPromptSchema = BaseCreateChatPromptSchema;
exports.CreateChatPromptSchema = BaseCreateChatPromptSchema.extend({
    commitMessage: zod_1.z.string().max(constants_1.COMMIT_MESSAGE_MAX_LENGTH).nullish(),
});
exports.CreatePromptSchema = zod_1.z.union([
    exports.CreateTextPromptSchema,
    exports.CreateChatPromptSchema,
]);
// TRPC route requires projectId
const CreateTextPromptTRPCSchema = exports.CreateTextPromptSchema.extend({
    projectId: zod_1.z.string(),
});
const CreateChatPromptTRPCSchema = exports.CreateChatPromptSchema.extend({
    projectId: zod_1.z.string(),
});
exports.CreatePromptTRPCSchema = zod_1.z.union([
    CreateTextPromptTRPCSchema,
    CreateChatPromptTRPCSchema,
]);
const promptFilterSchema = zod_1.z.preprocess(filters_1.coerceLegacyEmptyMetadataFilters, zod_1.z.array(zod_1.z.discriminatedUnion("type", [
    filters_1.stringFilter.extend({ column: zod_1.z.enum(["id", "name", "type"]) }),
    filters_1.stringOptionsFilter.safeExtend({
        column: zod_1.z.enum(["id", "name", "type"]),
    }),
    filters_1.numberFilter.extend({ column: zod_1.z.literal("version") }),
    filters_1.timeFilter.extend({ column: zod_1.z.enum(["createdAt", "updatedAt"]) }),
    filters_1.arrayOptionsFilter.safeExtend({
        column: zod_1.z.enum(["labels", "tags"]),
        value: zod_1.z.array(zod_1.z.string()).min(1),
    }),
    filters_1.stringObjectFilter.extend({ column: zod_1.z.literal("config") }),
])));
exports.GetPromptsMetaSchema = zod_1.z.object({
    name: zod_1.z.string().optional(),
    version: zod_1.z.coerce.number().int().nullish(),
    label: zod_1.z.string().optional(),
    tag: zod_1.z.string().optional(),
    page: zod_1.z.coerce.number().int().min(1).default(1),
    limit: zod_1.z.coerce.number().int().min(1).max(100).default(10),
    fromUpdatedAt: (0, zod_2.isoDateTime)({ offset: true }).nullish(),
    toUpdatedAt: (0, zod_2.isoDateTime)({ offset: true }).nullish(),
    filter: (0, zod_2.optionalJsonParam)(promptFilterSchema, "filter"),
});
exports.GetPromptSchema = zod_1.z.object({
    name: zod_1.z.string().transform((v) => decodeURIComponent(v)),
    version: zod_1.z.coerce.number().int().nullish(),
});
exports.GetPromptByNameSchema = zod_1.z.object({
    promptName: zod_1.z.string(),
    version: zod_1.z.coerce.number().int().nullish(),
    label: zod_1.z.string().optional(),
    resolve: zod_1.z
        .enum(["true", "false"])
        .nullish()
        .default("true")
        .transform((v) => v === "true"), // Optional, defaults to true for backward compatibility
});
const BaseTextPromptSchema = zod_1.z.object({
    id: zod_1.z.string(),
    createdAt: zod_1.z.date(),
    updatedAt: zod_1.z.date(),
    projectId: zod_1.z.string(),
    createdBy: zod_1.z.string(),
    version: zod_1.z.number(),
    name: zod_1.z.string(),
    labels: zod_1.z.array(exports.PromptLabelSchema),
    tags: zod_1.z.array(zod_1.z.string()),
    type: zod_1.z.literal(PromptType.Text),
    prompt: zod_1.z.string(),
    config: zod_2.jsonSchema,
});
const LegacyTextPromptSchema = BaseTextPromptSchema;
exports.TextPromptSchema = BaseTextPromptSchema.extend({
    commitMessage: zod_1.z.string().max(constants_1.COMMIT_MESSAGE_MAX_LENGTH).nullish(),
});
exports.BaseChatPromptSchema = zod_1.z.object({
    id: zod_1.z.string(),
    createdAt: zod_1.z.date(),
    updatedAt: zod_1.z.date(),
    projectId: zod_1.z.string(),
    createdBy: zod_1.z.string(),
    version: zod_1.z.number(),
    name: zod_1.z.string(),
    tags: zod_1.z.array(zod_1.z.string()),
    labels: zod_1.z.array(exports.PromptLabelSchema),
    type: zod_1.z.literal(PromptType.Chat),
    prompt: zod_1.z.array(types_1.PromptChatMessageSchema),
    config: zod_2.jsonSchema,
});
const LegacyChatPromptSchema = exports.BaseChatPromptSchema;
exports.ChatPromptSchema = exports.BaseChatPromptSchema.extend({
    commitMessage: zod_1.z.string().max(constants_1.COMMIT_MESSAGE_MAX_LENGTH).nullish(),
});
exports.PromptSchema = zod_1.z.union([exports.TextPromptSchema, exports.ChatPromptSchema]);
// Backward compat for V1 prompts endpoint
exports.LegacyCreatePromptSchema = zod_1.z.union([
    LegacyCreateTextPromptSchema.extend({ isActive: zod_1.z.boolean() }),
    LegacyCreateChatPromptSchema.extend({ isActive: zod_1.z.boolean() }),
]);
exports.LegacyPromptSchema = zod_1.z.union([
    LegacyTextPromptSchema.extend({ isActive: zod_1.z.boolean() }),
    LegacyChatPromptSchema.extend({ isActive: zod_1.z.boolean() }),
]);
