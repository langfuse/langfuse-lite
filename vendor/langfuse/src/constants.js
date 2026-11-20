"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_MCP_REQUEST_ELEMENTS = exports.EXPERIMENT_IO_TRUNCATE_LENGTH = exports.ModelUsageUnit = void 0;
// disable lint as this is exported and used in packages
var ModelUsageUnit;
(function (ModelUsageUnit) {
    ModelUsageUnit["Characters"] = "CHARACTERS";
    ModelUsageUnit["Tokens"] = "TOKENS";
    ModelUsageUnit["Seconds"] = "SECONDS";
    ModelUsageUnit["Milliseconds"] = "MILLISECONDS";
    ModelUsageUnit["Images"] = "IMAGES";
    ModelUsageUnit["Requests"] = "REQUESTS";
})(ModelUsageUnit || (exports.ModelUsageUnit = ModelUsageUnit = {}));
/**
 * How many characters of an experiment item's input / output / expected output
 * the experiments table reads. Shared because a consumer of those fields has to
 * be able to tell a value that was cut off from one that is complete: a string
 * this long may be a prefix, so two of them being equal proves nothing.
 */
exports.EXPERIMENT_IO_TRUNCATE_LENGTH = 1000;
/** Aggregate object members and array elements allowed in one MCP request body. */
exports.MAX_MCP_REQUEST_ELEMENTS = 50_000;
