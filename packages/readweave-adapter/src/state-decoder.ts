import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { brotliDecompressSync } from "node:zlib";
import { assertReadBudgetActive, currentReadBudget, readBudgetAbortError, type ReadBudget } from "./read-budget.js";

const stateCodecPrefix = "COURSE_OS_BR_STATE_V1:";
const largeStateDecodeThresholdBytes = 1_000_000;

export function decodeReadWeaveStateContent(content: string): unknown {
  if (!content.startsWith(stateCodecPrefix)) return JSON.parse(content);
  const encoded = /^COURSE_OS_BR_STATE_V1:([a-f0-9]{64}):([A-Za-z0-9+/]+={0,2})$/u.exec(content);
  if (!encoded) throw new Error("READWEAVE_STATE_CODEC_INVALID");
  const plain = brotliDecompressSync(Buffer.from(encoded[2]!, "base64"), { maxOutputLength: 512_000_000 }).toString("utf8");
  if (createHash("sha256").update(plain).digest("hex") !== encoded[1]) throw new Error("READWEAVE_STATE_CODEC_HASH_MISMATCH");
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

function decodeInWorker(content: string, budget?: ReadBudget): Promise<unknown> {
  const worker = new Worker(workerSource, { eval: true, workerData: content });
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
        finish(() => resolve(message.value));
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
  value: unknown;
}

interface WorkerFailure {
  ok: false;
  error: string;
}

function isWorkerResult(value: unknown): value is WorkerSuccess | WorkerFailure {
  if (!value || typeof value !== "object") return false;
  const result = value as { ok?: unknown; value?: unknown; error?: unknown };
  return (result.ok === true && "value" in result) || (result.ok === false && typeof result.error === "string");
}

function safeDecodeError(error: string): string {
  switch (error) {
    case "READWEAVE_STATE_CODEC_INVALID":
    case "READWEAVE_STATE_CODEC_HASH_MISMATCH":
    case "READWEAVE_STATE_JSON_INVALID":
      return error;
    default:
      return "READWEAVE_STATE_DECODE_FAILED";
  }
}

const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { createHash } = require("node:crypto");
const { brotliDecompressSync } = require("node:zlib");

try {
  let plain = workerData;
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
    if (createHash("sha256").update(plain).digest("hex") !== encoded[1]) {
      throw new Error("READWEAVE_STATE_CODEC_HASH_MISMATCH");
    }
  }
  let value;
  try {
    value = JSON.parse(plain);
  } catch {
    throw new Error("READWEAVE_STATE_JSON_INVALID");
  }
  parentPort.postMessage({ ok: true, value });
} catch (error) {
  const allowed = new Set([
    "READWEAVE_STATE_CODEC_INVALID",
    "READWEAVE_STATE_CODEC_HASH_MISMATCH",
    "READWEAVE_STATE_JSON_INVALID"
  ]);
  const message = error && allowed.has(error.message) ? error.message : "READWEAVE_STATE_DECODE_FAILED";
  parentPort.postMessage({ ok: false, error: message });
}
`;
