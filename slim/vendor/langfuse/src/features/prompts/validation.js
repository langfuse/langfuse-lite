"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PromptNameSchema = void 0;
const zod_1 = require("../../utils/zod");
const validation_1 = require("../folders/validation");
const constants_1 = require("./constants");
/**
 * Prompt name validation schema for API, tRPC and client
 */
exports.PromptNameSchema = (0, validation_1.withFolderPathValidation)(zod_1.StringNoHTMLNonEmpty.regex(constants_1.PROMPT_NAME_PIPE_RESTRICTION_REGEX, 
// Note: pipe character is used for prompt composition
constants_1.PROMPT_NAME_PIPE_RESTRICTION_ERROR)).refine(
// Reserved: names of the static /prompts/* pages (see RESERVED_PROMPT_NAMES).
// Only the exact name collides — "metrics/foo" or "foo/metrics" route
// through the [[...folder]] catch-all.
(name) => !constants_1.RESERVED_PROMPT_NAMES.includes(name), { error: (issue) => `Prompt name cannot be '${issue.input}'` });
