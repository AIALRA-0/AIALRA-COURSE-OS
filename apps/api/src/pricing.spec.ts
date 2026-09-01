import { afterEach, describe, expect, it, vi } from "vitest";
import { billingBreakdown, estimateMicrousd, priceSnapshotFor } from "./pricing.js";

describe("cost price snapshots", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("calculates cached input, uncached input and output separately", () => {
    const snapshot = priceSnapshotFor("deepseek", "deepseek-v4-flash-vision-exp");
    expect(snapshot).toMatchObject({ inputMicrousdPerMillion: 220_000, cachedInputMicrousdPerMillion: 7_000, outputMicrousdPerMillion: 660_000 });
    expect(estimateMicrousd(snapshot, 1_000, 200, 500)).toBe(507);
  });

  it("records subscription quota as consumption instead of silently calling it free", () => {
    expect(billingBreakdown("opencode-go", "subscription_quota", 12_345)).toEqual({ cashCostMicrousd: 0, quotaConsumedMicrousd: 12_345 });
    expect(billingBreakdown("deepseek", "metered", 12_345)).toEqual({ cashCostMicrousd: 12_345, quotaConsumedMicrousd: 0 });
  });

  it("allows a deployment to replace the default rate table with a versioned snapshot", () => {
    vi.stubEnv("COURSE_OS_PRICING_SNAPSHOT_JSON", JSON.stringify({ capturedAt: "2026-09-01T00:00:00.000Z", source: "internal-rate-card:v2", prices: [{ provider: "deepseek", model: "deepseek-v4-pro", inputMicrousdPerMillion: 1, outputMicrousdPerMillion: 2, cachedInputMicrousdPerMillion: 3 }] }));
    expect(priceSnapshotFor("deepseek", "deepseek-v4-pro")).toMatchObject({ capturedAt: "2026-09-01T00:00:00.000Z", source: "internal-rate-card:v2", inputMicrousdPerMillion: 1 });
  });
});
