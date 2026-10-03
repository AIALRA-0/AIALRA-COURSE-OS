import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { decodeReadWeaveStateContent, encodeReadWeaveStateContent, encodeReadWeaveStateContentAsync } from "./etapi.js";

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
