import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContentAddressedStore, inspectUpload } from "./index.js";

describe("content addressed storage", () => {
  it("deduplicates identical bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-cas-"));
    const store = new ContentAddressedStore(root);
    const first = await store.put(Buffer.from("same"));
    const second = await store.put(Buffer.from("same"));
    expect(first.sha256).toBe(second.sha256);
    expect(second.deduplicated).toBe(true);
  });
});

describe("upload inspection", () => {
  it("accepts a PDF only when extension and magic bytes agree", () => {
    expect(inspectUpload("lecture.pdf", "application/pdf", Buffer.from("%PDF-1.7\n"))).toMatchObject({ accepted: true, kind: "pdf" });
    expect(inspectUpload("lecture.pdf", "application/pdf", Buffer.from("not-pdf"))).toMatchObject({ accepted: false });
  });
});


describe("PPTX coarse upload inspection", () => {
  it("does not mistake binary data for paths or XML declarations", () => {
    const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("image bytes ../ file:// <!ENTITY http://169.254.169.254")]);
    expect(inspectUpload("lecture.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", bytes))
      .toMatchObject({ accepted: true, kind: "pptx", issues: [] });
    expect(inspectUpload("lecture.pdf", "application/pdf", bytes).accepted).toBe(false);
    expect(inspectUpload("lecture.pptx", "application/pdf", bytes).issues).toContain("FILE_MIME_MISMATCH");
  });
});
