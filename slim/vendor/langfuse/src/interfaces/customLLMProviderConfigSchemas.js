"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GCPServiceAccountKeySchema = exports.VertexAIConfigSchema = exports.BEDROCK_ROLE_PERMISSION_POLICY = exports.BEDROCK_ROLE_ACTIONS = exports.BedrockIamRoleSchema = exports.BedrockCredentialSchema = exports.BedrockApiKeySchema = exports.BedrockAccessKeysSchema = exports.OpenAIConfigSchema = exports.LLMConnectionConfigSchema = exports.LLMConnectionConfigValueSchema = exports.BedrockConfigSchema = exports.GCS_USE_DEFAULT_CREDENTIALS = exports.VERTEXAI_USE_DEFAULT_CREDENTIALS = exports.BEDROCK_USE_DEFAULT_CREDENTIALS = void 0;
exports.parseBedrockIamRole = parseBedrockIamRole;
const zod_1 = require("zod");
const storage_role_auth_1 = require("../domain/storage-role-auth");
// Sentinel value for Bedrock default credential provider chain
exports.BEDROCK_USE_DEFAULT_CREDENTIALS = "__BEDROCK_DEFAULT_CREDENTIALS__";
// Sentinel value for Vertex AI default credential provider chain (ADC)
exports.VERTEXAI_USE_DEFAULT_CREDENTIALS = "__VERTEXAI_DEFAULT_CREDENTIALS__";
// Sentinel the blob-storage form sends as the GCS secret to request the
// deployment's default credentials (ADC) instead of a service account key.
// Never persisted: a keyless GCS integration stores secretAccessKey = null.
exports.GCS_USE_DEFAULT_CREDENTIALS = "__GCS_DEFAULT_CREDENTIALS__";
exports.BedrockConfigSchema = zod_1.z.object({ region: zod_1.z.string() });
exports.LLMConnectionConfigValueSchema = zod_1.z.union([
    zod_1.z.string(),
    zod_1.z.boolean(),
]);
exports.LLMConnectionConfigSchema = zod_1.z.record(zod_1.z.string(), exports.LLMConnectionConfigValueSchema);
exports.OpenAIConfigSchema = zod_1.z
    .object({
    useResponsesApi: zod_1.z.boolean().default(false),
})
    .strict();
exports.BedrockAccessKeysSchema = zod_1.z
    .object({
    accessKeyId: zod_1.z.string().min(1),
    secretAccessKey: zod_1.z.string().min(1),
})
    .strict();
exports.BedrockApiKeySchema = zod_1.z
    .object({
    apiKey: zod_1.z.string().min(1),
})
    .strict();
exports.BedrockCredentialSchema = zod_1.z.union([
    exports.BedrockAccessKeysSchema,
    exports.BedrockApiKeySchema,
]);
// Not part of BedrockCredentialSchema: only connections created by an entitled
// organization may store a role, so every other path keeps rejecting it.
exports.BedrockIamRoleSchema = zod_1.z
    .object({
    roleArn: zod_1.z
        .string()
        .regex(storage_role_auth_1.STORAGE_ROLE_ARN_REGEX, storage_role_auth_1.STORAGE_ROLE_ARN_INVALID_MESSAGE),
})
    .strict();
function parseBedrockIamRole(secretKey) {
    try {
        const parsed = exports.BedrockIamRoleSchema.safeParse(JSON.parse(secretKey));
        return parsed.success ? parsed.data : null;
    }
    catch {
        return null;
    }
}
exports.BEDROCK_ROLE_ACTIONS = [
    "bedrock:InvokeModel",
    "bedrock:InvokeModelWithResponseStream",
];
// Also the session policy of every assumed-role session, so the role is
// limited to model invocation even if the customer grants it more.
exports.BEDROCK_ROLE_PERMISSION_POLICY = {
    Version: "2012-10-17",
    Statement: [
        {
            Effect: "Allow",
            Action: [...exports.BEDROCK_ROLE_ACTIONS],
            Resource: "*",
        },
    ],
};
exports.VertexAIConfigSchema = zod_1.z
    .object({
    location: zod_1.z.string().optional(),
})
    .strict();
exports.GCPServiceAccountKeySchema = zod_1.z.object({
    type: zod_1.z.literal("service_account"),
    project_id: zod_1.z.string(),
    private_key_id: zod_1.z.string(),
    private_key: zod_1.z.string(),
    client_email: zod_1.z.string(),
    client_id: zod_1.z.string(),
    auth_uri: zod_1.z.string(),
    token_uri: zod_1.z.string(),
    auth_provider_x509_cert_url: zod_1.z.string(),
    client_x509_cert_url: zod_1.z.string(),
});
