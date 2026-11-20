"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.removeObjectKeys = removeObjectKeys;
exports.defineOwnValue = defineOwnValue;
exports.asRecord = asRecord;
exports.asString = asString;
exports.asBoolean = asBoolean;
exports.asStringArray = asStringArray;
exports.asNumberRecord = asNumberRecord;
/**
 * Removes specified keys from an object and returns a new object without those keys.
 */
function removeObjectKeys(obj, keys) {
    const result = { ...obj };
    for (const key of keys) {
        delete result[key];
    }
    return result;
}
/** Define an own data property without invoking setters, including `__proto__`. */
function defineOwnValue(target, property, value) {
    Object.defineProperty(target, property, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
    });
}
/**
 * Safely coerces a value to a Record if it's a non-array object.
 * Returns undefined for null, undefined, arrays, and non-objects.
 */
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
/**
 * Safely coerces a value to a string if it's a non-empty string.
 * Returns undefined for empty strings and non-strings.
 */
function asString(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
/**
 * Safely coerces a value to a boolean if it's a boolean.
 * Returns undefined for non-booleans.
 */
function asBoolean(value) {
    return typeof value === "boolean" ? value : undefined;
}
/**
 * Safely coerces a value to a string array if it's an array of strings.
 * Returns undefined for non-arrays or arrays with non-string elements.
 */
function asStringArray(value) {
    return Array.isArray(value) &&
        value.every((entry) => typeof entry === "string")
        ? value
        : undefined;
}
/**
 * Safely coerces a value to a Record<string, number> if it's an object with numeric values.
 * Filters out non-finite numbers. Returns undefined if result is empty or input is not an object.
 */
function asNumberRecord(value) {
    const record = asRecord(value);
    if (!record) {
        return undefined;
    }
    const normalized = Object.fromEntries(Object.entries(record).filter(([, entry]) => typeof entry === "number" && Number.isFinite(entry)));
    return Object.keys(normalized).length > 0 ? normalized : undefined;
}
