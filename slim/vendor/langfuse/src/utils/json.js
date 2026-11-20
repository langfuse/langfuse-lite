"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseJsonIfString = exports.parseJsonPrioritised = exports.isJsonNumberLiteral = void 0;
exports.deepParseJson = deepParseJson;
exports.deepParseJsonIterative = deepParseJsonIterative;
exports.safeJsonParse = safeJsonParse;
exports.stableJsonStringify = stableJsonStringify;
const lossless_json_1 = require("lossless-json");
// Dangerous keys that could lead to prototype pollution
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
// attempts to parse Python dict/list string to JSON object
// LangChain/LangGraph v1 tool calls are logged as python dicts for example
function tryParsePythonDict(str) {
    // performance: early terminate unless has single quotes AND dict/list structure chars
    if (!str.includes("'") || !(str.includes("{") || str.includes("["))) {
        return str;
    }
    if (str.length > 1_000_000) {
        return str;
    }
    const trimmed = str.trim();
    if (trimmed[0] !== "{" && trimmed[0] !== "[") {
        return str;
    }
    try {
        // Convert Python syntax to JSON:
        // 1. Replace Python boolean/null literals (with word boundaries)
        // 2. Replace single quotes with double quotes
        const jsonStr = trimmed
            .replace(/\bTrue\b/g, "true")
            .replace(/\bFalse\b/g, "false")
            .replace(/\bNone\b/g, "null")
            // NOTE: this converts all ' indiscriminately and might break some JSONs with escaped '
            // not that bad, because we only call this function, after JSON.parse has already failed
            // therefore, the failure case is the default already.
            .replace(/'/g, '"');
        // parsePreservingPrecision (not JSON.parse) so big integers in Python-dict
        // payloads (e.g. LangChain/LangGraph run IDs) keep their precision too.
        return parsePreservingPrecision(jsonStr);
    }
    catch {
        return str;
    }
}
/** Bound object traversal without serializing oversized, opaque string fields. */
function exceedsParseSize(json, maxSize) {
    const stack = [];
    const ancestors = new Set();
    let value = json;
    let size = 0;
    while (true) {
        if (typeof value === "string") {
            // Count an opaque leaf as null, without scanning or copying its contents.
            size += value.length > maxSize ? 4 : value.length + 2;
        }
        else if (typeof value === "object" && value !== null) {
            if (ancestors.has(value))
                return true;
            const keys = Array.isArray(value) ? null : Object.keys(value);
            const length = Array.isArray(value) ? value.length : keys.length;
            size += 2 + Math.max(0, length - 1); // Brackets/braces and commas.
            // Every child costs at least one character. Reject wide containers before
            // reading their children or allocating parser entries for them.
            if (size + length > maxSize)
                return true;
            ancestors.add(value);
            stack.push({ value, keys, length, index: 0 });
        }
        else {
            size += String(value).length;
        }
        if (size > maxSize)
            return true;
        while (stack.length > 0) {
            const frame = stack[stack.length - 1];
            if (frame.index < frame.length)
                break;
            ancestors.delete(frame.value);
            stack.pop();
        }
        if (stack.length === 0)
            return false;
        const frame = stack[stack.length - 1];
        const index = frame.index++;
        if (frame.keys) {
            const key = frame.keys[index];
            size += key.length + 3; // Key quotes and colon.
            if (size > maxSize)
                return true;
            value = frame.value[key];
        }
        else {
            value = frame.value[index];
        }
    }
}
/**
 * Deeply parses a JSON string or object for nested stringified JSON
 * Performance optimized with size and depth limits to prevent UI freezing
 *
 * @param json JSON string or object to parse
 * @param options Options to control parsing behavior
 * @returns Parsed JSON object
 */
function deepParseJson(json, options = {}) {
    const { maxSize = 500_000, maxDepth = 3 } = options;
    // Root strings are also used for document decoding on the server. Only
    // object inputs use the traversal limit and opaque-string handling.
    let maxStringSize = Infinity;
    if (typeof json === "object" && json !== null) {
        if (exceedsParseSize(json, maxSize))
            return json;
        maxStringSize = maxSize;
    }
    // Perform depth-limited parsing
    const result = deepParseJsonRecursive(json, 0, maxDepth, maxStringSize);
    return result;
}
/**
 * Internal recursive implementation with depth tracking
 */
function deepParseJsonRecursive(json, currentDepth, maxDepth, maxStringSize) {
    // Stop recursing if we've hit max depth
    if (currentDepth >= maxDepth) {
        return json;
    }
    if (typeof json === "string") {
        if (json.length > maxStringSize)
            return json;
        // A bare JSON number literal stays a string: this preserves user-provided
        // numeric strings and, critically, big integers that would lose precision
        // if coerced to a JS number (issue #6628).
        if ((0, exports.isJsonNumberLiteral)(json))
            return json;
        try {
            const parsed = parsePreservingPrecision(json);
            return deepParseJsonRecursive(parsed, currentDepth + 1, maxDepth, maxStringSize);
        }
        catch {
            const pythonParsed = tryParsePythonDict(json);
            if (pythonParsed !== json) {
                return deepParseJsonRecursive(pythonParsed, currentDepth + 1, maxDepth, maxStringSize);
            }
            return json; // If it's not a valid JSON string, just return the original string
        }
    }
    else if (typeof json === "object" && json !== null) {
        // Handle arrays
        if (Array.isArray(json)) {
            for (let i = 0; i < json.length; i++) {
                json[i] = deepParseJsonRecursive(json[i], currentDepth + 1, maxDepth, maxStringSize);
            }
        }
        else {
            // Handle nested objects
            for (const key in json) {
                // Ensure we only iterate over the object's own properties
                if (Object.prototype.hasOwnProperty.call(json, key)) {
                    // Filter out dangerous keys to prevent prototype pollution
                    if (DANGEROUS_KEYS.has(key)) {
                        delete json[key];
                    }
                    else {
                        json[key] = deepParseJsonRecursive(json[key], currentDepth + 1, maxDepth, maxStringSize);
                    }
                }
            }
        }
        return json;
    }
    return json;
}
/**
 * High-performance iterative implementation of deepParseJson
 * Uses immutable stack entries to avoid mutation bugs while maintaining speed
 *
 * Key optimizations:
 * - No cloning of input (immutable approach)
 * - Bottom-up reconstruction only where needed
 * - Minimal object allocations
 * - Direct semantic equivalence to recursive version
 *
 * @param json JSON string or object to parse
 * @param options Options to control parsing behavior
 * @returns Parsed JSON object
 */
function deepParseJsonIterative(json, options = {}) {
    const { maxSize = 500_000, maxDepth = 3 } = options;
    let maxStringSize = Infinity;
    if (typeof json === "object" && json !== null) {
        if (exceedsParseSize(json, maxSize))
            return json;
        maxStringSize = maxSize;
    }
    // Root entry
    const rootEntry = {
        input: json,
        parent: null,
        key: null,
        depth: 0,
        childrenToProcess: 0,
    };
    const stack = [rootEntry];
    const processed = new Set(); // Track which entries we've processed
    while (stack.length > 0) {
        const entry = stack[stack.length - 1]; // Peek, don't pop yet
        // If we've already processed this entry's children, finalize it
        if (processed.has(entry)) {
            stack.pop();
            continue;
        }
        const { input, depth } = entry;
        // Stop processing if we've hit max depth
        if (depth >= maxDepth) {
            entry.output = input;
            processed.add(entry);
            continue;
        }
        // Process strings - try to parse as JSON
        if (typeof input === "string") {
            if (input.length > maxStringSize) {
                entry.output = input;
                processed.add(entry);
                continue;
            }
            // A bare JSON number literal stays a string (see deepParseJsonRecursive):
            // preserves numeric strings and big integers that would otherwise lose
            // precision when coerced to a JS number (issue #6628).
            if ((0, exports.isJsonNumberLiteral)(input)) {
                entry.output = input;
                processed.add(entry);
                continue;
            }
            let parsed;
            let wasParsed = false;
            try {
                parsed = parsePreservingPrecision(input);
                wasParsed = true;
            }
            catch {
                // Try Python dict parsing
                const pythonParsed = tryParsePythonDict(input);
                if (pythonParsed !== input) {
                    parsed = pythonParsed;
                    wasParsed = true;
                }
            }
            if (wasParsed && parsed !== undefined) {
                // The parsed value is conceptually at depth + 1
                // Check if that would exceed the limit
                if (depth + 1 > maxDepth) {
                    // Parsed value would be too deep, keep as string
                    entry.output = input;
                    processed.add(entry);
                    continue;
                }
                // Check if we've already created the parsed entry
                if (!entry.parsedEntry) {
                    // Create a new entry for the parsed value at depth + 1
                    // This matches the recursive version's behavior: parse string, recurse at depth + 1
                    const parsedEntry = {
                        input: parsed,
                        parent: entry,
                        key: null, // Not a child of a collection
                        depth: depth + 1,
                        childrenToProcess: 0,
                    };
                    entry.parsedEntry = parsedEntry;
                    stack.push(parsedEntry);
                    continue;
                }
                else {
                    // Parsed entry has been processed, use its output
                    const parsedEntry = entry.parsedEntry;
                    if (processed.has(parsedEntry)) {
                        entry.output = parsedEntry.output;
                        processed.add(entry);
                        continue;
                    }
                    else {
                        // Not ready yet
                        continue;
                    }
                }
            }
            else {
                // Not valid JSON (and the Python-dict fallback also failed), keep as-is.
                // Bare numeric literals never reach here — isJsonNumberLiteral above
                // already short-circuits them to preserve big-int precision (#6628).
                entry.output = input;
                processed.add(entry);
                continue;
            }
        }
        // Handle objects and arrays
        if (typeof input === "object" && input !== null) {
            const isArray = Array.isArray(input);
            const keys = isArray ? null : Object.keys(input);
            const length = isArray ? input.length : keys.length;
            // If no children, use input as-is
            if (length === 0) {
                entry.output = input;
                processed.add(entry);
                continue;
            }
            // Use a property to store children results
            if (!entry.childrenResults) {
                entry.childrenResults = [];
            }
            const childrenResults = entry
                .childrenResults;
            // If we haven't added children yet, add them now
            if (childrenResults.length === 0) {
                // Add children to stack in reverse order (so they process in correct order)
                if (isArray) {
                    const arr = input;
                    for (let i = arr.length - 1; i >= 0; i--) {
                        const childEntry = {
                            input: arr[i],
                            parent: entry,
                            key: i,
                            depth: depth + 1,
                            childrenToProcess: 0,
                        };
                        childrenResults.push(childEntry);
                        stack.push(childEntry);
                    }
                }
                else {
                    const obj = input;
                    for (let i = keys.length - 1; i >= 0; i--) {
                        const key = keys[i];
                        if (Object.prototype.hasOwnProperty.call(obj, key)) {
                            const childEntry = {
                                input: obj[key],
                                parent: entry,
                                key: key,
                                depth: depth + 1,
                                childrenToProcess: 0,
                            };
                            childrenResults.push(childEntry);
                            stack.push(childEntry);
                        }
                    }
                }
                // Reverse to maintain order
                childrenResults.reverse();
                continue;
            }
            // Check if all children are processed
            const allChildrenProcessed = childrenResults.every((child) => processed.has(child));
            if (!allChildrenProcessed) {
                // Not ready yet, will come back
                continue;
            }
            // All children processed, reconstruct this level
            // Check if any children changed
            const anyChildChanged = childrenResults.some((child) => child.output !== child.input);
            // Check if input object has dangerous keys that need filtering
            const hasDangerousKeys = !isArray &&
                Object.keys(input).some((key) => DANGEROUS_KEYS.has(key));
            if (!anyChildChanged && !hasDangerousKeys) {
                // No children changed and no dangerous keys, reuse input
                entry.output = input;
            }
            else {
                // Reconstruct with new children
                if (isArray) {
                    entry.output = childrenResults.map((child) => child.output);
                }
                else {
                    const newObj = {};
                    for (const child of childrenResults) {
                        const key = child.key;
                        // Filter out dangerous keys to prevent prototype pollution
                        if (!DANGEROUS_KEYS.has(key)) {
                            newObj[key] = child.output;
                        }
                    }
                    entry.output = newObj;
                }
            }
            processed.add(entry);
            continue;
        }
        // Primitive value (number, boolean, null)
        entry.output = input;
        processed.add(entry);
    }
    return rootEntry.output;
}
/**
 * Pattern to detect JSON numbers that might lose precision with native JSON.parse.
 *
 * Catches:
 * 1. [\d.]{13,} - 13+ characters of digits/dots (conservative threshold for ~12+ significant digits)
 * 2. \d[eE] - scientific notation (always take the precision-preserving path for safety)
 */
const UNSAFE_NUMBER_PATTERN = /[\d.]{13,}|\d[eE]/;
const JSON_NUMBER_LITERAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const isJsonNumberLiteral = (value) => JSON_NUMBER_LITERAL_PATTERN.test(value.trim());
exports.isJsonNumberLiteral = isJsonNumberLiteral;
/**
 * Keeps numbers that cannot round-trip through a JS double as their exact
 * source token (a string) instead of the rounded double. `context.source` is
 * only provided for primitive values, so objects/arrays pass through.
 */
const preserveUnsafeNumbers = (_key, value, context) => typeof value === "number" &&
    context?.source !== undefined &&
    !(0, lossless_json_1.isSafeNumber)(context.source)
    ? context.source
    : value;
/**
 * Parses a JSON string like JSON.parse, but preserves integers beyond
 * Number.MAX_SAFE_INTEGER (2^53-1) by emitting them as strings instead of
 * rounding them to a JS double (issue #6628). Throws on invalid JSON, exactly
 * like JSON.parse, so callers can fall back to other parsing strategies.
 */
const parsePreservingPrecision = (json) => {
    // Fast path: native JSON.parse when no number could lose precision.
    if (!UNSAFE_NUMBER_PATTERN.test(json)) {
        return JSON.parse(json);
    }
    // Precision path: native JSON.parse with a source-access reviver. Safe
    // numbers stay real numbers, unsafe ones keep their exact source token as
    // a string. Native parsing here replaced lossless-json's pure-JS parser,
    // which dominated heap allocation on large payloads (any 13+ digit run or
    // digit-followed-by-e — e.g. ms timestamps or base64 — lands on this path).
    // On runtimes without source access (Safari < 18.4, Firefox < 135) the
    // reviver receives no context and unsafe numbers round like plain
    // JSON.parse; the server (Node >= 21) always preserves them.
    return JSON.parse(json, preserveUnsafeNumbers);
};
const parseJsonPrioritised = (json) => {
    try {
        return parsePreservingPrecision(json);
    }
    catch {
        return json;
    }
};
exports.parseJsonPrioritised = parseJsonPrioritised;
/**
 * Parses a value that may be a JSON string. Non-strings and unparsable
 * strings pass through unchanged; parsing preserves big-integer precision
 * (parseJsonPrioritised).
 */
const parseJsonIfString = (value) => typeof value === "string" ? (0, exports.parseJsonPrioritised)(value) : value;
exports.parseJsonIfString = parseJsonIfString;
function safeJsonParse(value) {
    try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    }
}
function stableJsonStringify(value) {
    return JSON.stringify(sortJsonValue(value)) ?? "undefined";
}
function sortJsonValue(value) {
    if (Array.isArray(value)) {
        return value.map(sortJsonValue);
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nestedValue]) => [key, sortJsonValue(nestedValue)]));
    }
    return value;
}
