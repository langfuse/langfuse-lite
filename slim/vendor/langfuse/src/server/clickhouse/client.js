"use strict";
// langfuse-lite shim: only the date helper, no ClickHouse client.
exports.convertDateToClickhouseDateTime = (date) => date.toISOString().replace("T", " ").replace("Z", "");
