import type { GenerationCostEntry } from "@course-os/contracts";
import { Worker } from "node:worker_threads";
import { isUtf8 } from "node:buffer";
import { deserialize } from "node:v8";
import { createHash } from "node:crypto";
import { brotliDecompressSync } from "node:zlib";
import { assertReadBudgetActive, currentReadBudget, readBudgetAbortError, type ReadBudget } from "./read-budget.js";

const stateCodecPrefix = "COURSE_OS_BR_STATE_V1:";
const largeStateDecodeThresholdBytes = 1_000_000;


/** Read-only derived view. Never a partial EtapiState or a persistent authority. */
export interface CostRootReadDTO {
  readonly kind: "course-os-cost-root-read";
  readonly projections: {
    readonly courseRootNoteId: string;
    readonly stateNoteId: string;
    readonly metadataIndexNoteId?: string;
    readonly metadataIndexRevision?: number;
    readonly costIndexNoteId?: string;
  };
  readonly releases: readonly { readonly id: string; readonly pageIds: readonly string[]; readonly pages: readonly { readonly id: string }[] }[];
  readonly drafts: readonly { readonly pageId: string; readonly sourceReleaseId?: string }[];
  readonly costEntries: readonly GenerationCostEntry[];
  readonly metadataRootFieldsAreEmpty: boolean;
  readonly metadataReceiptKinds: readonly string[];
}

// Self-contained so the same implementation runs after full JSON validation in
// the decoder worker and when deriving a view from an already verified full root.
export function projectReadWeaveCostRoot(value: unknown): CostRootReadDTO {
  const input = value as Record<string, any>;
  if (!input || typeof input !== "object" || !input.projections || typeof input.projections !== "object") {
    throw new Error("READWEAVE_COURSE_INDEX_INVALID");
  }
  const p = input.projections;
  const releases = [];
  for (const release of input.releases ?? []) {
    const pages = [];
    for (const page of release.pages) pages.push({ id: page.id });
    releases.push({ id: release.id, pageIds: [...release.pageIds], pages });
  }
  const drafts = [];
  for (const draft of input.drafts ?? []) drafts.push({ pageId: draft.pageId, sourceReleaseId: draft.sourceReleaseId });
  const receiptKinds = new Set<string>();
  for (const entry of Object.values(input.idempotency ?? {}) as { kind: string }[]) receiptKinds.add(entry.kind);
  return {
    kind: "course-os-cost-root-read",
    projections: {
      courseRootNoteId: p.courseRootNoteId, stateNoteId: p.stateNoteId,
      metadataIndexNoteId: p.metadataIndexNoteId, metadataIndexRevision: p.metadataIndexRevision,
      costIndexNoteId: p.costIndexNoteId
    },
    releases, drafts, costEntries: [...(input.costEntries ?? [])],
    metadataReceiptKinds: [...receiptKinds],
    metadataRootFieldsAreEmpty: (input.courses ?? []).length === 0
      && (input.treeNodes ?? []).length === 0 && (input.trash ?? []).length === 0
      && Object.keys(p.courses ?? {}).length === 0
      && p.rootMaterialsNoteId === undefined && p.trashNoteId === undefined
      && Object.keys(p.materialReleaseSelections ?? {}).length === 0
  };
}

export async function decodeReadWeaveCostRootAsync(content: string): Promise<CostRootReadDTO> {
  const budget = currentReadBudget();
  if (budget) assertReadBudgetActive(budget);
  // Even a small compressed envelope can contain a very large historical root.
  // Complete decompression/checksum/JSON.parse stay off-thread for this route.
  return await decodeInWorker(content, budget, true) as CostRootReadDTO;
}

export function decodeReadWeaveStateContent(content: string): unknown {
  if (!content.startsWith(stateCodecPrefix)) return JSON.parse(content);
  const encoded = /^COURSE_OS_BR_STATE_V1:([a-f0-9]{64}):([A-Za-z0-9+/]+={0,2})$/u.exec(content);
  if (!encoded) throw new Error("READWEAVE_STATE_CODEC_INVALID");
  const bytes = brotliDecompressSync(Buffer.from(encoded[2]!, "base64"), { maxOutputLength: 512_000_000 });
  const plain = bytes.toString("utf8");
  // Valid UTF-8 is already the encoder's checksum input. Preserve historical
  // replacement-string semantics for malformed bytes instead of changing data.
  if (createHash("sha256").update(isUtf8(bytes) ? bytes : plain).digest("hex") !== encoded[1]) throw new Error("READWEAVE_STATE_CODEC_HASH_MISMATCH");
  return JSON.parse(plain);
}

export async function decodeReadWeaveStateContentAsync(content: string): Promise<unknown> {
  const budget = currentReadBudget();
  if (Buffer.byteLength(content, "utf8") < largeStateDecodeThresholdBytes) {
    if (budget) assertReadBudgetActive(budget);
    const decoded = decodeReadWeaveStateContent(content);
    if (budget) assertReadBudgetActive(budget);
    return decoded;
  }
  if (budget) assertReadBudgetActive(budget);
  return decodeInWorker(content, budget);
}

