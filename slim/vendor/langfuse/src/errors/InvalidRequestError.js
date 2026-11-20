"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InvalidRequestError = void 0;
const BaseError_1 = require("./BaseError");
class InvalidRequestError extends BaseError_1.BaseError {
    constructor(description = "Invalid Request Error") {
        super("InvalidRequestError", 400, description, true);
    }
}
exports.InvalidRequestError = InvalidRequestError;
