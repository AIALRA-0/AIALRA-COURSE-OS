import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { decodeReadWeaveStateContent, encodeReadWeaveStateContent, encodeReadWeaveStateContentAsync } from "./etapi.js";

const workerProbe = vi.hoisted(() => ({
  created: [] as Array<import("node:worker_threads").Worker>,
  mode: "normal" as "normal" | "error" | "empty-exit" | "invalid-message" | "nonzero-exit" | "constructor-error"
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(source: string | URL, options?: import("node:worker_threads").WorkerOptions) {
        if (workerProbe.mode === "constructor-error") throw new Error("injected startup failure");
        if (workerProbe.mode === "error") source = 'throw new Error("injected worker failure")';
        if (workerProbe.mode === "empty-exit") source = "process.exit(0)";
        if (workerProbe.mode === "nonzero-exit") source = 'require("node:worker_threads").parentPort.postMessage({ok:true,value:"premature"}); process.exit(1)';
        if (workerProbe.mode === "invalid-message") source = 'require("node:worker_threads").parentPort.postMessage({ok:true,value:42}); setInterval(() => {}, 1000)';
        super(source, options);
        workerProbe.created.push(this);
      }
    }
  };
});

it("keeps small asynchronous snapshots as identical plain JSON", async () => {
  const state = { schemaVersion: "1.0.0", marker: "synthetic-small", payload: "synthetic" };
  expect(await encodeReadWeaveStateContentAsync(state)).toBe(JSON.stringify(state));
  expect(await encodeReadWeaveStateContentAsync(state)).toBe(encodeReadWeaveStateContent(state));
});

it("encodes a large synthetic snapshot with exact byte parity and round-trip integrity while timers run", async () => {
  const state = { schemaVersion: "1.0.0", marker: "synthetic-large", payload: randomBytes(2_500_000).toString("base64") };
  expect(Buffer.byteLength(JSON.stringify(state))).toBeGreaterThan(1_000_000);
  const expected = encodeReadWeaveStateContent(state);
  let heartbeats = 0;
  const heartbeat = setInterval(() => { heartbeats++; }, 1);
  let encoded: string;
  try {
    encoded = await encodeReadWeaveStateContentAsync(state);
  } finally { clearInterval(heartbeat); }
  expect(encoded).toBe(expected);
  expect(encoded.startsWith("COURSE_OS_BR_STATE_V1:")).toBe(true);
  expect(decodeReadWeaveStateContent(encoded)).toEqual(state);
  // No machine-specific speed threshold: the timer must run before encoding finishes.
  expect(heartbeats).toBeGreaterThan(0);
});

it.each([999_999, 1_000_000, 1_000_001])("keeps the exact UTF-8 disk format at %s bytes", async (bytes) => {
  const overhead = Buffer.byteLength(JSON.stringify({ payload: "" }));
  const state = { payload: "界".repeat(Math.floor((bytes - overhead) / 3)) + "x".repeat((bytes - overhead) % 3) };
  expect(Buffer.byteLength(JSON.stringify(state))).toBe(bytes);
  const encoded = await encodeReadWeaveStateContentAsync(state);
  expect(encoded).toBe(encodeReadWeaveStateContent(state));
  expect(encoded.startsWith("COURSE_OS_BR_STATE_V1:")).toBe(bytes >= 1_000_000);
  expect(decodeReadWeaveStateContent(encoded)).toEqual(state);
});

it("preserves JSON ordering, escapes, sparse arrays and data normalization", async () => {
  const state = Object.assign(Object.create(null), {
    "10": "ten", "2": "two", title: "中文\n\"quote\"\\slash\u0000", omitted: undefined,
    array: [undefined, , NaN, Infinity, -0, { key: true }], nested: { z: null, a: false }
  });
  expect(await encodeReadWeaveStateContentAsync(state)).toBe(encodeReadWeaveStateContent(state));
});

it("captures the snapshot before the caller mutates it", async () => {
  const state = { page: { title: "before" } };
  const expected = encodeReadWeaveStateContent(state);
  const pending = encodeReadWeaveStateContentAsync(state);
  state.page.title = "after";
  expect(await pending).toBe(expected);
});

