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
