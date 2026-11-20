"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.versionZod = exports.JSONArraySchema = exports.JSONObjectSchema = exports.JSONValueSchema = exports.JSONPrimitiveValueSchema = exports.validateZodSchema = exports.StringNoHTMLNonEmpty = exports.StringNoHTML = exports.htmlRegex = exports.NonEmptyString = exports.noUrlCheck = exports.urlRegex = exports.paginationMetaResponseZod = exports.deprecationResponseZod = exports.queryStringZod = exports.optionalPaginationZod = exports.optionalJsonParam = exports.optionalCommaSeparatedStringArray = exports.publicApiPaginationZod = exports.paginationZod = exports.publicApiPaginationLimitZod = exports.paginationLimitZod = exports.jsonSchema = exports.jsonSchemaNullable = void 0;
exports.isoDateTime = isoDateTime;
exports.commaSeparatedEnumArray = commaSeparatedEnumArray;
exports.sanitizeEmailSubject = sanitizeEmailSubject;
const zod_1 = require("zod");
const InvalidRequestError_1 = require("../errors/InvalidRequestError");
/** ISO datetimes with minutes, seconds, or fractional seconds; timezone required. */
function isoDateTime({ offset = false, error = "Invalid ISO datetime", } = {}) {
    // Share the date/time patterns once to keep tool schemas compact and union-free.
    const date = zod_1.z.regexes.date.source.slice(1, -1);
    const time = zod_1.z.regexes.time({}).source.slice(1, -1);
    const timezone = offset ? "(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)" : "Z";
    const pattern = new RegExp(`^${date}T${time}${timezone}$`);
    return zod_1.z.string({ error }).regex(pattern, { error });
}
// to be used for Prisma JSON type
// @see: https://github.com/colinhacks/zod#json-type
// For root-level literals where null is not allowed
const rootLiteralSchema = zod_1.z.union([zod_1.z.string(), zod_1.z.number(), zod_1.z.boolean()]);
// For nested literals where null is allowed
const nestedLiteralSchema = zod_1.z.union([
    zod_1.z.string(),
    zod_1.z.number(),
    zod_1.z.boolean(),
    zod_1.z.null(),
]);
// Here, you define the schema recursively
exports.jsonSchemaNullable = zod_1.z.lazy(() => zod_1.z.union([
    zod_1.z.array(exports.jsonSchemaNullable),
    zod_1.z.record(zod_1.z.string(), exports.jsonSchemaNullable),
    nestedLiteralSchema,
]));
// Root schema that does not allow nulls at the root level
exports.jsonSchema = zod_1.z.lazy(() => zod_1.z.union([
    zod_1.z.array(exports.jsonSchemaNullable),
    zod_1.z.record(zod_1.z.string(), exports.jsonSchemaNullable),
    rootLiteralSchema,
]));
exports.paginationLimitZod = zod_1.z.preprocess((x) => (x === "" ? undefined : x), zod_1.z.coerce.number().int().gte(1).lte(100).default(50));
/** @alias */
exports.publicApiPaginationLimitZod = exports.paginationLimitZod;
exports.paginationZod = {
    page: zod_1.z.preprocess((x) => (x === "" ? undefined : x), zod_1.z.coerce.number().nonnegative().default(1)),
    limit: exports.paginationLimitZod,
};
exports.publicApiPaginationZod = {
    page: zod_1.z.preprocess((x) => (x === "" ? undefined : x), zod_1.z.coerce.number().int().gt(0).default(1)),
    limit: exports.publicApiPaginationLimitZod,
};
const splitCommaSeparatedQueryParam = (value) => value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
exports.optionalCommaSeparatedStringArray = zod_1.z
    .string()
    .nullish()
    .transform((value) => {
    if (!value)
        return undefined;
    const values = splitCommaSeparatedQueryParam(value);
    return values.length > 0 ? values : undefined;
});
const optionalJsonParam = (schema, paramName) => zod_1.z
    .string()
    .optional()
    .transform((str) => {
    if (!str)
        return undefined;
    try {
        return JSON.parse(str);
    }
    catch {
        throw new InvalidRequestError_1.InvalidRequestError(`Invalid JSON in ${paramName} parameter`);
    }
})
    .pipe(schema.optional());
exports.optionalJsonParam = optionalJsonParam;
function commaSeparatedEnumArray(values, defaultValue, options) {
    const arraySchema = zod_1.z.array(zod_1.z.enum(values));
    const schema = defaultValue === null
        ? arraySchema.nullable().default(null)
        : arraySchema.default(defaultValue);
    return zod_1.z.preprocess((value) => {
        if (value === null || value === undefined || value === "")
            return undefined;
        if (typeof value !== "string")
            return value;
        const items = splitCommaSeparatedQueryParam(value);
        if (options?.unknownValues === "filter") {
            return items.filter((item) => values.includes(item));
        }
        return items;
    }, schema);
}
exports.optionalPaginationZod = {
    page: zod_1.z
        .preprocess((x) => (x === "" ? undefined : x), zod_1.z.coerce.number())
        .optional(),
    limit: zod_1.z
        .preprocess((x) => (x === "" ? undefined : x), zod_1.z.coerce.number())
        .optional(),
};
exports.queryStringZod = zod_1.z
    .string()
    .transform((val) => decodeURIComponent(val));
