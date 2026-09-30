import { randomBytes } from "node:crypto";
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
