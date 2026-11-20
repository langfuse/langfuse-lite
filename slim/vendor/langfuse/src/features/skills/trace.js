"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SkillsResourceLoadedSchema = exports.SkillsAvailableInputSchema = exports.SkillsAvailableSchema = exports.MAX_SKILLS_PER_OBSERVATION = void 0;
const v4_1 = require("zod/v4");
const types_1 = require("./types");
exports.MAX_SKILLS_PER_OBSERVATION = 100;
exports.SkillsAvailableSchema = v4_1.z
    .array(v4_1.z.object({
    langfuseSkillId: v4_1.z.string().min(1).max(256).nullish(),
    skillName: v4_1.z.string().min(1).max(128),
    skillVersion: v4_1.z.number().int().min(1).max(2_147_483_647).nullish(),
}))
    .max(exports.MAX_SKILLS_PER_OBSERVATION);
exports.SkillsAvailableInputSchema = v4_1.z
    .array(v4_1.z.union([
    v4_1.z.object({
        name: exports.SkillsAvailableSchema.element.shape.skillName,
        version: exports.SkillsAvailableSchema.element.shape.skillVersion,
    }),
    v4_1.z
        .object({
        skillName: exports.SkillsAvailableSchema.element.shape.skillName,
        skillVersion: exports.SkillsAvailableSchema.element.shape.skillVersion,
    })
        .transform(({ skillName, skillVersion }) => ({
        name: skillName,
        version: skillVersion,
    })),
]))
    .max(exports.MAX_SKILLS_PER_OBSERVATION);
exports.SkillsResourceLoadedSchema = v4_1.z
    .array(v4_1.z.object({
    langfuseSkillId: v4_1.z.string().min(1).max(256).nullish(),
    filePath: types_1.SkillFilePathSchema,
    skillName: v4_1.z.string().min(1).max(128),
    skillVersion: v4_1.z.number().int().min(1).max(2_147_483_647).nullish(),
}))
    .max(exports.MAX_SKILLS_PER_OBSERVATION);
