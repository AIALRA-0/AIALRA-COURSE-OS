import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { convertMaterial, FileConversionQueueClient, FileConversionQueueWorker, type ProcessRunner } from "./index.js";

describe("offline material converter", () => {
  it("paginates a text syllabus and renders local SVG pages", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-converter-text-"));
    const sourcePath = join(root, "syllabus.md");
    await writeFile(sourcePath, ["# Linear Algebra", ...Array.from({ length: 80 }, (_, index) => `Topic ${index + 1}: vectors and matrices`)].join("\n"), "utf8");
    const result = await convertMaterial({ id: "text-1", sourcePath, originalName: "syllabus.md", kind: "syllabus", outputDir: join(root, "out"), createdAt: new Date().toISOString() });
    expect(result.state).toBe("completed");
    expect(result.pages.length).toBeGreaterThan(1);
    expect(result.pages[0]).toMatchObject({ pageNumber: 1, title: "Linear Algebra", imageMediaType: "image/svg+xml" });
    expect(await readFile(result.pages[0]!.imagePath, "utf8")).toContain("<svg");
  });

  it.each(["pdf", "pptx"] as const)("creates ordered PNG pages for %s", async (kind) => {
    const root = await mkdtemp(join(tmpdir(), `course-os-converter-${kind}-`));
    const sourcePath = join(root, `lecture.${kind}`);
    await writeFile(sourcePath, kind === "pdf" ? "%PDF-1.7" : "PK synthetic pptx", "utf8");
    const runProcess: ProcessRunner = async (command, args, options) => {
      if (command === "python" && kind === "pptx") return { stdout: JSON.stringify({ slideTitles: ["A complete title that wraps", "Second title"] }), stderr: "" };
      if (command === "soffice") await writeFile(join(options.cwd, "source.pdf"), "%PDF-1.7", "utf8");
      if (command === "pdfinfo") return { stdout: "Pages:          2\n", stderr: "" };
      if (command === "pdftoppm") {
        await writeFile(join(options.cwd, "page-1.png"), testPng());
        await writeFile(join(options.cwd, "page-2.png"), testPng());
      }
      if (command === "pdftotext") await writeFile(args.at(-1)!, "First page\fSecond page\f", "utf8");
      return { stdout: "", stderr: "" };
    };
    const result = await convertMaterial(
      { id: `${kind}-1`, sourcePath, originalName: `lecture.${kind}`, kind, outputDir: join(root, "out"), createdAt: new Date().toISOString() },
      { runProcess, binaries: { pdfinfo: "pdfinfo", pdftoppm: "pdftoppm", pdftotext: "pdftotext", soffice: "soffice", python: "python", pptxInspector: "inspect.py" } }
    );
    expect(result.pages.map((page) => [page.pageNumber, page.title])).toEqual(kind === "pptx"
      ? [[1, "A complete title that wraps"], [2, "Second title"]]
      : [[1, "First page"], [2, "Second page"]]);
  });

  it("publishes pdfinfo page totals early and excludes images while pdftoppm is still writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-converter-progress-"));
    const sourcePath = join(root, "lecture.pdf");
    await writeFile(sourcePath, "%PDF-1.7", "utf8");
    let finishRendering!: () => void;
    let signalRendering!: () => void;
    const renderingStarted = new Promise<void>((resolve) => { signalRendering = resolve; });
    const renderGate = new Promise<void>((resolve) => { finishRendering = resolve; });
    const snapshots: Array<{ stage: string; pageCount?: number; completedPages: number }> = [];
    const runProcess: ProcessRunner = async (command, args, options) => {
      if (command === "pdfinfo") return { stdout: "Pages:          2\n", stderr: "" };
      if (command === "pdftoppm") {
        await writeFile(join(options.cwd, "page-1.png"), testPng());
        signalRendering();
        await renderGate;
        await writeFile(join(options.cwd, "page-2.png"), testPng());
      }
      if (command === "pdftotext") await writeFile(args.at(-1)!, "First page\fSecond page\f", "utf8");
      return { stdout: "", stderr: "" };
    };
    const converting = convertMaterial({ id: "progress-pdf", sourcePath, originalName: "lecture.pdf", kind: "pdf", outputDir: join(root, "out"), createdAt: new Date().toISOString() }, {
      runProcess,
      binaries: testBinaries(),
      onProgress: (snapshot) => { snapshots.push(snapshot); }
    });

    await renderingStarted;
    expect(snapshots).toContainEqual(expect.objectContaining({ stage: "rendering_pages", pageCount: 2, completedPages: 0 }));
    expect(await readFile(join(root, "out", "page-1.png"))).toHaveLength(testPng().length);
    expect(snapshots.some((snapshot) => snapshot.completedPages > 0)).toBe(false);

    finishRendering();
    const result = await converting;
    expect(result.pages).toHaveLength(2);
    expect(snapshots).toContainEqual(expect.objectContaining({ stage: "finalizing", pageCount: 2, completedPages: 2 }));
    expect(snapshots.at(-1)).toMatchObject({ stage: "completed", pageCount: 2, completedPages: 2 });
  });

  it("does not count a truncated rendered image as a completed artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-converter-invalid-artifact-"));
    const sourcePath = join(root, "lecture.pdf");
    await writeFile(sourcePath, "%PDF-1.7", "utf8");
    const snapshots: Array<{ stage: string; completedPages: number }> = [];
    const runProcess: ProcessRunner = async (command, args, options) => {
      if (command === "pdfinfo") return { stdout: "Pages:          1\n", stderr: "" };
      if (command === "pdftoppm") await writeFile(join(options.cwd, "page-1.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      if (command === "pdftotext") await writeFile(args.at(-1)!, "One page\f", "utf8");
      return { stdout: "", stderr: "" };
    };

    await expect(convertMaterial({ id: "invalid-image", sourcePath, originalName: "lecture.pdf", kind: "pdf", outputDir: join(root, "out"), createdAt: new Date().toISOString() }, {
      runProcess, binaries: testBinaries(), onProgress: (snapshot) => { snapshots.push(snapshot); }
    })).rejects.toThrow("CONVERSION_PAGE_ARTIFACT_INVALID");
    expect(snapshots.at(-1)).toMatchObject({ stage: "failed", pageCount: 1, completedPages: 0, issue: "CONVERSION_PAGE_ARTIFACT_INVALID" });
  });

  it("streams the persisted file-queue snapshot to its waiting client", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-converter-queue-progress-"));
    const queueRoot = join(root, "queue");
    const sourcePath = join(root, "syllabus.md");
    await writeFile(sourcePath, "# Queue progress\nA persisted page", "utf8");
    const request = { id: "queue-progress-1", sourcePath, originalName: "syllabus.md", kind: "syllabus" as const, outputDir: join(root, "out"), createdAt: new Date().toISOString() };
    const worker = new FileConversionQueueWorker({ queueRoot });
    const client = new FileConversionQueueClient({ queueRoot, pollIntervalMs: 1, resultTimeoutMs: 5_000 });
    const snapshots: Array<{ stage: string; pageCount?: number; completedPages: number }> = [];
    let notifyQueued!: () => void;
    const queued = new Promise<void>((resolve) => { notifyQueued = resolve; });
    const waiting = client.enqueueAndWait(request, (snapshot) => {
      snapshots.push(snapshot);
      if (snapshot.stage === "queued") notifyQueued();
    });

    await queued;
    expect(await worker.runOnce()).toBe(true);
    expect((await waiting).state).toBe("completed");
    expect(snapshots).toContainEqual(expect.objectContaining({ stage: "queued", completedPages: 0 }));
    expect(snapshots.at(-1)).toMatchObject({ stage: "completed", pageCount: 1, completedPages: 1 });
    expect(await client.getProgressSnapshot(request.id)).toMatchObject({ stage: "completed", pageCount: 1, completedPages: 1 });
  });

  it("requeues a conversion left in processing after a worker crash", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-converter-recovery-"));
    const queueRoot = join(root, "queue");
    const sourcePath = join(root, "syllabus.md");
    const request = { id: "recovery-1", sourcePath, originalName: "syllabus.md", kind: "syllabus" as const, outputDir: join(root, "out"), createdAt: new Date().toISOString() };
    await writeFile(sourcePath, "# Recovered\n\nA lesson that can continue after restart", "utf8");
    await mkdir(join(queueRoot, "processing"), { recursive: true });
    await writeFile(join(queueRoot, "processing", `${request.id}.json`), JSON.stringify(request), "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(join(queueRoot, "processing", `${request.id}.json`), old, old);
    const worker = new FileConversionQueueWorker({ queueRoot, processingRecoveryMs: 0 });
    expect(await worker.runOnce()).toBe(true);
    const result = JSON.parse(await readFile(join(queueRoot, "results", `${request.id}.json`), "utf8")) as { state: string; pages: unknown[] };
    expect(result).toMatchObject({ state: "completed" });
    expect(result.pages).toHaveLength(1);
  });
});

function testPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", Buffer.from([1])),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function testBinaries() {
  return { pdfinfo: "pdfinfo", pdftoppm: "pdftoppm", pdftotext: "pdftotext", soffice: "soffice", python: "python", pptxInspector: "inspect.py" };
}
