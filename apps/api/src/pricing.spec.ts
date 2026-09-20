import { afterEach, describe, expect, it, vi } from "vitest";
import { billingBreakdown, estimateMicrousd, priceSnapshotFor, searchPriceSnapshotFor } from "./pricing.js";

describe("cost price snapshots", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("calculates cached input, uncached input and output separately", () => {
    const snapshot = priceSnapshotFor("deepseek", "deepseek-v4-flash-vision-exp");
    expect(snapshot).toMatchObject({ inputMicrousdPerMillion: 300_000, cachedInputMicrousdPerMillion: 6_000, outputMicrousdPerMillion: 1_200_000 });
    expect(estimateMicrousd(snapshot, 1_000, 200, 500)).toBe(841);
  });
  it("prices the model alias reported by DeepSeek without calling a billed request free", () => {
    const snapshot = priceSnapshotFor("deepseek", "deepseek-flash");
    expect(snapshot).toMatchObject({ model: "deepseek-flash", inputMicrousdPerMillion: 300_000, outputMicrousdPerMillion: 1_200_000 });
    expect(estimateMicrousd(snapshot, 1_000, 0, 500)).toBe(900);
  });

  it("keeps the Kuafu rate card separate from official DeepSeek pricing", () => {
    const snapshot = priceSnapshotFor("kuafu", "deepseek-v4.1-flash");
    expect(snapshot).toMatchObject({ provider: "kuafu", model: "deepseek-v4.1-flash", inputMicrousdPerMillion: 225_000, outputMicrousdPerMillion: 675_000 });
    expect(billingBreakdown("kuafu", "metered", 1_000)).toEqual({ cashCostMicrousd: 1_000, quotaConsumedMicrousd: 0 });
  });

  it("exposes independent search request price snapshots", () => {
    expect(searchPriceSnapshotFor("octen")).toMatchObject({ provider: "octen", currency: "USD", perRequestMicrousd: 1_000 });
    expect(searchPriceSnapshotFor("openalex")).toMatchObject({ provider: "openalex", perRequestMicrousd: 1_000 });
    expect(searchPriceSnapshotFor("unknown")).toBeUndefined();
  });

  it("tracks Luna usage against the OpenCode Go subscription quota", () => {
    const snapshot = priceSnapshotFor("opencode-go", "gpt-5.6-luna");
    expect(snapshot).toMatchObject({ inputMicrousdPerMillion: 200_000, cachedInputMicrousdPerMillion: 20_000, outputMicrousdPerMillion: 1_200_000 });
    expect(estimateMicrousd(snapshot, 1_000, 200, 500)).toBe(764);
  });

  it.each([
    ["2026-09-15T00:59:59Z",150000], ["2026-09-15T01:00:00Z",300000],
    ["2026-09-15T04:00:00Z",150000], ["2026-09-15T06:00:00Z",300000],
    ["2026-09-15T10:00:00Z",150000], ["2026-09-19T06:00:00Z",150000]
  ])("uses the published UTC price window at %s", (instant, expected) => {
    const price = priceSnapshotFor("opencode-go","deepseek-v4-flash-vision-exp",new Date(instant));
    expect(price?.inputMicrousdPerMillion).toBe(expected);
    expect(price?.id).toContain(expected === 300000 ? ":peak" : ":offpeak");
  });
  it("does not discount an explicit custom OpenCode rate card", () => {
    vi.stubEnv("COURSE_OS_PRICING_SNAPSHOT_JSON",JSON.stringify({prices:[{provider:"opencode-go",model:"deepseek-v4-flash",inputMicrousdPerMillion:123,outputMicrousdPerMillion:456,cachedInputMicrousdPerMillion:7}]}));
    expect(priceSnapshotFor("opencode-go","deepseek-v4-flash",new Date("2026-09-19T06:00:00Z"))?.inputMicrousdPerMillion).toBe(123);
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
