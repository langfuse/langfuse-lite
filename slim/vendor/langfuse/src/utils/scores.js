"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyScoreValidation = void 0;
const applyScoreValidation = (schema) => {
    return schema.refine((data) => {
        const hasTraceId = !!data.traceId;
        const hasSessionId = !!data.sessionId;
        const hasDatasetRunId = !!data.datasetRunId;
        return ((hasTraceId && !hasSessionId && !hasDatasetRunId) ||
            (hasSessionId &&
                !hasTraceId &&
                !hasDatasetRunId &&
                !data.observationId) ||
            (hasDatasetRunId && !hasTraceId && !hasSessionId && !data.observationId));
    }, {
        message: "Provide exactly one of the following: traceId (with optional observationId), sessionId or datasetRunId. ObservationId requires traceId.",
        path: ["traceId", "sessionId", "datasetRunId", "observationId"],
    });
};
exports.applyScoreValidation = applyScoreValidation;
