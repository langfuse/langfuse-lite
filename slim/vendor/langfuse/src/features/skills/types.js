"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeleteSkillVersionResponseSchema = exports.ListSkillsResponseSchema = exports.SkillMetaSchema = exports.SkillVersionSchema = exports.SkillFileSchema = exports.UpdateSkillTagsBodySchema = exports.UpdateSkillLabelsBodySchema = exports.ListSkillsQuerySchema = exports.SkillSelectorSchema = exports.CreateSkillVersionBodySchema = exports.SkillTagsSchema = exports.SkillVersionFileReferenceSchema = exports.SkillVersionFileInputSchema = exports.SkillFileContentSchema = exports.SkillFilePathSchema = exports.SkillDescriptionSchema = exports.SkillNameSchema = void 0;
const v4_1 = require("zod/v4");
const zod_1 = require("../../utils/zod");
const types_1 = require("../prompts/types");
const constants_1 = require("../prompts/constants");
const constants_2 = require("./constants");
exports.SkillNameSchema = v4_1.z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Skill names may only contain lowercase letters, numbers, and single hyphens");
exports.SkillDescriptionSchema = v4_1.z.string().trim().min(1).max(1024);
exports.SkillFilePathSchema = v4_1.z
    .string()
    .min(1)
    .max(constants_2.MAX_SKILL_PATH_LENGTH)
    .superRefine((path, ctx) => {
    const segments = path.split("/");
    const hasControlCharacters = [...path].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127;
    });
    if (path.startsWith("/") ||
        path.endsWith("/") ||
        path.includes("\\") ||
        hasControlCharacters ||
        segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
        ctx.addIssue({
            code: "custom",
            message: "File paths must be normalized relative POSIX paths",
        });
    }
});
exports.SkillFileContentSchema = v4_1.z
    .string()
    .transform((content) => content.replace(/^\uFEFF+/, ""))
    .superRefine((content, ctx) => {
    if (content.includes("\0")) {
        ctx.addIssue({
            code: "custom",
            message: "Skill files must not contain NUL characters",
        });
    }
    if (!content.isWellFormed()) {
        ctx.addIssue({
            code: "custom",
            message: "Skill files must contain well-formed Unicode text",
        });
    }
});
const SKILL_TEXT_FILE_EXTENSIONS = new Set([
    "md",
    "markdown",
    "mdx",
    "txt",
    "rst",
    "adoc",
    "json",
    "jsonc",
    "jsonl",
    "ndjson",
    "yaml",
    "yml",
    "toml",
    "xml",
    "csv",
    "tsv",
    "ini",
    "cfg",
    "conf",
    "properties",
    "log",
    "html",
    "htm",
    "css",
    "scss",
    "sass",
    "less",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "ts",
    "tsx",
    "py",
    "pyi",
    "sh",
    "bash",
    "zsh",
    "fish",
    "ps1",
    "rb",
    "go",
    "rs",
    "java",
    "c",
    "h",
    "cc",
    "cpp",
    "hpp",
    "cs",
    "swift",
    "kt",
    "kts",
    "lua",
    "r",
    "pl",
    "php",
    "sql",
    "graphql",
    "gql",
    "tex",
]);
const SkillTextFilePathSchema = exports.SkillFilePathSchema.refine((path) => {
    const filename = path.split("/").at(-1);
    const extension = filename.includes(".")
        ? filename.split(".").at(-1).toLowerCase()
        : "";
    return SKILL_TEXT_FILE_EXTENSIONS.has(extension);
}, "Skill files must use a supported text file extension");
exports.SkillVersionFileInputSchema = v4_1.z.object({
    path: SkillTextFilePathSchema,
    content: exports.SkillFileContentSchema,
    sha256Hash: v4_1.z.never().optional(),
});
exports.SkillVersionFileReferenceSchema = v4_1.z.object({
    path: SkillTextFilePathSchema,
    sha256Hash: v4_1.z
        .string()
        .regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/, "Must be a canonical base64 encoded SHA-256 hash"),
    content: v4_1.z.never().optional(),
});
exports.SkillTagsSchema = v4_1.z
    .array(v4_1.z.string().trim().min(1).max(100))
    .max(50);
