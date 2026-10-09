import { describe, expect, it } from "vitest";
import { savedPageGeneration } from "./generation-checkpoint.js";

describe("page generation recovery identity", () => {
  it("does not reuse paid text when its source or writing contract changes", () => {
    const saved = { kind: "page-generation-recovery-v1" as const, fingerprint: "old-source-contract",
      understanding: { sourceDescription: "Old page", teachingPlan: "Old plan", provider: "test", model: "test",
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, durationMs: 1, apiEquivalentUsd: 0 } } };
    expect(savedPageGeneration(saved, "new-source-contract")).toEqual({ kind: "page-generation-recovery-v1", fingerprint: "new-source-contract" });
    expect(savedPageGeneration(saved, saved.fingerprint)).toEqual(saved);
    expect(savedPageGeneration(saved, saved.fingerprint)).not.toBe(saved);
  });
});
