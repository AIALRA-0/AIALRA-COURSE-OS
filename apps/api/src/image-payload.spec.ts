import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { buildModelImageDataUrl } from "./image-payload.js";

describe("model image payload", () => {
  it("keeps the encoded teaching image below the router request budget", async () => {
    const source = await sharp({ create: { width: 1400, height: 1000, channels: 3, background: "#f7f5ef" } }).png().toBuffer();
    const dataUrl = await buildModelImageDataUrl(source);
    const encoded = dataUrl.split(",", 2)[1]!;
    const bytes = Buffer.from(encoded, "base64");
    expect(dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(bytes.length).toBeLessThanOrEqual(48 * 1024);
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });
});
