"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.eventsTableSingleFilterList = exports.eventsTableFilterState = exports.eventsTableSingleFilter = exports.eventsTableStringObjectFilter = exports.eventsTableStringFilter = exports.singleFilterList = exports.singleFilter = exports.categoryOptionsFilter = exports.positionInTraceFilter = exports.nullFilter = exports.booleanFilter = exports.booleanObjectFilter = exports.numberObjectFilter = exports.coerceLegacyEmptyMetadataFilters = exports.stringObjectFilter = exports.arrayOptionsFilter = exports.stringOptionsFilter = exports.numberFilter = exports.stringFilter = exports.timeFilter = exports.FTS_MATCH_OPERATOR = exports.filterOperators = void 0;
const zod_1 = require("zod");
// Make sure to update the InMemoryFilterService if you add new filter types
exports.filterOperators = {
    datetime: [">", "<", ">=", "<="],
    string: [
        "=",
        "contains",
        "does not contain",
        "starts with",
        "ends with",
        "is not empty",
    ],
    stringOptions: ["any of", "none of"],
    categoryOptions: ["any of", "none of"],
    arrayOptions: ["any of", "none of", "all of"],
    number: ["=", ">", "<", ">=", "<="],
    stringObject: [
        "=",
        "contains",
        "does not contain",
        "starts with",
        "ends with",
        "is set",
        "is not set",
    ],
    numberObject: ["=", ">", "<", ">=", "<="],
    booleanObject: ["=", "<>"],
    boolean: ["=", "<>"],
    null: ["is null", "is not null"],
    positionInTrace: ["="],
};
exports.FTS_MATCH_OPERATOR = "matches";
exports.timeFilter = zod_1.z.object({
    column: zod_1.z.string(),
    operator: zod_1.z.enum(exports.filterOperators.datetime),
    value: zod_1.z.coerce.date(), // coerce required to parse stringified dates from the db in evals
    type: zod_1.z.literal("datetime"),
});
exports.stringFilter = zod_1.z.object({
    column: zod_1.z.string(),
    operator: zod_1.z.enum(exports.filterOperators.string),
    value: zod_1.z.string(),
    type: zod_1.z.literal("string"),
});
exports.numberFilter = zod_1.z.object({
    column: zod_1.z.string(),
    operator: zod_1.z.enum(exports.filterOperators.number),
    value: zod_1.z.number(),
    type: zod_1.z.literal("number"),
});
exports.stringOptionsFilter = zod_1.z.object({
    column: zod_1.z.string(),
    operator: zod_1.z.enum(exports.filterOperators.stringOptions),
    // do not filter on empty arrays, use refine to check this only at runtime (no type checking)
    value: zod_1.z.array(zod_1.z.string()).refine((v) => v.length > 0),
    type: zod_1.z.literal("stringOptions"),
});
exports.arrayOptionsFilter = zod_1.z
    .object({
    column: zod_1.z.string(),
    operator: zod_1.z.enum(exports.filterOperators.arrayOptions),
    value: zod_1.z.array(zod_1.z.string()),
    type: zod_1.z.literal("arrayOptions"),
})
    .refine((data) => data.operator === "all of" ||
    data.operator === "none of" ||
    data.value.length > 0, {
    message: "Value array must not be empty unless operator is 'all of' or 'none of' (which represent waiting for selection)",
});
// A substring operator with an empty value skips the ngram prefilter and
// degrades to a full-scan key-existence check over the whole time window — the
// same semantics the `is set` presence operator now expresses cleanly. Empty
// substrings are the legacy spelling of presence, so callers coerce them to
// `is set` (see `coerceLegacyEmptyMetadataFilters`) rather than reject them.
const LEGACY_EMPTY_SUBSTRING_STRING_OBJECT_OPERATORS = new Set([
    "contains",
    "starts with",
    "ends with",
]);
exports.stringObjectFilter = zod_1.z.object({
    type: zod_1.z.literal("stringObject"),
    column: zod_1.z.string(),
    key: zod_1.z.string(), // eg metadata --> "environment"
    operator: zod_1.z.enum(exports.filterOperators.stringObject),
    value: zod_1.z.string(),
});
// Metadata `contains ""` / `starts with ""` / `ends with ""` was the historical
// way to express key presence before `is set` / `is not set` existed. Rewrite
// that shape to the equivalent `is set` at every parse boundary — fresh API
// input and persisted reads alike — so it never reaches the SQL layer as an
// empty substring and never throws on parse.
const coerceLegacyEmptyMetadataFilters = (filters) => {
    if (!Array.isArray(filters))
        return filters;
    return filters.map((filter) => {
        if (filter &&
            typeof filter === "object" &&
            filter.type === "stringObject" &&
            filter.value === "" &&
            LEGACY_EMPTY_SUBSTRING_STRING_OBJECT_OPERATORS.has(filter.operator)) {
            return { ...filter, operator: "is set" };
        }
        return filter;
    });
};
exports.coerceLegacyEmptyMetadataFilters = coerceLegacyEmptyMetadataFilters;
exports.numberObjectFilter = zod_1.z.object({
    type: zod_1.z.literal("numberObject"),
    column: zod_1.z.string(),
    key: zod_1.z.string(), // eg scores --> "accuracy"
    operator: zod_1.z.enum(exports.filterOperators.number),
    value: zod_1.z.number(),
});
exports.booleanObjectFilter = zod_1.z.object({
    type: zod_1.z.literal("booleanObject"),
    column: zod_1.z.string(),
    key: zod_1.z.string(), // eg scores --> "is_hallucination"
    operator: zod_1.z.enum(exports.filterOperators.booleanObject),
    value: zod_1.z.boolean(),
});
exports.booleanFilter = zod_1.z.object({
    type: zod_1.z.literal("boolean"),
    column: zod_1.z.string(),
    operator: zod_1.z.enum(exports.filterOperators.boolean),
    value: zod_1.z.boolean(),
});
exports.nullFilter = zod_1.z.object({
    type: zod_1.z.literal("null"),
    column: zod_1.z.string(),
    operator: zod_1.z.enum(exports.filterOperators.null),
    // Omitted or null values normalise to "".
    value: zod_1.z.preprocess((value) => value ?? "", zod_1.z.literal("")),
});
exports.positionInTraceFilter = zod_1.z
    .object({
    type: zod_1.z.literal("positionInTrace"),
    column: zod_1.z.string(),
    operator: zod_1.z.literal("="),
    key: zod_1.z.enum(["root", "first", "last", "nthFromEnd", "nthFromStart"]),
    value: zod_1.z.number().optional(),
})
    .superRefine((data, ctx) => {
    const needsValue = data.key === "nthFromEnd" || data.key === "nthFromStart";
    if (needsValue && (!data.value || data.value < 1)) {
        ctx.addIssue({
            code: "custom",
            message: "Position must be >= 1 for nth selection",
            path: ["value"],
        });
    }
});
exports.categoryOptionsFilter = zod_1.z.object({
    type: zod_1.z.literal("categoryOptions"),
    column: zod_1.z.string(),
    key: zod_1.z.string(),
    operator: zod_1.z.enum(exports.filterOperators.categoryOptions),
    value: zod_1.z.array(zod_1.z.string()),
});
exports.singleFilter = zod_1.z
    .discriminatedUnion("type", [
    exports.timeFilter,
    exports.stringFilter,
    exports.numberFilter,
    exports.stringOptionsFilter,
    exports.categoryOptionsFilter,
    exports.arrayOptionsFilter,
    exports.stringObjectFilter,
    exports.numberObjectFilter,
    exports.booleanObjectFilter,
    exports.booleanFilter,
    exports.nullFilter,
    exports.positionInTraceFilter,
])
    .and(zod_1.z.object({
    /** Optional host-owned target reference, persisted with the condition. */
    target: zod_1.z.string().min(1).max(512).optional(),
}));
// Single choke point for parsing arrays of filters. `z.preprocess` runs the
// legacy-empty-substring coercion before validation, so both fresh API/tRPC
// input and persisted reads route through one place instead of remembering to
// wrap each call site. Prefer this over a bare `z.array(singleFilter)`.
// The cast pins the input type to `SingleFilter[]`. Without it `z.preprocess`
// infers `unknown` input (the coercer takes `unknown`), which would surface as
// `unknown` on tRPC mutation variables and form values that consume `z.input`.
// A legacy `contains ""` filter is itself a valid `singleFilter`, so the coerced
// shape is fully within this input type.
exports.singleFilterList = zod_1.z.preprocess(exports.coerceLegacyEmptyMetadataFilters, zod_1.z.array(exports.singleFilter));
const eventsTableStringOperator = zod_1.z.union([
    zod_1.z.enum(exports.filterOperators.string),
    zod_1.z.literal(exports.FTS_MATCH_OPERATOR),
]);
const eventsTableStringObjectOperator = zod_1.z.union([
    zod_1.z.enum(exports.filterOperators.stringObject),
    zod_1.z.literal(exports.FTS_MATCH_OPERATOR),
]);
exports.eventsTableStringFilter = exports.stringFilter.extend({
    operator: eventsTableStringOperator,
});
exports.eventsTableStringObjectFilter = exports.stringObjectFilter.extend({
    operator: eventsTableStringObjectOperator,
});
exports.eventsTableSingleFilter = zod_1.z.discriminatedUnion("type", [
    exports.timeFilter,
    exports.eventsTableStringFilter,
    exports.numberFilter,
    exports.stringOptionsFilter,
    exports.categoryOptionsFilter,
    exports.arrayOptionsFilter,
    exports.eventsTableStringObjectFilter,
    exports.numberObjectFilter,
    exports.booleanObjectFilter,
    exports.booleanFilter,
    exports.nullFilter,
    exports.positionInTraceFilter,
]);
exports.eventsTableFilterState = zod_1.z.array(exports.eventsTableSingleFilter);
// Coercing choke point for the events-table filter variant, mirroring
// `singleFilterList`. Prefer this over a bare `z.array(eventsTableSingleFilter)`
// when parsing external input so legacy empty-substring metadata filters are
// rewritten to `is set` instead of throwing at the SQL layer.
exports.eventsTableSingleFilterList = zod_1.z.preprocess(exports.coerceLegacyEmptyMetadataFilters, exports.eventsTableFilterState);
