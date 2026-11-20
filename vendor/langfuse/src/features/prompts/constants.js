"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROMPT_LABEL_REGEX_ERROR = exports.PROMPT_LABEL_REGEX = exports.PROMPT_LABEL_MAX_LENGTH = exports.PROMPT_NAME_PIPE_RESTRICTION_ERROR = exports.PROMPT_NAME_PIPE_RESTRICTION_REGEX = exports.RESERVED_PROMPT_NAMES = exports.RESERVED_PROMPT_NAME_NEW = exports.PROMPT_NAME_MAX_LENGTH = exports.COMMIT_MESSAGE_MAX_LENGTH = exports.LATEST_PROMPT_LABEL = exports.PRODUCTION_LABEL = void 0;
exports.PRODUCTION_LABEL = "production";
exports.LATEST_PROMPT_LABEL = "latest";
exports.COMMIT_MESSAGE_MAX_LENGTH = 500;
// Prompt name validation
exports.PROMPT_NAME_MAX_LENGTH = 255;
exports.RESERVED_PROMPT_NAME_NEW = "new";
// Static sibling pages of the /prompts/[[...folder]] catch-all route
// (web/src/pages/project/[projectId]/prompts/). Next.js resolves static
// routes before the catch-all, so a prompt with one of these exact names
// would have every link to it render the static page instead.
exports.RESERVED_PROMPT_NAMES = [
    exports.RESERVED_PROMPT_NAME_NEW,
    "metrics",
    "prompt-detail",
];
exports.PROMPT_NAME_PIPE_RESTRICTION_REGEX = /^[^|]*$/;
exports.PROMPT_NAME_PIPE_RESTRICTION_ERROR = "Prompt name cannot contain '|' character";
// Prompt label validation
exports.PROMPT_LABEL_MAX_LENGTH = 36;
exports.PROMPT_LABEL_REGEX = /^[a-z0-9_\-.]+$/;
exports.PROMPT_LABEL_REGEX_ERROR = "Label must be lowercase alphanumeric with optional underscores, hyphens, or periods";
