import type { BillingMode, UnitPriceSnapshot } from "@course-os/contracts";

type PriceDefinition = {
  provider?: string;
  model: string;
  inputMicrousdPerMillion: number;
  outputMicrousdPerMillion: number;
  cachedInputMicrousdPerMillion: number;
};

type PricingConfiguration = {
  capturedAt?: string;
  source?: string;
  prices?: PriceDefinition[];
};

const DEEPSEEK_SOURCE = "https://api-docs.deepseek.com/quick_start/pricing/";
const OPENCODE_SOURCE = "https://opencode.ai/docs/go/";
const DEFAULT_CAPTURED_AT = "2026-08-30T00:00:00.000Z";

const DEFAULT_PRICES: PriceDefinition[] = [
  { provider: "opencode-go", model: "qwen3.8-flash", inputMicrousdPerMillion: 150_000, outputMicrousdPerMillion: 470_000, cachedInputMicrousdPerMillion: 16_000 },
  { provider: "opencode-go", model: "deepseek-v4-flash", inputMicrousdPerMillion: 220_000, outputMicrousdPerMillion: 660_000, cachedInputMicrousdPerMillion: 7_000 },
  { provider: "opencode-go", model: "deepseek-v4-flash-vision-exp", inputMicrousdPerMillion: 220_000, outputMicrousdPerMillion: 660_000, cachedInputMicrousdPerMillion: 7_000 },
  { provider: "opencode-go", model: "deepseek-v4-pro", inputMicrousdPerMillion: 660_000, outputMicrousdPerMillion: 1_980_000, cachedInputMicrousdPerMillion: 22_000 },
  { provider: "deepseek", model: "deepseek-v4-flash", inputMicrousdPerMillion: 220_000, outputMicrousdPerMillion: 660_000, cachedInputMicrousdPerMillion: 7_000 },
  { provider: "deepseek", model: "deepseek-v4-flash-vision-exp", inputMicrousdPerMillion: 220_000, outputMicrousdPerMillion: 660_000, cachedInputMicrousdPerMillion: 7_000 },
  { provider: "deepseek", model: "deepseek-v4-pro", inputMicrousdPerMillion: 660_000, outputMicrousdPerMillion: 1_980_000, cachedInputMicrousdPerMillion: 22_000 }
];

export function priceSnapshotFor(provider: string, model: string): UnitPriceSnapshot | undefined {
  const configuration = readPricingConfiguration();
  const custom = configuration.prices?.find((item) => item.provider === provider && item.model === model)
    ?? configuration.prices?.find((item) => !item.provider && item.model === model);
  const defaultPrice = DEFAULT_PRICES.find((item) => item.provider === provider && item.model === model);
  const definition = custom ?? defaultPrice;
  if (!definition) return undefined;
  const source = configuration.source || (provider === "opencode-go" ? OPENCODE_SOURCE : provider === "deepseek" ? DEEPSEEK_SOURCE : "COURSE_OS_PRICING_SNAPSHOT_JSON");
  const capturedAt = configuration.capturedAt || DEFAULT_CAPTURED_AT;
  return {
    id: `price:${provider}:${model}:${capturedAt}`,
    provider,
    model,
    currency: "USD",
    capturedAt,
    source,
    inputMicrousdPerMillion: definition.inputMicrousdPerMillion,
    outputMicrousdPerMillion: definition.outputMicrousdPerMillion,
    cachedInputMicrousdPerMillion: definition.cachedInputMicrousdPerMillion
  };
}

export function estimateMicrousd(snapshot: UnitPriceSnapshot | undefined, inputTokens: number, cachedInputTokens: number, outputTokens: number): number | undefined {
  if (!snapshot) return undefined;
  const input = Math.max(0, inputTokens - cachedInputTokens);
  const cached = Math.min(Math.max(0, cachedInputTokens), Math.max(0, inputTokens));
  const raw = input * snapshot.inputMicrousdPerMillion + cached * snapshot.cachedInputMicrousdPerMillion + Math.max(0, outputTokens) * snapshot.outputMicrousdPerMillion;
  return Math.max(0, Math.round(raw / 1_000_000));
}

export function billingBreakdown(provider: string, billingMode: BillingMode, costMicrousd: number): { cashCostMicrousd: number; quotaConsumedMicrousd: number } {
  const cost = Math.max(0, Math.round(costMicrousd));
  if (billingMode === "free" || provider === "deterministic-local-fallback") return { cashCostMicrousd: 0, quotaConsumedMicrousd: 0 };
  if (billingMode === "subscription_quota" || provider === "opencode-go") return { cashCostMicrousd: 0, quotaConsumedMicrousd: cost };
  if (billingMode === "metered" || provider === "deepseek") return { cashCostMicrousd: cost, quotaConsumedMicrousd: 0 };
  return { cashCostMicrousd: cost, quotaConsumedMicrousd: 0 };
}

export function billingModeForProvider(provider: string, fallback: BillingMode = "unknown"): BillingMode {
  if (provider === "opencode-go") return "subscription_quota";
  if (provider === "deepseek") return "metered";
  if (provider === "deterministic-local-fallback") return "free";
  return fallback;
}

function readPricingConfiguration(): PricingConfiguration {
  const raw = process.env.COURSE_OS_PRICING_SNAPSHOT_JSON;
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as PricingConfiguration;
    if (!value || typeof value !== "object" || !Array.isArray(value.prices)) return {};
    const prices = value.prices.filter((item) => item && typeof item.model === "string" && [item.inputMicrousdPerMillion, item.outputMicrousdPerMillion, item.cachedInputMicrousdPerMillion].every((amount) => typeof amount === "number" && Number.isFinite(amount) && amount >= 0));
    return {
      capturedAt: typeof value.capturedAt === "string" && value.capturedAt ? value.capturedAt : undefined,
      source: typeof value.source === "string" && value.source ? value.source : undefined,
      prices
    };
  } catch {
    return {};
  }
}
