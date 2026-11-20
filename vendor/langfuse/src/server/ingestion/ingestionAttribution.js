"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createUnknownSdkIngestionAttribution = exports.createIngestionAttribution = exports.extractPublicApiCallerAttribution = exports.sanitizeSdkMetricTagValue = exports.classifyIngestionSdkAttribution = exports.classifyIngestionSdkVersion = exports.isStructuredMetadataSdkVersion = exports.extractBaseIngestionSdkVersion = exports.normalizeIngestionSdkName = exports.getLangfuseHeaderValue = exports.PUBLIC_API_USER_AGENT_MAX_LENGTH = exports.PUBLIC_API_SDK_VERSION_MAX_LENGTH = exports.LANGFUSE_SDK_LATEST_MAJOR = exports.INTERNAL_INGESTION_SDK_NAMES = exports.UNKNOWN_INGESTION_SDK_VALUE = void 0;
const compareVersions_1 = require("../utils/compareVersions");
exports.UNKNOWN_INGESTION_SDK_VALUE = "unknown";
exports.INTERNAL_INGESTION_SDK_NAMES = [
    "langfuse-internal-ai-sdk",
    "langfuse-internal-otel-writer",
    "langfuse-internal-ai-features",
];
exports.LANGFUSE_SDK_LATEST_MAJOR = {
    python: 5,
    javascript: 6,
};
// First SDK majors that JSON-encode every per-key metadata value. Ingestion
// decodes those values so they are stored exactly like a metadata blob.
const LANGFUSE_SDK_STRUCTURED_METADATA_MIN_MAJOR = {
    python: 5,
    javascript: 6,
};
exports.PUBLIC_API_SDK_VERSION_MAX_LENGTH = 64;
exports.PUBLIC_API_USER_AGENT_MAX_LENGTH = 256;
const getHeaderValue = (headers, name) => {
    if (!headers)
        return "";
    const directValue = headers[name];
    if (typeof directValue === "string")
        return directValue;
    const underscoreValue = headers[name.replaceAll("-", "_")];
    if (typeof underscoreValue === "string")
        return underscoreValue;
    const normalizedName = name.toLowerCase().replaceAll("_", "-");
    const matchedValue = Object.entries(headers).find(([headerName, value]) => typeof value === "string" &&
        headerName.toLowerCase().replaceAll("_", "-") === normalizedName)?.[1];
    if (typeof matchedValue === "string")
        return matchedValue;
    return "";
};
const normalizeSdkValue = (value) => value || exports.UNKNOWN_INGESTION_SDK_VALUE;
exports.getLangfuseHeaderValue = getHeaderValue;
const normalizeIngestionSdkName = (sdkName) => {
    const normalized = sdkName?.trim().toLowerCase();
    if (!normalized || normalized === exports.UNKNOWN_INGESTION_SDK_VALUE) {
        return null;
    }
    if (normalized === "python" || normalized === "langfuse-python") {
        return "python";
    }
    if ([
        "javascript",
        "js",
        "typescript",
        "ts",
        "langfuse-js",
        "langfuse-ts",
        "@langfuse/client",
        "@langfuse/browser",
        "@langfuse/core",
        "@langfuse/langchain",
        "@langfuse/otel",
        "@langfuse/openai",
        "@langfuse/tracing",
        "@langfuse/vercel-ai-sdk",
    ].includes(normalized)) {
        return "javascript";
    }
    return null;
};
exports.normalizeIngestionSdkName = normalizeIngestionSdkName;
const extractBaseIngestionSdkVersion = (sdkVersion) => {
    const version = sdkVersion.trim();
    if (/^v?\d+\.\d+\.\d+(?:[-+].+)?$/i.test(version)) {
        return version.split(/[-+]/)[0] ?? version;
    }
    const pep440Match = version.match(/^(v?\d+\.\d+\.\d+)(?:a|b|rc)\d+$/i);
    if (pep440Match?.[1]) {
        return pep440Match[1];
    }
    return version;
};
exports.extractBaseIngestionSdkVersion = extractBaseIngestionSdkVersion;
const isStructuredMetadataSdkVersion = (params) => {
    if (!params.sdkName || !params.sdkVersion)
        return false;
    const parsedVersion = (0, compareVersions_1.parseVersionString)((0, exports.extractBaseIngestionSdkVersion)(params.sdkVersion));
    return (parsedVersion !== null &&
        parsedVersion.major >=
            LANGFUSE_SDK_STRUCTURED_METADATA_MIN_MAJOR[params.sdkName]);
};
exports.isStructuredMetadataSdkVersion = isStructuredMetadataSdkVersion;
const classifyIngestionSdkVersion = (params) => {
    const sdkName = params.sdkName?.trim();
    const sdkVersion = params.sdkVersion?.trim();
    if (!sdkName ||
        !sdkVersion ||
        sdkName === exports.UNKNOWN_INGESTION_SDK_VALUE ||
        sdkVersion === exports.UNKNOWN_INGESTION_SDK_VALUE) {
        return {
            canonicalSdkName: null,
            latestMajor: null,
            major: null,
            status: "unknown",
        };
    }
    const canonicalSdkName = (0, exports.normalizeIngestionSdkName)(sdkName);
    if (!canonicalSdkName) {
        return {
            canonicalSdkName: null,
            latestMajor: null,
            major: null,
            status: "unsupported_sdk",
        };
    }
    const parsedVersion = (0, compareVersions_1.parseVersionString)((0, exports.extractBaseIngestionSdkVersion)(sdkVersion));
    const latestMajor = exports.LANGFUSE_SDK_LATEST_MAJOR[canonicalSdkName];
    if (!parsedVersion) {
        return {
            canonicalSdkName,
            latestMajor,
            major: null,
            status: "invalid_version",
        };
    }
    return {
        canonicalSdkName,
        latestMajor,
        major: parsedVersion.major,
        status: parsedVersion.major >= latestMajor ? "current" : "outdated_major",
    };
};
exports.classifyIngestionSdkVersion = classifyIngestionSdkVersion;
const classifyIngestionSdkAttribution = (params) => {
    const sdkName = params.sdkName?.trim();
    const sdkVersion = params.sdkVersion?.trim();
    const missingName = !sdkName || sdkName === exports.UNKNOWN_INGESTION_SDK_VALUE;
    const missingVersion = !sdkVersion || sdkVersion === exports.UNKNOWN_INGESTION_SDK_VALUE;
    if (missingName && missingVersion)
        return "missing_name_and_version";
    if (missingName)
        return "missing_name";
    if (missingVersion)
        return "missing_version";
    return "attributed";
};
exports.classifyIngestionSdkAttribution = classifyIngestionSdkAttribution;
const METRIC_TAG_MAX_LENGTH = 32;
/**
 * Bounds a caller-supplied SDK value for safe use as a StatsD/Datadog metric
 * tag. Ingestion SDK name/version come straight from request headers, so
 * without this a caller could inject oversized or separator-bearing
 * (`,` `|` `:` `=`) tag values and inflate metric cardinality. Strips control
 * characters and tag separators, caps length, and falls back to "unknown".
 */