/**
 * Top-level `_deprecation` metadata returned by legacy public API endpoints.
 * Optional fields are omitted when empty (never null).
 */
exports.deprecationResponseZod = zod_1.z.object({
    message: zod_1.z.string(),
    replacement: zod_1.z.string().optional(),
    docsUrl: zod_1.z.string().optional(),
    sunsetAt: zod_1.z.string().optional(),
});
exports.paginationMetaResponseZod = zod_1.z.object({
    /** Set on list responses of legacy public API endpoints. */
    deprecation: exports.deprecationResponseZod
        .pick({ sunsetAt: true, replacement: true })
        .optional(),
    page: zod_1.z.number().int().positive(),
    limit: zod_1.z.number().int().positive(),
    totalItems: zod_1.z.number().int().nonnegative(),
    totalPages: zod_1.z.number().int().nonnegative(),
});
exports.urlRegex = /https?:\/\/[^\s/$.?#].[^\s]*/i;
const noUrlCheck = (value) => !exports.urlRegex.test(value);
exports.noUrlCheck = noUrlCheck;
exports.NonEmptyString = zod_1.z.string().min(1);
exports.htmlRegex = /<[^<>]*>/g;
const containsHtmlRegex = /<[^<>]*>/;
function removeHtmlTags(input) {
    const parts = [];
    let cursor = 0;
    while (cursor < input.length) {
        const tagStart = input.indexOf("<", cursor);
        if (tagStart === -1) {
            parts.push(input.slice(cursor));
            break;
        }
        const tagEnd = input.indexOf(">", tagStart + 1);
        if (tagEnd === -1) {
            parts.push(input.slice(cursor));
            break;
        }
        parts.push(input.slice(cursor, tagStart));
        cursor = tagEnd + 1;
    }
    return parts.join("");
}
exports.StringNoHTML = zod_1.z
    .string()
    .refine((val) => !containsHtmlRegex.test(val), {
    message: "Text cannot contain HTML tags",
});
exports.StringNoHTMLNonEmpty = zod_1.z
    .string()
    .min(1, "Text cannot be empty")
    .refine((val) => !containsHtmlRegex.test(val), {
    message: "Text cannot contain HTML tags",
});
/**
 * Validates an object against a Zod schema and helps with IDE type warnings.
 *
 * @param schema - The Zod schema to validate against.
 * @param object - The object to be validated.
 * @returns The parsed object if validation is successful.
 */
const validateZodSchema = (schema, object) => {
    return schema.parse(object);
};
exports.validateZodSchema = validateZodSchema;
// JSON Schema validation
exports.JSONPrimitiveValueSchema = zod_1.z.union([
    zod_1.z.string(),
    zod_1.z.number(),
    zod_1.z.boolean(),
]);
exports.JSONValueSchema = zod_1.z.lazy(() => zod_1.z.union([
    exports.JSONPrimitiveValueSchema,
    zod_1.z.array(exports.JSONValueSchema),
    zod_1.z.record(zod_1.z.string(), exports.JSONValueSchema),
]));
exports.JSONObjectSchema = zod_1.z.record(zod_1.z.string(), exports.JSONValueSchema);
exports.JSONArraySchema = zod_1.z.array(exports.JSONValueSchema);
/**
 * Sanitizes a string for safe use in email subject lines.
 * Prevents email header injection attacks by removing:
 * - Newline characters (\r, \n) which can be used for CRLF injection
 * - Control characters (ASCII 0-31 and 127) which can cause parsing issues
 * - HTML tags (defensive, though nodemailer should handle this)
 *
 * This is critical for security compliance as it prevents attackers from:
 * - Injecting additional email headers (BCC, CC, From, etc.)
 * - Manipulating email routing
 * - Executing XSS in email clients
 *
 * @param input - The string to sanitize (e.g., user name, project name)
 * @returns Sanitized string safe for email subject lines
 *
 * @example
 * sanitizeEmailSubject("John\r\nBCC: attacker@evil.com") // Returns "JohnBCC: attacker@evil.com"
 * sanitizeEmailSubject("Test<script>alert(1)</script>") // Returns "Testscriptalert(1)/script"
 */
function sanitizeEmailSubject(input) {
    const withoutControlCharacters = input
        // Remove carriage return and line feed (CRLF injection prevention)
        .replace(/[\r\n]/g, "")
        // Remove all control characters (ASCII 0-31 and 127)
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1F\x7F]/g, "");
    return removeHtmlTags(withoutControlCharacters).trim();
}
/**
 * Zod schema for optional ISO 8601 timestamp strings (RFC 3339, Section 5.6) in UTC.
 * Used for dataset versioning to allow querying data at a specific point in time.
 *
 * Behavior:
 * - If provided, must be a valid ISO 8601 string (e.g., "2026-01-21T14:35:42Z")
 * - Coerces to Date object
 * - If undefined, treated as optional (returns latest version)
 *
 * @example
 * // Valid inputs
 * versionZod.parse("2026-01-21T14:35:42Z") // Returns Date object
 * versionZod.parse(undefined) // Returns undefined
 */
exports.versionZod = zod_1.z.coerce.date().optional();
