import { createHash, randomBytes } from "node:crypto";
import { brotliCompressSync } from "node:zlib";
import { expect, it } from "vitest";
import { encodeReadWeaveStateContent } from "./etapi.js";
import { withReadBudget } from "./read-budget.js";
import { decodeReadWeaveStateContentAsync } from "./state-decoder.js";

function makeLargeEncodedState(): { encoded: string; payload: string } {
  const payload = randomBytes(2_500_000).toString("base64");
  const encoded = encodeReadWeaveStateContent({ schemaVersion: "1.0.0", marker: "large-worker-state", payload });
  if (Buffer.byteLength(encoded) <= 1_000_000) throw new Error("test state did not exceed the worker threshold");
  return { encoded, payload };
}

it("decodes a large compressed state off-thread and keeps the event loop responsive", async () => {
  const { encoded, payload } = makeLargeEncodedState();
  let heartbeats = 0;
  const heartbeat = setInterval(() => { heartbeats += 1; }, 1);
  let decoded: unknown;
  try {
    decoded = await decodeReadWeaveStateContentAsync(encoded);
  } finally {
    clearInterval(heartbeat);
  }

  expect(decoded).toMatchObject({ schemaVersion: "1.0.0", marker: "large-worker-state", payload });
  expect(heartbeats).toBeGreaterThan(0);
  const tampered = encoded.replace(/^(COURSE_OS_BR_STATE_V1:)([a-f0-9])/u, (_match, prefix: string, digit: string) => `${prefix}${digit === "0" ? "1" : "0"}`);
  await expect(decodeReadWeaveStateContentAsync(tampered)).rejects.toThrow("READWEAVE_STATE_CODEC_HASH_MISMATCH");
});

it("terminates a large decode on cancellation and allows a fresh decode", async () => {
  const { encoded, payload } = makeLargeEncodedState();
  const controller = new AbortController();
  const pending = withReadBudget({ signal: controller.signal }, () => decodeReadWeaveStateContentAsync(encoded));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  controller.abort();

  await expect(pending).rejects.toThrow("READ_CANCELLED");
  await expect(decodeReadWeaveStateContentAsync(encoded)).resolves.toMatchObject({
    schemaVersion: "1.0.0",
    marker: "large-worker-state",
    payload
  });
});

it("transfers every nested JSON field without changing Unicode, numeric values or property keys", async () => {
  const state = JSON.parse('{"__proto__":{"synthetic":true},"negativeZero":0}') as any;
  state.payload = randomBytes(1_300_000).toString("base64");
  state.releases = Array.from({ length: 600 }, (_, index) => ({ id: `release-${index}`, pages: [
    { id: `page-${index}`, pageNumber: index + 1, title: "注意力 Attention", text: "中文、é、😀、\\、\"、\n", values: [null, true, false, 0, 1e300, -1e-300] }
  ] }));
  state.projections = { drafts: { first: { blockHashes: { "课程": "confirmed" } } }, courses: ["one", "two"] };
  state.costEntries = [{ id: "cost-one", total: 17 }, { id: "cost-two", total: 23 }];
  const text = JSON.stringify(state).replace('"negativeZero":0', '"negativeZero":-0');
  const expected = JSON.parse(text);
  const decoded = await decodeReadWeaveStateContentAsync(text) as any;
  expect(decoded).toEqual(expected);
  expect(Object.is(decoded.negativeZero, -0)).toBe(true);
  expect(Object.hasOwn(decoded, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  const compressed = encodeReadWeaveStateContent(expected);
  expect(Buffer.byteLength(compressed)).toBeGreaterThan(1_000_000);
  await expect(decodeReadWeaveStateContentAsync(compressed)).resolves.toEqual(JSON.parse(JSON.stringify(expected)));
});

it("preserves the legacy replacement-string checksum for malformed UTF-8 content", async () => {
  const raw = Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  const oldPlain = raw.toString("utf8");
  const encoded = `COURSE_OS_BR_STATE_V1:${createHash("sha256").update(oldPlain).digest("hex")}:${brotliCompressSync(raw).toString("base64")}`;
  await expect(decodeReadWeaveStateContentAsync(encoded)).resolves.toEqual(JSON.parse(oldPlain));
});