const sanitizeSdkMetricTagValue = (value) => {
    if (!value) {
        return exports.UNKNOWN_INGESTION_SDK_VALUE;
    }
    const sanitized = Array.from(value)
        .filter((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        if (codePoint <= 31 || codePoint === 127) {
            return false;
        }
        return (character !== "," &&
            character !== "|" &&
            character !== ":" &&
            character !== "=");
    })
        .join("")
        .trim();
    const bounded = Array.from(sanitized)
        .slice(0, METRIC_TAG_MAX_LENGTH)
        .join("");
    return bounded || exports.UNKNOWN_INGESTION_SDK_VALUE;
};
exports.sanitizeSdkMetricTagValue = sanitizeSdkMetricTagValue;
const sanitizeCallerAttributionValue = (value, maxLength) => {
    const sanitized = Array.from(value)
        .filter((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint > 31 && codePoint !== 127;
    })
        .join("")
        .trim();
    const bounded = Array.from(sanitized).slice(0, maxLength).join("");
    return bounded || undefined;
};
/**
 * Extracts the bounded, allowlisted caller metadata shared by public API
 * telemetry and ClickHouse query attribution. SDK parsing intentionally
 * reuses the ingestion pipeline's header and version normalization.
 */
const extractPublicApiCallerAttribution = (headers) => {
    const sdkName = (0, exports.normalizeIngestionSdkName)(getHeaderValue(headers, "x-langfuse-sdk-name"));
    const rawSdkVersion = sanitizeCallerAttributionValue(getHeaderValue(headers, "x-langfuse-sdk-version"), exports.PUBLIC_API_SDK_VERSION_MAX_LENGTH);
    const sdkVersionClassification = (0, exports.classifyIngestionSdkVersion)({
        sdkName,
        sdkVersion: rawSdkVersion,
    });
    const sdkVersion = sdkVersionClassification.status === "current" ||
        sdkVersionClassification.status === "outdated_major"
        ? rawSdkVersion
        : undefined;
    const userAgent = sanitizeCallerAttributionValue(getHeaderValue(headers, "user-agent"), exports.PUBLIC_API_USER_AGENT_MAX_LENGTH);
    return {
        ...(sdkName ? { sdkName } : {}),
        ...(sdkVersion ? { sdkVersion } : {}),
        ...(userAgent ? { userAgent } : {}),
    };
};
exports.extractPublicApiCallerAttribution = extractPublicApiCallerAttribution;
const createIngestionAttribution = (params) => {
    const { headers, authCheck } = params;
    return {
        ingestionApiKey: authCheck.scope.publicKey,
        ingestionSdkName: normalizeSdkValue(getHeaderValue(headers, "x-langfuse-sdk-name")),
        ingestionSdkVersion: normalizeSdkValue(getHeaderValue(headers, "x-langfuse-sdk-version")),
    };
};
exports.createIngestionAttribution = createIngestionAttribution;
const createUnknownSdkIngestionAttribution = (params) => ({
    ingestionApiKey: params.authCheck.scope.publicKey ?? "",
    ingestionSdkName: exports.UNKNOWN_INGESTION_SDK_VALUE,
    ingestionSdkVersion: exports.UNKNOWN_INGESTION_SDK_VALUE,
});
exports.createUnknownSdkIngestionAttribution = createUnknownSdkIngestionAttribution;
