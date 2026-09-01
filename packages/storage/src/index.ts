import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface CasObject {
  sha256: string;
  sizeBytes: number;
  absolutePath: string;
  deduplicated: boolean;
}

export class ContentAddressedStore {
  constructor(private readonly root: string) {}

  async put(buffer: Buffer): Promise<CasObject> {
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const absolutePath = this.pathFor(sha256);
    await mkdir(dirname(absolutePath), { recursive: true });
    try {
      const existing = await stat(absolutePath);
      return { sha256, sizeBytes: existing.size, absolutePath, deduplicated: true };
    } catch {
      const temporaryPath = `${absolutePath}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, buffer, { flag: "wx" });
      try {
        await rename(temporaryPath, absolutePath);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        try {
          const existing = await stat(absolutePath);
          return { sha256, sizeBytes: existing.size, absolutePath, deduplicated: true };
        } catch {
          throw error;
        }
      }
      return { sha256, sizeBytes: buffer.length, absolutePath, deduplicated: false };
    }
  }

  async get(sha256: string): Promise<Buffer> {
    assertSha256(sha256);
    return readFile(this.pathFor(sha256));
  }

  pathFor(sha256: string): string {
    assertSha256(sha256);
    return join(this.root, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(temporaryPath, path);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!["EACCES", "EBUSY", "EPERM"].includes(code || "") || attempt === 5) break;
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
  await unlink(temporaryPath).catch(() => undefined);
  throw lastError;
}

function assertSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("CAS_HASH_INVALID");
}

export interface FileInspection {
  accepted: boolean;
  kind?: "pdf" | "pptx" | "syllabus";
  detectedMediaType?: string;
  issues: string[];
}

const MAX_FILE_BYTES = 100 * 1024 * 1024;

export function inspectUpload(name: string, declaredMediaType: string, buffer: Buffer): FileInspection {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  const issues: string[] = [];
  if (buffer.length === 0) issues.push("FILE_EMPTY");
  if (buffer.length > MAX_FILE_BYTES) issues.push("FILE_TOO_LARGE");

  const isPdf = buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  const isZip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && [0x03, 0x05, 0x07].includes(buffer[2] ?? -1);
  const isText = !buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
  let kind: FileInspection["kind"];
  let detectedMediaType: string | undefined;

  if (extension === "pdf" && isPdf) {
    kind = "pdf";
    detectedMediaType = "application/pdf";
  } else if (extension === "pptx" && isZip) {
    kind = "pptx";
    detectedMediaType = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  } else if (["md", "txt"].includes(extension) && isText) {
    kind = "syllabus";
    detectedMediaType = extension === "md" ? "text/markdown" : "text/plain";
  } else {
    issues.push("FILE_EXTENSION_MAGIC_MISMATCH");
  }

  if (detectedMediaType && declaredMediaType && declaredMediaType !== "application/octet-stream" && declaredMediaType !== detectedMediaType) {
    issues.push("FILE_MIME_MISMATCH");
  }

  if (kind === "pptx") {
    const cloudMetadataAddress = `http://${[169, 254, 169, 254].join(".")}`;
    const suspiciousMarkers = ["<!ENTITY", "file://", cloudMetadataAddress, "../"];
    const latin = buffer.toString("latin1");
    if (suspiciousMarkers.some((marker) => latin.includes(marker))) issues.push("FILE_UNSAFE_MARKER");
  }

  return { accepted: issues.length === 0, kind, detectedMediaType, issues };
}
