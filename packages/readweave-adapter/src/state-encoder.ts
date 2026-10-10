import { Worker } from "node:worker_threads";

/**
 * Encode data snapshots using the existing JSON/Brotli disk format in a worker.
 * Validation and structured cloning still run on the caller thread. Custom
 * prototypes, accessors and functions are rejected rather than silently losing
 * their JSON semantics during cloning; the synchronous codec remains available.
 */
export async function encodeReadWeaveStateContentAsync(state: unknown): Promise<string> {
  assertSnapshotData(state);
  const worker = new Worker(workerSource, { eval: true, workerData: state });
  return new Promise<string>((resolve, reject) => {
    let result: { value: string } | { error: Error } | undefined;
    worker.once("message", (message: unknown) => {
      if (message && typeof message === "object" && "ok" in message) {
        if (message.ok === true && "value" in message && typeof message.value === "string") {
          result = { value: message.value };
          return;
        }
        if (message.ok === false && "error" in message && message.error === "READWEAVE_STATE_ENCODE_INVALID") {
          result = { error: new Error("READWEAVE_STATE_ENCODE_INVALID") };
          return;
        }
      }
      result = { error: new Error("READWEAVE_STATE_ENCODE_FAILED") };
      // A malformed worker must not leave a live thread behind. Completion is
      // decided by exit, so the caller never releases its write lock too early.
      void worker.terminate().catch(() => undefined);
    });
    worker.once("error", () => {
      result = { error: new Error("READWEAVE_STATE_ENCODE_FAILED") };
    });
    worker.once("exit", (code) => {
      if (result && "error" in result) reject(result.error);
      else if (code !== 0 || !result) reject(new Error("READWEAVE_STATE_ENCODE_FAILED"));
      else resolve(result.value);
    });
  });
}

function assertSnapshotData(state: unknown): void {
  const pending: unknown[] = [state];
  const seen = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "function" || typeof value === "symbol") throw new Error("READWEAVE_STATE_ENCODE_UNSUPPORTED");
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) {
      throw new Error("READWEAVE_STATE_ENCODE_UNSUPPORTED");
    }
    // JSON invokes toJSON even when it is non-enumerable; cloning discards it.
    const toJSON = Object.getOwnPropertyDescriptor(value, "toJSON");
    if (toJSON && (toJSON.get || toJSON.set || typeof toJSON.value === "function")) {
      throw new Error("READWEAVE_STATE_ENCODE_UNSUPPORTED");
    }
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (descriptor.get || descriptor.set) throw new Error("READWEAVE_STATE_ENCODE_UNSUPPORTED");
      pending.push(descriptor.value);
    }
  }
}

// Match the synchronous disk codec: UTF-8 byte threshold, SHA-256 over JSON,
// Brotli quality 2, and the unchanged V1 prefix/base64 envelope. No JSON text or
// hash is prepared by the caller before handing the data to the worker.
const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { createHash } = require("node:crypto");
const { brotliCompressSync, constants } = require("node:zlib");
try {
  const plain = JSON.stringify(workerData);
  if (typeof plain !== "string") throw new Error("READWEAVE_STATE_ENCODE_INVALID");
  let value = plain;
  if (Buffer.byteLength(plain) >= 1_000_000) {
    const hash = createHash("sha256").update(plain).digest("hex");
    const compressed = brotliCompressSync(plain, { params: { [constants.BROTLI_PARAM_QUALITY]: 2 } });
    value = "COURSE_OS_BR_STATE_V1:" + hash + ":" + compressed.toString("base64");
  }
  parentPort.postMessage({ ok: true, value });
} catch {
  parentPort.postMessage({ ok: false, error: "READWEAVE_STATE_ENCODE_INVALID" });
}
`;
