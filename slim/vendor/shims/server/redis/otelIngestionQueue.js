"use strict";
// langfuse-lite shim: there is no queue; spans are processed in-process.
exports.OtelIngestionQueue = { getInstance: () => null };
