"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractSkillsFromObservation = extractSkillsFromObservation;
const trace_1 = require("../../features/skills/trace");
const constants_1 = require("../../features/skills/constants");
const toolArguments_1 = require("../../features/skills/toolArguments");
const observations_1 = require("../../domain/observations");
const logger_1 = require("../logger");
function extractSkillsFromObservation({ skillsAvailable: manifest, observationType, name, input, output, isError, metadata, projectId, }) {
    if (observationType !== observations_1.ObservationType.GENERATION &&
        (observationType !== observations_1.ObservationType.TOOL ||
            output == null ||
            isError ||
            !(0, toolArguments_1.isSkillLoadTool)(name, metadata))) {
        return {};
    }
    let parsedManifest = Array.isArray(manifest)
        ? manifest
        : parseJsonPayloadWithMaxSize(manifest, constants_1.MAX_SKILL_CATALOG_JSON_BYTES, "skillsAvailable", projectId);
    if (Array.isArray(parsedManifest) &&
        parsedManifest.length > trace_1.MAX_SKILLS_PER_OBSERVATION) {
        logger_1.logger.warn("OTEL skill catalog dropped: item limit exceeded", {
            projectId,
            count: parsedManifest.length,
            limit: trace_1.MAX_SKILLS_PER_OBSERVATION,
        });
        parsedManifest = undefined;
    }
    const available = Array.isArray(parsedManifest)
        ? trace_1.SkillsAvailableInputSchema.safeParse(parsedManifest)
        : undefined;
    if (observationType === observations_1.ObservationType.GENERATION) {
        if (available?.success)
            return { skillsAvailable: available.data };
        return {};
    }
    const candidates = getSkillLoadRequestsFromInput(name, input, available?.success ? available.data : [], projectId, metadata);
    const resources = [];
    for (const resource of candidates) {
        if (typeof resource.filePath === "string" &&
            resource.filePath.length > constants_1.MAX_SKILL_PATH_LENGTH) {
            logger_1.logger.warn("OTEL skill resource load dropped: path length limit exceeded", {
                projectId,
                name,
                length: resource.filePath.length,
                limit: constants_1.MAX_SKILL_PATH_LENGTH,
            });
            continue;
        }
        const loaded = trace_1.SkillsResourceLoadedSchema.element.safeParse(resource);
        if (loaded.success) {
            resources.push({
                skillName: loaded.data.skillName,
                filePath: loaded.data.filePath,
            });
        }
    }
    if (!resources.length)
        return {};
    return {
        ...(available?.success ? { skillsAvailable: available.data } : {}),
        skillsResourceLoaded: resources,
    };
}
function getSkillLoadRequestsFromInput(toolName, input, available, projectId, metadata) {
    if (isPayloadTooLarge(input, constants_1.MAX_SKILL_TOOL_ARGS_JSON_BYTES, "toolInput", projectId)) {
        return [];
    }
    const args = (0, toolArguments_1.parseSkillToolArguments)(input);
    if (args === undefined)
        return [];
    if (typeof args === "object") {
        const oversizedPath = [args.path, args.file_path].find((path) => typeof path === "string" &&
            path.length > constants_1.MAX_SKILL_TOOL_ARGS_JSON_BYTES);
        if (typeof oversizedPath === "string") {
            logger_1.logger.warn("OTEL skill resource load dropped: input path length limit exceeded", {
                projectId,
                toolName,
                length: oversizedPath.length,
                limit: constants_1.MAX_SKILL_TOOL_ARGS_JSON_BYTES,
            });
            return [];
        }
    }
    return (0, toolArguments_1.getSkillLoadRequestsFromArguments)(toolName, args, available.map((skill) => skill.name), metadata);
}
function parseJsonPayloadWithMaxSize(payload, maxBytes, field, projectId) {
    if (isPayloadTooLarge(payload, maxBytes, field, projectId))
        return undefined;
    if (payload && typeof payload === "object")
        return payload;
    if (typeof payload === "string") {
        try {
            return JSON.parse(payload);
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}
function isPayloadTooLarge(payload, maxBytes, field, projectId) {
    if (typeof payload === "string" &&
        (payload.length > maxBytes || Buffer.byteLength(payload, "utf8") > maxBytes)) {
        logger_1.logger.warn("OTEL skill payload parsing skipped: byte limit exceeded", {
            projectId,
            field,
            limitBytes: maxBytes,
            stringLength: payload.length,
        });
        return true;
    }
    return false;
}