exports.CreateSkillVersionBodySchema = v4_1.z
    .object({
    files: v4_1.z
        .array(v4_1.z.union([exports.SkillVersionFileInputSchema, exports.SkillVersionFileReferenceSchema]))
        .min(1),
    commitMessage: v4_1.z.string().max(constants_1.COMMIT_MESSAGE_MAX_LENGTH).nullish(),
})
    // Size and file count limits are deployment config enforced by the server.
    .superRefine(({ files }, ctx) => {
    const paths = files.map((file) => file.path);
    if (new Set(paths).size !== paths.length) {
        ctx.addIssue({
            code: "custom",
            path: ["files"],
            message: "Skill file paths must be unique",
        });
    }
    if (!paths.includes("SKILL.md")) {
        ctx.addIssue({
            code: "custom",
            path: ["files"],
            message: "Every skill version must contain a root SKILL.md file",
        });
    }
});
exports.SkillSelectorSchema = v4_1.z
    .object({
    version: v4_1.z.coerce.number().int().positive().optional(),
    label: types_1.PromptLabelSchema.optional(),
})
    .refine(({ version, label }) => !(version && label), {
    message: "Specify either version or label, not both",
});
exports.ListSkillsQuerySchema = v4_1.z.object({
    name: exports.SkillNameSchema.optional(),
    search: v4_1.z.string().max(1000).optional(),
    tag: v4_1.z.string().optional(),
    page: v4_1.z.coerce.number().int().min(1).default(1),
    limit: v4_1.z.coerce.number().int().min(1).max(100).default(10),
    fromUpdatedAt: (0, zod_1.isoDateTime)({ offset: true }).optional(),
    toUpdatedAt: (0, zod_1.isoDateTime)({ offset: true }).optional(),
});
exports.UpdateSkillLabelsBodySchema = v4_1.z.object({
    labels: v4_1.z
        .array(types_1.PromptLabelSchema)
        .refine((labels) => !labels.includes(constants_2.SKILL_LATEST_LABEL), {
        message: `The '${constants_2.SKILL_LATEST_LABEL}' label is managed by Langfuse`,
    }),
});
exports.UpdateSkillTagsBodySchema = v4_1.z.object({
    tags: exports.SkillTagsSchema,
});
exports.SkillFileSchema = v4_1.z.object({
    id: v4_1.z.string(),
    path: exports.SkillFilePathSchema,
    blobId: v4_1.z.string(),
    sha256Hash: v4_1.z.string(),
    contentType: v4_1.z.string(),
    contentLength: v4_1.z.number().int(),
});
exports.SkillVersionSchema = v4_1.z.object({
    id: v4_1.z.string(),
    createdAt: v4_1.z.coerce.date(),
    updatedAt: v4_1.z.coerce.date(),
    projectId: v4_1.z.string(),
    createdBy: v4_1.z.string(),
    name: exports.SkillNameSchema,
    description: exports.SkillDescriptionSchema,
    frontmatter: zod_1.jsonSchema,
    version: v4_1.z.number().int().positive(),
    tags: v4_1.z.array(v4_1.z.string()),
    labels: v4_1.z.array(types_1.PromptLabelSchema),
    commitMessage: v4_1.z.string().nullable(),
    files: v4_1.z.array(exports.SkillFileSchema),
});
exports.SkillMetaSchema = v4_1.z.object({
    name: exports.SkillNameSchema,
    description: exports.SkillDescriptionSchema,
    tags: v4_1.z.array(v4_1.z.string()),
    latestVersion: v4_1.z.number().int().positive(),
    latestVersionCreatedAt: v4_1.z.coerce.date(),
    latestVersionLastUpdatedAt: v4_1.z.coerce.date(),
    productionVersion: v4_1.z.number().int().positive().nullable(),
});
exports.ListSkillsResponseSchema = v4_1.z.object({
    data: v4_1.z.array(exports.SkillMetaSchema),
    meta: v4_1.z.object({
        page: v4_1.z.number().int(),
        limit: v4_1.z.number().int(),
        totalItems: v4_1.z.number().int(),
        totalPages: v4_1.z.number().int(),
        hasNextPage: v4_1.z.boolean(),
    }),
});
exports.DeleteSkillVersionResponseSchema = v4_1.z.object({
    deleted: v4_1.z.boolean(),
});
