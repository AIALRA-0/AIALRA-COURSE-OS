import { describe, expect, it } from "vitest";
import type { LessonDraft } from "@course-os/contracts";
import { savedBridgeDraftState, savedPageGeneration, type SavedBridgeGeneration } from "./generation-checkpoint.js";

describe("page generation recovery identity", () => {
  it("does not reuse paid text when its source or writing contract changes", () => {
    const saved = { kind: "page-generation-recovery-v1" as const, fingerprint: "old-source-contract",
      understanding: { sourceDescription: "Old page", teachingPlan: "Old plan", provider: "test", model: "test",
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, durationMs: 1, apiEquivalentUsd: 0 } } };
    expect(savedPageGeneration(saved, "new-source-contract")).toEqual({ kind: "page-generation-recovery-v1", fingerprint: "new-source-contract" });
    expect(savedPageGeneration(saved, saved.fingerprint)).toEqual(saved);
    expect(savedPageGeneration(saved, saved.fingerprint)).not.toBe(saved);
  });

  it("accepts only the original core or the exact acknowledged bridge revision", () => {
    const receipt = { coreRevision: 4, coreContentHash: "core", bridgedContentHash: "bridge" } as SavedBridgeGeneration;
    expect(savedBridgeDraftState(receipt, { revision: 4, contentHash: "core" } as LessonDraft)).toBe("core");
    expect(savedBridgeDraftState(receipt, { revision: 5, contentHash: "bridge" } as LessonDraft)).toBe("bridge");
    expect(savedBridgeDraftState(receipt, { revision: 5, contentHash: "edited" } as LessonDraft)).toBeUndefined();
    expect(savedBridgeDraftState(receipt, { revision: 6, contentHash: "bridge" } as LessonDraft)).toBeUndefined();
    expect(savedBridgeDraftState(receipt, { revision: 5, contentHash: "core" } as LessonDraft)).toBeUndefined();
  });

  it("retains a paid bridge's original bill and write key only for the same source contract", () => {
    const bridge = { response: { markdown: "Paid bridge" }, cost: { id: "original-attempt:bridge" },
      writeIdempotencyKey: "original-attempt:bridge" } as SavedBridgeGeneration;
    const saved = { kind: "page-generation-recovery-v1" as const, fingerprint: "source-and-harness", bridge };
    const recovered = savedPageGeneration(saved, saved.fingerprint);
    expect(recovered.bridge).toEqual(bridge);
    expect(recovered.bridge).not.toBe(bridge);
    expect(savedPageGeneration(saved, "different-harness").bridge).toBeUndefined();
  });
});
