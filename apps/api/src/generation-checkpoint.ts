import type { GenerationCostEntry } from "@course-os/contracts";
import type { ModelRouterClient, TeachingGenerationResult } from "./model-router.js";
import type { PlannedCheckpoint } from "./planned-teaching.js";

/** Recovery receipts are not published content. Authority remains ReadWeave. */
export interface SavedPageGeneration {
  kind: "page-generation-recovery-v1";
  fingerprint: string;
  understanding?: Awaited<ReturnType<NonNullable<ModelRouterClient["understandPage"]>>>;
  understandingCost?: GenerationCostEntry;
  teaching?: TeachingGenerationResult;
  teachingCost?: GenerationCostEntry;
}

export type JobCheckpoint = PlannedCheckpoint | SavedPageGeneration;

export function savedPageGeneration(value: JobCheckpoint | undefined, fingerprint: string): SavedPageGeneration {
  if (value && "kind" in value && value.kind === "page-generation-recovery-v1" && value.fingerprint === fingerprint) {
    return structuredClone(value);
  }
  return { kind: "page-generation-recovery-v1", fingerprint };
}
