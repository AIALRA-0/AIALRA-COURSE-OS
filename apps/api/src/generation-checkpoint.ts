import type { GenerationCostEntry, LessonDraft } from "@course-os/contracts";
import type { ModelRouterClient, TeachingGenerationResult } from "./model-router.js";
import type { PlannedCheckpoint } from "./planned-teaching.js";
import { sha256Text, stableStringify } from "@course-os/domain";

/** Recovery receipts are not published content. Authority remains ReadWeave. */
export interface SavedPageGeneration {
  kind: "page-generation-recovery-v1";
  fingerprint: string;
  understanding?: Awaited<ReturnType<NonNullable<ModelRouterClient["understandPage"]>>>;
  understandingCost?: GenerationCostEntry;
  teaching?: TeachingGenerationResult;
  teachingCost?: GenerationCostEntry;
  bridge?: SavedBridgeGeneration;
}

export interface SavedBridgeGeneration {
  response: Awaited<ReturnType<NonNullable<ModelRouterClient["generateBridge"]>>>;
  cost: GenerationCostEntry;
  sourceFingerprint: string;
  previousSourceFingerprint: string;
  previousCoreFingerprint: string;
  coreRevision: number;
  coreContentHash: string;
  bridgedContentHash: string;
  writeIdempotencyKey: string;
  updatedAt: string;
}

export function savedBridgeDraftState(bridge: SavedBridgeGeneration, draft: LessonDraft): "core" | "bridge" | undefined {
  if (draft.revision === bridge.coreRevision && draft.contentHash === bridge.coreContentHash) return "core";
  if (draft.revision === bridge.coreRevision + 1 && draft.contentHash === bridge.bridgedContentHash) return "bridge";
  // ETAPI hashes its persisted JSON bytes; generation checkpoints hash sorted
  // fields. Accept that serialization difference only when the actual page is
  // the paid bridge's exact content and its stored byte hash is valid.
  if (draft.revision === bridge.coreRevision + 1 && draft.page
    && sha256Text(stableStringify(draft.page)) === bridge.bridgedContentHash
    && sha256Text(JSON.stringify(draft.page)) === draft.contentHash) return "bridge";
  return undefined;
}

export type JobCheckpoint = PlannedCheckpoint | SavedPageGeneration;

export function savedPageGeneration(value: JobCheckpoint | undefined, fingerprint: string): SavedPageGeneration {
  if (value && "kind" in value && value.kind === "page-generation-recovery-v1" && value.fingerprint === fingerprint) {
    return structuredClone(value);
  }
  return { kind: "page-generation-recovery-v1", fingerprint };
}
