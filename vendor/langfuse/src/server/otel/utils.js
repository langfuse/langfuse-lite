"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidDateString = isValidDateString;
exports.getOtelIdRejectionReason = getOtelIdRejectionReason;
exports.validateOtelSpanIds = validateOtelSpanIds;
exports.flattenJsonToPathArrays = flattenJsonToPathArrays;
function isValidDateString(dateString) {
    return !isNaN(new Date(dateString).getTime());
}
/**
 * Whether an OTLP trace/span id can be converted by
 * OtelIngestionProcessor.parseId, which returns strings unchanged and otherwise
 * calls `Buffer.from()`. Returns null when it can.
 */
function getOtelIdRejectionReason(value) {
    if (value === null || value === undefined)
        return "absent";
    // parseId short-circuits on strings, so any string is convertible.
    if (typeof value === "string")
        return null;
    // Uint8Array/Buffer from a protobuf decode, int arrays from the Python SDK.
    if (value instanceof Uint8Array || Array.isArray(value))
        return null;
    // A Buffer that has been through JSON. Matched explicitly rather than by
    // probing Buffer.from, which must never see attacker-controlled input on the
    // request path: it also accepts any object carrying a numeric `length` and
    // eagerly zero-fills that many bytes, so `{ length: 8e8 }` in a 94-byte body
    // would block the shared web event loop for seconds. Pathological array-likes
    // are therefore rejected here even though Buffer.from would accept them.
    if (typeof value === "object" &&
        value.type === "Buffer" &&
        Array.isArray(value.data)) {
        return null;
    }
    // Numbers, booleans and every other object shape throw in Buffer.from —
    // including the untagged `{ data: [...] }` envelope, which the worker's
    // processToEvent path (OtelIngestionProcessor.ts:322) hands to parseId
    // without the `?.data` unwrap the other call sites apply.
    return "not_an_id";
}
/**
 * Whether an OTLP field that must hold a list — `attributes`, `events`,
 * `scopeSpans`, `spans` — is present but not an array. Absent and empty are
 * legitimate and stay valid; only a present, non-array value is a defect.
 */
function isMalformedList(value) {
    return value !== null && value !== undefined && !Array.isArray(value);
}
/**
 * Walk a decoded OTLP trace export and report everything that makes it
 * unprocessable downstream: spans whose traceId, spanId or (when present)
 * parentSpanId cannot be converted, and `scopeSpans`, `spans`, `attributes` or
 * `events` fields that are present but not arrays.
 *
 * An unconvertible id throws ERR_INVALID_ARG_TYPE in parseId, failing the queue
 * job through every retry attempt. The dominant real-world source is an OTLP
 * *logs* export sent to the traces endpoint — ResourceLogs and ResourceSpans
 * share protobuf field numbers, so log records decode into spans that carry a
 * valid instrumentation scope but no ids at all.
 *
 * Non-array collections cannot be converted either. The worker iterates
 * `scopeSpans`/`spans` behind a `?? []` fallback, which does not guard a
 * non-nullish non-array, so `for...of` throws; it reduces over `attributes`
 * (resource, scope, span and span-event level) and filters over `events`, which
 * throw on anything without those methods. The observed source is a hand-rolled
 * OTLP/JSON exporter emitting attributes as a `{key: value}` object instead of a
 * KeyValue list — only reachable over `application/json`, since a protobuf
 * decode always materializes repeated fields as arrays.
 *
 * Reporting all of it here lets the endpoint reject the payload with a 400
 * instead of accepting it and losing the whole file six attempts later. Absent
 * and empty collections stay valid — only a present, non-array value is a
 * defect.
 */
