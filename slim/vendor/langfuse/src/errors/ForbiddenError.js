"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ForbiddenError = void 0;
const BaseError_1 = require("./BaseError");
class ForbiddenError extends BaseError_1.BaseError {
    constructor(description = "Access denied. You do not have permission to access this resource.") {
        super("ForbiddenError", 403, description, true);
    }
}
exports.ForbiddenError = ForbiddenError;
