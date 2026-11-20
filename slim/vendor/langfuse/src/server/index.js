"use strict";
// langfuse-lite shim for @langfuse/shared/src/server's index: only what the OTel
// processor uses. Metrics and tracing are no-ops; storage and queues are absent.
const types = require("./ingestion/types");
const attribution = require("./ingestion/ingestionAttribution");
const tools = require("./ingestion/extractToolsBackend");
const noop = () => {};
const fakeSpan = { setAttribute: noop, setAttributes: noop, recordException: noop, end: noop };
exports.DEFAULT_TRACE_ENVIRONMENT = types.DEFAULT_TRACE_ENVIRONMENT;
exports.UsageDetails = types.UsageDetails;
exports.normalizeEnvironment = types.normalizeEnvironment;
exports.LangfuseInternalTraceEnvironment = require("./llm/types").LangfuseInternalTraceEnvironment;
exports.isStructuredMetadataSdkVersion = attribution.isStructuredMetadataSdkVersion;
exports.normalizeIngestionSdkName = attribution.normalizeIngestionSdkName;
exports.sanitizeSdkMetricTagValue = attribution.sanitizeSdkMetricTagValue;
exports.normalizeToolMetadataForObservation = tools.normalizeToolMetadataForObservation;
exports.normalizeToolsForObservation = tools.normalizeToolsForObservation;
exports.logger = require("./logger").logger;
exports.instrumentSync = (_opts, fn) => fn(fakeSpan);
exports.instrumentAsync = async (_opts, fn) => fn(fakeSpan);
exports.recordIncrement = noop;
exports.recordDistribution = noop;
exports.recordGauge = noop;
exports.traceException = noop;
exports.redis = null;
exports.QueueJobs = { OtelIngestionJob: "otel-ingestion-job" };
exports.getS3EventStorageClient = () => { throw new Error("langfuse-lite: no S3"); };
