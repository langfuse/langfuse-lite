"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isBaseError = exports.BaseError = void 0;
class BaseError extends Error {
    name;
    httpCode;
    isOperational;
    constructor(name, httpCode, description, isOperational) {
        super(description);
        Object.setPrototypeOf(this, new.target.prototype); // restore prototype chain
        this.name = name;
        this.httpCode = httpCode;
        this.isOperational = isOperational; // if error is part of known errors that our application can anticipate
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this);
        }
    }
    isUserError() {
        return this.httpCode >= 400 && this.httpCode < 500;
    }
}
exports.BaseError = BaseError;
const isBaseError = (error) => {
    if (error instanceof BaseError)
        return true;
    if (!(error instanceof Error))
        return false;
    const candidate = error;
    return (typeof candidate.httpCode === "number" &&
        typeof candidate.isOperational === "boolean" &&
        typeof candidate.isUserError === "function");
};
exports.isBaseError = isBaseError;