function validateOtelSpanIds(resourceSpans, { maxSamples = 5 } = {}) {
    let totalSpanCount = 0;
    let invalidSpanCount = 0;
    let malformedCollectionCount = 0;
    const reasonCounts = {};
    const scopeNames = new Set();
    const countReason = (reason) => {
        reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    };
    if (!Array.isArray(resourceSpans)) {
        return {
            totalSpanCount,
            invalidSpanCount,
            malformedCollectionCount,
            reasonCounts,
            reasons: [],
            scopeNames: [],
        };
    }
    const sampleScopeName = (scopeName) => {
        if (scopeName && scopeNames.size < maxSamples) {
            scopeNames.add(String(scopeName));
        }
    };
    for (const resourceSpan of resourceSpans) {
        // extractResourceAttributes reduces this before any span is reached, so a
        // map-shaped one fails the export even for a resource carrying no spans.
        if (isMalformedList(resourceSpan?.resource?.attributes)) {
            malformedCollectionCount++;
            countReason("resource.attributes:not_an_array");
        }
        // Never hand a non-array to for...of: a `?? []` fallback does not guard a
        // non-nullish non-iterable (`{}`, a number), and this runs on the request
        // path, so throwing here would surface as a 500 rather than a rejection.
        const scopeSpans = resourceSpan?.scopeSpans;
        if (!Array.isArray(scopeSpans)) {
            if (scopeSpans !== null && scopeSpans !== undefined) {
                malformedCollectionCount++;
                countReason("scopeSpans:not_an_array");
            }
            continue;
        }
        for (const scopeSpan of scopeSpans) {
            // Same as the resource: extractScopeAttributes runs per scopeSpan,
            // independently of how many spans it holds.
            if (isMalformedList(scopeSpan?.scope?.attributes)) {
                malformedCollectionCount++;
                countReason("scope.attributes:not_an_array");
                sampleScopeName(scopeSpan?.scope?.name);
            }
            const spans = scopeSpan?.spans;
            if (!Array.isArray(spans)) {
                if (spans !== null && spans !== undefined) {
                    malformedCollectionCount++;
                    countReason("spans:not_an_array");
                    sampleScopeName(scopeSpan?.scope?.name);
                }
                continue;
            }
            for (const span of spans) {
                totalSpanCount++;
                const spanReasons = [];
                for (const kind of ["traceId", "spanId"]) {
                    const reason = getOtelIdRejectionReason(span?.[kind]);
                    if (reason)
                        spanReasons.push(`${kind}:${reason}`);
                }
                // parentSpanId is optional and the worker only converts it when truthy
                // (OtelIngestionProcessor.ts:325), so an absent one is legitimate and
                // only a present-but-unconvertible value crashes there.
                if (span?.parentSpanId) {
                    const reason = getOtelIdRejectionReason(span.parentSpanId);
                    if (reason)
                        spanReasons.push(`parentSpanId:${reason}`);
                }
                // Attributed to the span rather than counted as a malformed collection,
                // so that a span carrying one stays outside the endpoint's
                // discardedValidSpans invariant — it is genuinely unprocessable, not a
                // valid span caught by a batch rejection.
                if (isMalformedList(span?.attributes)) {
                    spanReasons.push("attributes:not_an_array");
                }
                if (isMalformedList(span?.events)) {
                    spanReasons.push("events:not_an_array");
                }
                else if (Array.isArray(span?.events)) {
                    // One bad event is enough to fail the span, and the reason is the same
                    // for every further one, so stop at the first.
                    if (span.events.some((event) => isMalformedList(event?.attributes)))
                        spanReasons.push("event.attributes:not_an_array");
                }
                if (spanReasons.length === 0)
                    continue;
                invalidSpanCount++;
                spanReasons.forEach(countReason);
                sampleScopeName(scopeSpan?.scope?.name);
            }
        }
    }
    return {
        totalSpanCount,
        invalidSpanCount,
        malformedCollectionCount,
        reasonCounts,
        reasons: Object.keys(reasonCounts),
        scopeNames: [...scopeNames],
    };
}
/**
 * Flattens a nested JSON object into path-based names and string values.
 * For example: {foo: {bar: "baz", num: 42}} becomes:
 * - names: ["foo.bar", "foo.num"]
 * - values: ["baz", "42"]
 *
 * All values are converted to strings for consistent storage.
 *
 * Each path is emitted once. A literal dotted key and a nested object can
 * produce the same path ({"a.b": 1, a: {b: 2}}); the first value wins, which
 * is the value metadata reads return for a duplicated path.
 */
function flattenJsonToPathArrays(obj, prefix = "") {
    const flattened = new Map();
    collectJsonPaths(obj, prefix, flattened);
    return {
        names: [...flattened.keys()],
        values: [...flattened.values()],
    };
}
function collectJsonPaths(obj, prefix, flattened) {
    for (const [key, value] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value !== null &&
            value !== undefined &&
            typeof value === "object" &&
            !Array.isArray(value)) {
            collectJsonPaths(value, path, flattened);
        }
        else if (flattened.has(path)) {
            continue;
        }
        else if (value === null ||
            value === undefined ||
            typeof value === "string") {
            flattened.set(path, value);
        }
        else {
            flattened.set(path, JSON.stringify(value));
        }
    }
}
