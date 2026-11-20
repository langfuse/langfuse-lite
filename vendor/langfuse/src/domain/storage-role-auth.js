"use strict";
// Client-safe contracts for IAM role auth on customer-owned S3 buckets.
Object.defineProperty(exports, "__esModule", { value: true });
exports.STORAGE_ROLE_WRITE_ACTIONS = exports.STORAGE_ROLE_READ_ACTIONS = exports.STORAGE_ROLE_PREFIX_INVALID_MESSAGE = exports.STORAGE_ROLE_PREFIX_REGEX = exports.STORAGE_ROLE_ARN_INVALID_MESSAGE = exports.STORAGE_ROLE_ARN_REGEX = void 0;
exports.getArnPartition = getArnPartition;
exports.buildStorageRoleTrustPolicy = buildStorageRoleTrustPolicy;
exports.buildStorageRolePermissionPolicy = buildStorageRolePermissionPolicy;
// Other partitions (ISO, EU sovereign cloud) use different S3 DNS suffixes,
// which the session policy's kms:ViaService condition does not cover.
exports.STORAGE_ROLE_ARN_REGEX = /^arn:aws(?:-cn|-us-gov)?:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;
exports.STORAGE_ROLE_ARN_INVALID_MESSAGE = "Role ARN must look like arn:aws:iam::123456789012:role/role-name, in the aws, aws-cn or aws-us-gov partition";
// IAM reads `*`, `?` and `$` in a resource as wildcards or variables, so a
// prefix that contains them would widen the session policy. A leading "/" or
// a "//" would make the policy disagree with the app's key check.
exports.STORAGE_ROLE_PREFIX_REGEX = /^(?!\/)(?!.*\/\/)[^*?$]*$/;
exports.STORAGE_ROLE_PREFIX_INVALID_MESSAGE = 'With IAM role auth, the prefix cannot start with "/" or contain "//", "*", "?" or "$"';
function getArnPartition(arn) {
    return arn.split(":")[1] || "aws";
}
/**
 * Trust policy the customer attaches to their role so the Langfuse
 * cross-account role can assume it with the integration's external ID.
 */
function buildStorageRoleTrustPolicy({ crossAccountRoleArn, externalId, }) {
    return {
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Principal: { AWS: crossAccountRoleArn },
                Action: "sts:AssumeRole",
                Condition: { StringEquals: { "sts:ExternalId": externalId } },
            },
            {
                Effect: "Allow",
                Principal: { AWS: crossAccountRoleArn },
                Action: ["sts:TagSession", "sts:SetSourceIdentity"],
            },
        ],
    };
}
exports.STORAGE_ROLE_READ_ACTIONS = {
    s3: ["s3:GetObject"],
    kms: ["kms:Decrypt"],
};
// Multipart uploads need kms:Decrypt to complete on SSE-KMS buckets.
exports.STORAGE_ROLE_WRITE_ACTIONS = {
    s3: ["s3:PutObject", "s3:AbortMultipartUpload", "s3:DeleteObject"],
    kms: ["kms:GenerateDataKey", "kms:Decrypt"],
};
/**
 * Minimal S3 permissions the customer role needs for the given actions on
 * objects under the prefix.
 */
function buildStorageRolePermissionPolicy({ roleArn, bucketName, prefix, actions, }) {
    const partition = getArnPartition(roleArn);
    return {
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Action: actions.s3,
                Resource: `arn:${partition}:s3:::${bucketName}/${prefix ?? ""}*`,
            },
        ],
    };
}
