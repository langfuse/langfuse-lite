"use strict";
// langfuse-lite shim: Langfuse's winston logger, reduced to warnings and errors on stderr.
const quiet = () => {};
const say = (level) => (msg, ...rest) => {
  if (process.env.LANGFUSE_LITE_DEBUG) console.error(`[langfuse ${level}]`, msg, ...rest);
};
exports.logger = { debug: quiet, info: quiet, warn: say("warn"), error: say("error") };
