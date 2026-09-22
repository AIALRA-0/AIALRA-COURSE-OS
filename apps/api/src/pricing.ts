import type { BillingMode, SearchPriceSnapshot, UnitPriceSnapshot } from "@course-os/contracts";

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
const KUAFU_SOURCE = "course-os-provider-profile:kuafu-v4.1";
const CODEX_SOURCE = "course-os-provider-profile:codex-luna";
const KIMI_SOURCE = "course-os-provider-profile:kimi-coding-highspeed";
const DEFAULT_CAPTURED_AT = "2026-09-10T04:00:00.000Z";

const DEFAULT_PRICES: PriceDefinition[] = [
  { provider: "opencode-go", model: "gpt-5.6-luna", inputMicrousdPerMillion: 200_000, outputMicrousdPerMillion: 1_200_000, cachedInputMicrousdPerMillion: 20_000 },
  { provider: "opencode-go", model: "qwen3.8-flash", inputMicrousdPerMillion: 150_000, outputMicrousdPerMillion: 470_000, cachedInputMicrousdPerMillion: 16_000 },
  { provider: "opencode-go", model: "deepseek-v4-flash", inputMicrousdPerMillion: 300_000, outputMicrousdPerMillion: 1_200_000, cachedInputMicrousdPerMillion: 6_000 },
  { provider: "opencode-go", model: "deepseek-v4-flash-vision-exp", inputMicrousdPerMillion: 300_000, outputMicrousdPerMillion: 1_200_000, cachedInputMicrousdPerMillion: 6_000 },
  { provider: "opencode-go", model: "deepseek-v4-pro", inputMicrousdPerMillion: 1_320_000, outputMicrousdPerMillion: 3_960_000, cachedInputMicrousdPerMillion: 44_000 },
  // Conservative peak rates for V4.1 Flash; the legacy V4 Flash names now
  // route to this model. Runtime configuration may replace this snapshot.
  { provider: "deepseek", model: "deepseek-flash", inputMicrousdPerMillion: 300_000, outputMicrousdPerMillion: 1_200_000, cachedInputMicrousdPerMillion: 6_000 },
  { provider: "deepseek", model: "deepseek-v4-flash", inputMicrousdPerMillion: 300_000, outputMicrousdPerMillion: 1_200_000, cachedInputMicrousdPerMillion: 6_000 },
  { provider: "deepseek", model: "deepseek-v4-flash-vision-exp", inputMicrousdPerMillion: 300_000, outputMicrousdPerMillion: 1_200_000, cachedInputMicrousdPerMillion: 6_000 },
  { provider: "deepseek", model: "deepseek-v4-pro", inputMicrousdPerMillion: 660_000, outputMicrousdPerMillion: 1_980_000, cachedInputMicrousdPerMillion: 22_000 },
  // Course OS keeps this as its own versioned profile. Deployment pricing can
  // replace it through COURSE_OS_PRICING_SNAPSHOT_JSON before enabling Kuafu.
  { provider: "kuafu", model: "deepseek-v4.1-flash", inputMicrousdPerMillion: 225_000, outputMicrousdPerMillion: 675_000, cachedInputMicrousdPerMillion: 7_500 },
  { provider: "kuafu-backup", model: "deepseek-v4.1-flash-expires-on-0910", inputMicrousdPerMillion: 225_000, outputMicrousdPerMillion: 675_000, cachedInputMicrousdPerMillion: 7_500 },
  { provider: "codex", model: "gpt-5.6-luna", inputMicrousdPerMillion: 200_000, outputMicrousdPerMillion: 1_200_000, cachedInputMicrousdPerMillion: 20_000 },
  { provider: "kimi-coding", model: "kimi-for-coding-highspeed", inputMicrousdPerMillion: 200_000, outputMicrousdPerMillion: 1_200_000, cachedInputMicrousdPerMillion: 20_000 }
];

const DEFAULT_SEARCH_PRICES: Record<string, number> = {
  tinyfish: 0,
  octen: 1_000,
  openalex: 1_000,
  parallel: 1_000,
  exa: 7_000,
  jina: 1_000,
  serper: 1_000
};

export function priceSnapshotFor(provider: string, model: string, at = new Date()): UnitPriceSnapshot | undefined {
  const configuration = readPricingConfiguration();
  // DeepSeek may report its V4 Flash response under this shorter name.
  // Flash and Flash Vision share the published token rates.
  const pricedModel = model;
  const custom = configuration.prices?.find((item) => item.provider === provider && item.model === model)
    ?? configuration.prices?.find((item) => item.provider === provider && item.model === pricedModel)
    ?? configuration.prices?.find((item) => !item.provider && item.model === model)
    ?? configuration.prices?.find((item) => !item.provider && item.model === pricedModel);
  const defaultPrice = DEFAULT_PRICES.find((item) => item.provider === provider && item.model === pricedModel);
  const definition = custom ?? defaultPrice;
  if (!definition) return undefined;
  const source = configuration.source || (provider === "opencode-go" ? OPENCODE_SOURCE : provider === "deepseek" ? DEEPSEEK_SOURCE : provider === "kuafu" || provider === "kuafu-backup" ? KUAFU_SOURCE : provider === "codex" ? CODEX_SOURCE : provider === "kimi-coding" ? KIMI_SOURCE : "COURSE_OS_PRICING_SNAPSHOT_JSON");
  const capturedAt = configuration.capturedAt || (provider === "opencode-go" ? "2026-09-15T13:00:00.000Z" : DEFAULT_CAPTURED_AT);
  // OpenCode's published DeepSeek schedule uses UTC, not the server timezone.
  // Explicit deployment rate cards remain authoritative and are never discounted.
  const scheduled = !custom && provider === "opencode-go" && model.startsWith("deepseek-");
  const weekday = at.getUTCDay() >= 1 && at.getUTCDay() <= 5;
  const hour = at.getUTCHours();
  const peak = weekday && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
  const multiplier = scheduled && !peak ? 0.5 : 1;
  return {
    id: `price:${provider}:${model}:${capturedAt}${scheduled ? peak ? ":peak" : ":offpeak" : ""}`,
    provider,
    model,
    currency: "USD",
    capturedAt,
    source,
    inputMicrousdPerMillion: definition.inputMicrousdPerMillion * multiplier,
    outputMicrousdPerMillion: definition.outputMicrousdPerMillion * multiplier,
    cachedInputMicrousdPerMillion: definition.cachedInputMicrousdPerMillion * multiplier
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
  if (provider === "kuafu" || provider === "kuafu-backup") return "metered";
  if (provider === "codex" || provider === "kimi-coding") return "metered";
  if (provider === "deterministic-local-fallback") return "free";
  return fallback;
}

export function searchPriceSnapshotFor(provider: string, at = new Date()): SearchPriceSnapshot | undefined {
  const perRequestMicrousd = DEFAULT_SEARCH_PRICES[provider];
  if (perRequestMicrousd === undefined) return undefined;
  const capturedAt = DEFAULT_CAPTURED_AT;
  return {
    id: `search-price:${provider}:${capturedAt}`,
    provider,
    currency: "USD",
    capturedAt,
    source: "course-os-provider-profile",
    perRequestMicrousd
  };
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
