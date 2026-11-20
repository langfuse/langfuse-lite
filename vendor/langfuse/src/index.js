"use strict";
// langfuse-lite shim for @langfuse/shared's root index: only what the OTel
// processor uses, re-exported from the vendored files.
const observations = require("./domain/observations");
exports.ObservationLevel = observations.ObservationLevel;
exports.ObservationType = observations.ObservationType;
exports.ObservationTypeDomain = observations.ObservationTypeDomain;
exports.ForbiddenError = require("./errors/ForbiddenError").ForbiddenError;
