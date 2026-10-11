import { Worker } from "node:worker_threads";
import { isUtf8 } from "node:buffer";
import { deserialize } from "node:v8";
import { createHash } from "node:crypto";
import { brotliDecompressSync } from "node:zlib";
import { assertReadBudgetActive, currentReadBudget, readBudgetAbortError, type ReadBudget } from "./read-budget.js";

const stateCodecPrefix = "COURSE_OS_BR_STATE_V1:";
const largeStateDecodeThresholdBytes = 1_000_000;

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
  // Transfer the complete parsed result; the persistent JSON/Brotli format
  // stays unchanged and no field is omitted to accelerate a reader.
  const valueBytes = serialize(value);
  parentPort.postMessage({ ok: true, valueBytes }, [valueBytes.buffer]);
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