function decodeInWorker(content: string, budget?: ReadBudget, costRoot = false): Promise<unknown> {
  const worker = new Worker(workerSource, {
    eval: true,
    workerData: { content, costRoot },
    ...(costRoot && Buffer.byteLength(content, "utf8") >= largeStateDecodeThresholdBytes
      ? { resourceLimits: { maxYoungGenerationSizeMb: 64 } } : {})
  });
  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      budget?.signal.removeEventListener("abort", onAbort);
      complete();
    };
    const failAndTerminate = (error: Error) => finish(() => {
      void worker.terminate();
      reject(error);
    });
    const onAbort = () => failAndTerminate(readBudgetAbortError(budget!.signal, budget!.deadline));

    budget?.signal.addEventListener("abort", onAbort, { once: true });
    if (budget?.signal.aborted) {
      onAbort();
      return;
    }
    worker.once("message", (message: unknown) => {
      try {
        if (budget) assertReadBudgetActive(budget);
      } catch (error) {
        failAndTerminate(error instanceof Error ? error : new Error("READWEAVE_STATE_DECODE_FAILED"));
        return;
      }
      if (!isWorkerResult(message)) {
        failAndTerminate(new Error("READWEAVE_STATE_DECODE_FAILED"));
      } else if (!message.ok) {
        finish(() => reject(new Error(safeDecodeError(message.error))));
      } else {
        try {
          const bytes = message.valueBytes;
          const value = deserialize(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
          if (budget) assertReadBudgetActive(budget);
          finish(() => resolve(value));
        } catch (error) {
          failAndTerminate(error instanceof Error && error.message.startsWith("READ_")
            ? error : new Error("READWEAVE_STATE_DECODE_FAILED"));
        }
      }
    });
    worker.once("error", () => failAndTerminate(new Error("READWEAVE_STATE_DECODE_FAILED")));
    worker.once("exit", () => {
      if (!settled) failAndTerminate(new Error("READWEAVE_STATE_DECODE_FAILED"));
    });
  });
}

interface WorkerSuccess {
  ok: true;
  valueBytes: Uint8Array;
}

interface WorkerFailure {
  ok: false;
  error: string;
}

function isWorkerResult(value: unknown): value is WorkerSuccess | WorkerFailure {
  if (!value || typeof value !== "object") return false;
  const result = value as { ok?: unknown; valueBytes?: unknown; error?: unknown };
  return (result.ok === true && result.valueBytes instanceof Uint8Array && result.valueBytes.byteLength > 0)
    || (result.ok === false && typeof result.error === "string");
}

function safeDecodeError(error: string): string {
  switch (error) {
    case "READWEAVE_STATE_CODEC_INVALID":
    case "READWEAVE_STATE_CODEC_HASH_MISMATCH":
    case "READWEAVE_STATE_JSON_INVALID":
    case "READWEAVE_COURSE_INDEX_INVALID":
      return error;
    default:
      return "READWEAVE_STATE_DECODE_FAILED";
  }
}

const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { isUtf8 } = require("node:buffer");
const { serialize } = require("node:v8");
const { createHash } = require("node:crypto");
const { brotliDecompressSync } = require("node:zlib");

try {
  let plain = workerData.content;
  if (plain.startsWith("COURSE_OS_BR_STATE_V1:")) {
    const encoded = /^COURSE_OS_BR_STATE_V1:([a-f0-9]{64}):([A-Za-z0-9+/]+={0,2})$/u.exec(plain);
    if (!encoded) throw new Error("READWEAVE_STATE_CODEC_INVALID");
    let decompressed;
    try {
      decompressed = brotliDecompressSync(Buffer.from(encoded[2], "base64"), { maxOutputLength: 512_000_000 });
    } catch {
      throw new Error("READWEAVE_STATE_CODEC_INVALID");
    }
    plain = decompressed.toString("utf8");
    if (createHash("sha256").update(isUtf8(decompressed) ? decompressed : plain).digest("hex") !== encoded[1]) {
      throw new Error("READWEAVE_STATE_CODEC_HASH_MISMATCH");
    }
  }
  let value;
  try {
    value = JSON.parse(plain);
  } catch {
    throw new Error("READWEAVE_STATE_JSON_INVALID");
  }
  // Generic reads transfer the complete parsed value. The explicit read-only
  // cost mode projects only after full codec/checksum/JSON validation.
  if (workerData.costRoot) value = (${projectReadWeaveCostRoot.toString()})(value);
  const valueBytes = serialize(value);
  parentPort.postMessage({ ok: true, valueBytes }, [valueBytes.buffer]);
} catch (error) {
  const allowed = new Set([
    "READWEAVE_STATE_CODEC_INVALID",
    "READWEAVE_STATE_CODEC_HASH_MISMATCH",
    "READWEAVE_STATE_JSON_INVALID",
    "READWEAVE_COURSE_INDEX_INVALID"
  ]);
  const message = error && allowed.has(error.message) ? error.message : "READWEAVE_STATE_DECODE_FAILED";
  parentPort.postMessage({ ok: false, error: message });
}
`;