it("offloads serialization of a synthetic root near 95 MB while the caller continues servicing timers", async () => {
  // Strings vary by page, so this exercises snapshot structure as well as text.
  const state = {
    schemaVersion: "1.0.0", marker: "synthetic-root",
    pages: Array.from({ length: 96 }, (_, index) => ({
      id: `synthetic-page-${index}`, revision: index,
      markdown: `${index}:` + "synthetic中文\\\"\n".repeat(46_000)
    })),
    events: Array.from({ length: 12_000 }, (_, index) => ({
      id: `synthetic-event-${index}`, pageId: `synthetic-page-${index % 96}`,
      detail: { stage: "saved", revision: index, flags: [true, false], reason: "synthetic-only" }
    }))
  };
  const plainBytes = Buffer.byteLength(JSON.stringify(state));
  expect(plainBytes).toBeGreaterThan(90_000_000);
  const expected = encodeReadWeaveStateContent(state);
  const createdBefore = workerProbe.created.length;
  const stringify = vi.spyOn(JSON, "stringify");
  let heartbeats = 0;
  let encodingDone = false;
  let timerDuringWorker = false;
  const startedAt = performance.now();
  const heartbeat = setInterval(() => {
    heartbeats += 1;
    const worker = workerProbe.created[createdBefore];
    if (!encodingDone && worker && worker.threadId !== -1) timerDuringWorker = true;
  }, 1);
  let encoded: string;
  let dispatchMs: number;
  try {
    const pending = encodeReadWeaveStateContentAsync(state);
    dispatchMs = performance.now() - startedAt;
    // The old async compressor could pass a timer test while still stringifying
    // the whole snapshot on this thread. Check that stage directly as well.
    expect(stringify).not.toHaveBeenCalled();
    encoded = await pending;
    encodingDone = true;
    expect(stringify).not.toHaveBeenCalled();
  } finally {
    clearInterval(heartbeat);
    stringify.mockRestore();
  }
  const elapsedMs = performance.now() - startedAt;
  expect(encoded).toBe(expected);
  expect(timerDuringWorker).toBe(true);
  expect(heartbeats).toBeGreaterThan(0);
  expect(workerProbe.created[createdBefore]!.threadId).toBe(-1);
  expect(decodeReadWeaveStateContent(encoded)).toEqual(state);
  console.info("synthetic_state_encode", { plainBytes, dispatchMs, elapsedMs, heartbeats });
}, 30_000);

it("preserves corruption detection for worker-encoded state", async () => {
  const encoded = await encodeReadWeaveStateContentAsync({ payload: "synthetic".repeat(150_000) });
  const tampered = encoded.replace(/^(COURSE_OS_BR_STATE_V1:)([a-f0-9])/u,
    (_match, prefix: string, digit: string) => `${prefix}${digit === "0" ? "1" : "0"}`);
  expect(() => decodeReadWeaveStateContent(tampered)).toThrow("READWEAVE_STATE_CODEC_HASH_MISMATCH");
  expect(() => decodeReadWeaveStateContent(encoded.slice(0, -4) + "!")).toThrow("READWEAVE_STATE_CODEC_INVALID");
});

it.each(["cycle", "bigint", "undefined"])("rejects %s serialization and exits its worker before rejecting", async (kind) => {
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  const state = kind === "cycle" ? cycle : kind === "bigint" ? { value: 1n } : undefined;
  const createdBefore = workerProbe.created.length;
  await expect(encodeReadWeaveStateContentAsync(state)).rejects.toThrow("READWEAVE_STATE_ENCODE_INVALID");
  expect(workerProbe.created).toHaveLength(createdBefore + 1);
  expect(workerProbe.created[createdBefore]!.threadId).toBe(-1);
  await expect(encodeReadWeaveStateContentAsync({ recovered: true })).resolves.toBe('{"recovered":true}');
});

it("rejects clone-incompatible or custom JSON semantics instead of encoding changed data", async () => {
  class Custom { toJSON() { return "custom"; } }
  const getter = Object.defineProperty({}, "value", { enumerable: true, get() { throw new Error("getter must not run"); } });
  const hiddenToJSON = Object.defineProperty({}, "toJSON", { value: () => "custom" });
  const states = [{ callback: () => {} }, { symbol: Symbol("value") }, { bytes: Buffer.from("data") },
    { date: new Date(0) }, new Custom(), getter, hiddenToJSON];
  const createdBefore = workerProbe.created.length;
  for (const state of states) await expect(encodeReadWeaveStateContentAsync(state)).rejects.toThrow("READWEAVE_STATE_ENCODE_UNSUPPORTED");
  expect(workerProbe.created).toHaveLength(createdBefore);
  // This remains valid through the unchanged synchronous compatibility path.
  expect(encodeReadWeaveStateContent(new Custom())).toBe('"custom"');
  expect(encodeReadWeaveStateContent({ bytes: Buffer.from("data") })).toBe('{"bytes":{"type":"Buffer","data":[100,97,116,97]}}');
});

it.each(["error", "empty-exit", "invalid-message", "nonzero-exit", "constructor-error"] as const)("cleans up after worker %s and permits a fresh encode", async (mode) => {
  const createdBefore = workerProbe.created.length;
  workerProbe.mode = mode;
  try {
    await expect(encodeReadWeaveStateContentAsync({ valid: true })).rejects.toThrow(
      mode === "constructor-error" ? "injected startup failure" : "READWEAVE_STATE_ENCODE_FAILED"
    );
    for (const worker of workerProbe.created.slice(createdBefore)) expect(worker.threadId).toBe(-1);
  } finally {
    workerProbe.mode = "normal";
  }
  await expect(encodeReadWeaveStateContentAsync({ recovered: true })).resolves.toBe('{"recovered":true}');
  expect(workerProbe.created.at(-1)!.threadId).toBe(-1);
});
