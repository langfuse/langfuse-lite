// The vendored Langfuse code (see vendor/langfuse/VENDORED.md): the OTel span →
// event conversion, cost calculation and default model prices, exactly as the
// Langfuse worker runs them.

// @ts-expect-error vendored CommonJS without types
import * as otel from "../vendor/langfuse/src/server/otel/OtelIngestionProcessor.js";
// @ts-expect-error vendored CommonJS without types
import * as costs from "../vendor/langfuse/src/server/pricing-tiers/calculateModelUsageCosts.js";
// @ts-expect-error vendored CommonJS without types
import * as otelUtils from "../vendor/langfuse/src/server/otel/utils.js";
import defaultModelPrices from "../vendor/langfuse/default-model-prices.json" with { type: "json" };
import langfuseVersion from "../vendor/langfuse/LANGFUSE_VERSION" with { type: "text" };
import { Decimal } from "decimal.js";

export const LANGFUSE_VERSION = String(langfuseVersion).trim();

export type LangfuseEvent = Record<string, unknown> & {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  startTimeISO: string;
  endTimeISO?: string;
};

export function processSpans(
  resourceSpans: unknown[],
  ctx: { publicKey?: string; sdkName?: string; sdkVersion?: string },
): LangfuseEvent[] {
  const Processor = otel.OtelIngestionProcessor ?? otel.default?.OtelIngestionProcessor;
  const processor = new Processor({
    projectId: "local",
    publicKey: ctx.publicKey ?? "",
    sdkName: ctx.sdkName,
    sdkVersion: ctx.sdkVersion,
  });
  return processor.processToEvent(resourceSpans);
}

export const flattenJsonToPathArrays: (obj: unknown) => { names: string[]; values: (string | null)[] } =
  otelUtils.flattenJsonToPathArrays ?? otelUtils.default?.flattenJsonToPathArrays;

const calculateModelUsageCosts = costs.calculateModelUsageCosts ?? costs.default?.calculateModelUsageCosts;

type Tier = {
  id: string;
  name: string;
  isDefault: boolean;
  priority: number;
  conditions: unknown[];
  prices: { usageType: string; price: Decimal }[];
};
type Model = { id: string; modelName: string; pattern: RegExp; pricingTiers: Tier[] };

let models: Model[] | undefined;
function catalog(): Model[] {
  if (models) return models;
  models = [];
  for (const m of defaultModelPrices as Array<{
    id: string;
    modelName: string;
    matchPattern: string;
    pricingTiers: Array<Omit<Tier, "prices"> & { prices: Record<string, number> }>;
  }>) {
    // Langfuse matches with Postgres regex; `(?i)` there is the `i` flag here.
    const caseInsensitive = m.matchPattern.startsWith("(?i)");
    const source = caseInsensitive ? m.matchPattern.slice(4) : m.matchPattern;
    let pattern: RegExp;
    try {
      pattern = new RegExp(source, caseInsensitive ? "i" : "");
    } catch {
      continue;
    }
    models.push({
      id: m.id,
      modelName: m.modelName,
      pattern,
      pricingTiers: m.pricingTiers.map((t) => ({
        ...t,
        conditions: t.conditions ?? [],
        prices: Object.entries(t.prices).map(([usageType, price]) => ({ usageType, price: new Decimal(price) })),
      })),
    });
  }
  return models;
}

export function findModelById(id: string | null | undefined): Model | undefined {
  return id ? catalog().find((m) => m.id === id) : undefined;
}

export function findModel(modelName: string | undefined | null): Model | undefined {
  if (!modelName) return undefined;
  return catalog().find((m) => m.pattern.test(modelName));
}

/** Langfuse's IngestionService.getGenerationUsage, with the default model prices as the only models. */
export function usageAndCost(params: {
  modelName?: string | null;
  providedUsageDetails: Record<string, unknown>;
  providedCostDetails: Record<string, unknown>;
  modelParameters: unknown;
  metadata: unknown;
}) {
  const model = findModel(params.modelName);
  const provided: Record<string, number> = {};
  for (const [key, value] of Object.entries(params.providedUsageDetails ?? {})) {
    if (value == null) continue;
    const n = Number(value);
    if (!Number.isNaN(n) && n >= 0) provided[key] = n;
  }
  const usageDetails: Record<string, number> = { ...provided };
  if (Object.keys(usageDetails).length > 0 && !("total" in usageDetails)) {
    usageDetails.total = Object.values(provided).reduce((a, b) => a + b, 0);
  }
  const cost = calculateModelUsageCosts({
    model: { model: model ? { id: model.id } : null, pricingTiers: model?.pricingTiers ?? [] },
    usageDetails,
    providedCostDetails: params.providedCostDetails,
    attributes: { modelParameters: params.modelParameters, metadata: params.metadata },
  });
  return {
    usage_details: usageDetails,
    cost_details: cost.cost_details as Record<string, number>,
    total_cost: (cost.total_cost ?? null) as number | null,
    internal_model_id: (cost.internal_model_id ?? null) as string | null,
    usage_pricing_tier_id: (cost.usage_pricing_tier_id ?? null) as string | null,
    usage_pricing_tier_name: (cost.usage_pricing_tier_name ?? null) as string | null,
  };
}
