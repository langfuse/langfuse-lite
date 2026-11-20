"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TraceDomain = exports.MetadataDomain = void 0;
const zod_1 = __importDefault(require("zod"));
const zod_2 = require("../utils/zod");
exports.MetadataDomain = zod_1.default.record(zod_1.default.string(), zod_2.jsonSchemaNullable.or(zod_1.default.undefined()));
// to be used across the application in frontend and backend.
exports.TraceDomain = zod_1.default.object({
    id: zod_1.default.string(),
    name: zod_1.default.string().nullable(),
    timestamp: zod_1.default.date(),
    environment: zod_1.default.string(),
    tags: zod_1.default.array(zod_1.default.string()),
    bookmarked: zod_1.default.boolean(),
    public: zod_1.default.boolean(),
    release: zod_1.default.string().nullable(),
    version: zod_1.default.string().nullable(),
    input: zod_2.jsonSchema.nullable(),
    output: zod_2.jsonSchema.nullable(),
    metadata: exports.MetadataDomain,
    createdAt: zod_1.default.date(),
    updatedAt: zod_1.default.date(),
    sessionId: zod_1.default.string().nullable(),
    userId: zod_1.default.string().nullable(),
    projectId: zod_1.default.string(),
});
