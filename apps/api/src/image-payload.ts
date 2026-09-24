import sharp from "sharp";

const MAX_MODEL_IMAGE_BYTES = 160 * 1024;

export async function buildModelImageDataUrl(source: Buffer): Promise<string> {
  if (source.length > 32 * 1024 * 1024) throw new Error("SOURCE_PAGE_IMAGE_TOO_LARGE");
  const attempts = [
    { width: 1200, quality: 84 },
    { width: 1080, quality: 78 },
    { width: 960, quality: 72 },
    { width: 840, quality: 66 },
    { width: 720, quality: 60 },
    { width: 640, quality: 52 },
    { width: 512, quality: 44 },
    { width: 384, quality: 36 },
    { width: 320, quality: 28 }
  ];
  let smallest: Buffer | undefined;
  for (const attempt of attempts) {
    const candidate = await sharp(source)
      .flatten({ background: "#ffffff" })
      .resize({ width: attempt.width, withoutEnlargement: true, fit: "inside" })
      .jpeg({ quality: attempt.quality, progressive: true, mozjpeg: true })
      .toBuffer();
    if (!smallest || candidate.length < smallest.length) smallest = candidate;
    if (candidate.length <= MAX_MODEL_IMAGE_BYTES) return `data:image/jpeg;base64,${candidate.toString("base64")}`;
  }
  if (!smallest || smallest.length > MAX_MODEL_IMAGE_BYTES) throw new Error("MODEL_IMAGE_PAYLOAD_TOO_LARGE");
  return `data:image/jpeg;base64,${smallest.toString("base64")}`;
}
