"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateModelUsageCosts = calculateModelUsageCosts;
const json_1 = require("../../utils/json");
const matcher_1 = require("./matcher");
// Custom models may only have aggregate cache-write pricing.
const TTL_CACHE_CREATION_USAGE_TYPES = new Set([
    "input_cache_creation_5m",
    "input_cache_creation_1h",
]);
const AGGREGATE_CACHE_CREATION_USAGE_TYPES = [
    "cache_creation_input_tokens",
    "input_cache_creation",
];
function toPricingAttributeRecord(value) {
    const parsedValue = typeof value === "string" ? (0, json_1.safeJsonParse)(value) : value;
    if (!parsedValue ||
        typeof parsedValue !== "object" ||
        Array.isArray(parsedValue)) {
        return {};
    }
    return Object.fromEntries(Object.entries(parsedValue).flatMap(([key, attributeValue]) => typeof attributeValue === "string" ||
        typeof attributeValue === "number" ||
        typeof attributeValue === "boolean"
        ? [[key, String(attributeValue)]]
        : []));
}
function getPricingTierAttributes(pricingTiers, attributes) {
    const attributeSources = new Set();
    for (const tier of pricingTiers) {
        if (tier.isDefault)
            continue;
        for (const condition of tier.conditions) {
            if (!("source" in condition))
                continue;
            attributeSources.add(condition.source);
        }
    }
    if (attributeSources.size === 0)
        return undefined;
    return {
        modelParameters: attributeSources.has("model_parameters")
            ? toPricingAttributeRecord(attributes?.modelParameters)
            : {},
        metadata: attributeSources.has("metadata")
            ? toPricingAttributeRecord(attributes?.metadata)
            : {},
    };
}
function selectPricingTier(pricingTiers, usageDetails, attributes) {
    // Empty usage must not select a tier against a fabricated all-zero vector.
    if (pricingTiers.length === 0 || !(0, matcher_1.hasPricingTierUsageDetails)(usageDetails))
        return null;
    const matchAttributes = getPricingTierAttributes(pricingTiers, attributes);
    return (0, matcher_1.matchPricingTier)(pricingTiers, usageDetails, matchAttributes);
}
function calculateProvidedCosts(providedCostDetails) {
    const providedCostKeys = Object.entries(providedCostDetails)
        .filter(([, value]) => value != null)
        .map(([key]) => key);
    if (providedCostKeys.length === 0)
        return null;
    // A supplied cost disables catalog inference for all other cost buckets.
    const cost_details = { ...providedCostDetails };
    let total_cost = providedCostDetails.total ?? undefined;
    if (total_cost === undefined &&
        providedCostKeys.every((key) => ["input", "output"].includes(key))) {
        total_cost =
            (providedCostDetails.input ?? 0) + (providedCostDetails.output ?? 0);
    }
    return { cost_details, total_cost };
}
function calculateInferredCosts(usageDetails, matchedTier) {
    const prices = new Map(Object.entries(matchedTier?.prices ?? {}));
    const costEntries = [];
    for (const [usageType, units] of Object.entries(usageDetails)) {
        let price = prices.get(usageType);
        if (price == null && TTL_CACHE_CREATION_USAGE_TYPES.has(usageType)) {
            price = AGGREGATE_CACHE_CREATION_USAGE_TYPES.map((key) => prices.get(key)).find((value) => value != null);
        }
        if (units != null && price != null) {
            costEntries.push([usageType, price.mul(units).toNumber()]);
        }
    }
    const cost_details = Object.fromEntries(costEntries);
    let total_cost = cost_details.total ?? undefined;
    if (total_cost === undefined && costEntries.length > 0) {
        total_cost = costEntries.reduce((sum, [, cost]) => sum + cost, 0);
    }
    return { cost_details, total_cost };
}
/** Price usage with a resolved model, retaining provided-cost precedence. */
function calculateModelUsageCosts({ model, usageDetails, providedCostDetails, attributes, }) {
    const matchedTier = selectPricingTier(model.pricingTiers, usageDetails, attributes);
    const { cost_details, total_cost } = calculateProvidedCosts(providedCostDetails ?? {}) ??
        calculateInferredCosts(usageDetails, matchedTier);
    if (!Object.prototype.hasOwnProperty.call(cost_details, "total") &&
        total_cost != null) {
        cost_details.total = total_cost;
    }
    return {
        cost_details,
        total_cost,
        internal_model_id: model.model?.id,
        usage_pricing_tier_id: matchedTier?.pricingTierId ?? null,
        usage_pricing_tier_name: matchedTier?.pricingTierName ?? null,
    };
}
