import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { buildModelImageDataUrl } from "./image-payload.js";

describe("model image payload", () => {
  it("preserves near-source dimensions for dense slide content within the payload budget", async () => {
    const width = 1210;
    const height = 935;
    const rows = Array.from({ length: 48 }, (_, index) => {
      const y = 26 + index * 18;
      return `<text x="24" y="${y}" font-family="Arial" font-size="14" fill="#172033">e-h ${index + 1}: ${((index + 1) / 100).toFixed(2)} &amp; h-j ${(1 + (index + 1) / 30).toFixed(2)}</text>`;
    }).join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#f7f5ef"/><path d="M12 8H1198M12 18H1198" stroke="#52627a"/>${rows}</svg>`;
    const source = await sharp(Buffer.from(svg)).png().toBuffer();
    const dataUrl = await buildModelImageDataUrl(source);
    const encoded = dataUrl.split(",", 2)[1]!;
    const bytes = Buffer.from(encoded, "base64");
    const metadata = await sharp(bytes).metadata();
    expect(dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(bytes.length).toBeLessThanOrEqual(160 * 1024);
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(metadata.width).toBeGreaterThanOrEqual(1000);
    expect(metadata.width).toBeLessThanOrEqual(width);
  });

  it("falls back to a smaller valid image when dense source detail exceeds the budget", async () => {
    const width = 1800;
    const height = 1400;
    const pixels = Buffer.alloc(width * height * 3);
    let seed = 0x12345678;
    for (let index = 0; index < pixels.length; index += 1) {
      seed = (1664525 * seed + 1013904223) >>> 0;
      pixels[index] = seed >>> 24;
    }
    const source = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
    const dataUrl = await buildModelImageDataUrl(source);
    const encoded = dataUrl.split(",", 2)[1]!;
    const bytes = Buffer.from(encoded, "base64");
    const metadata = await sharp(bytes).metadata();

    expect(dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(bytes.length).toBeLessThanOrEqual(160 * 1024);
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(metadata.width).toBeGreaterThan(0);
    expect(metadata.width).toBeLessThan(1200);
  });
});
