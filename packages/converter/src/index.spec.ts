import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { convertMaterial, FileConversionQueueClient, FileConversionQueueWorker, type FileConversionQueueOptions, type ProcessRunner } from "./index.js";
import type { ConversionRequest } from "@course-os/contracts";

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
      if (command === "python" && kind === "pptx") return { stdout: JSON.stringify({ accepted: true, slideTitles: ["A complete title that wraps", "Second title"] }), stderr: "" };
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

  it.each([
    ["pdf", "render"], ["pdf", "text"], ["pptx", "render"], ["pptx", "text"]
  ] as const)("overlaps extraction and rendering for %s when %s finishes first", async (kind, first) => {
    const root = await mkdtemp(join(tmpdir(), "course-os-converter-overlap-"));
    const sourcePath = join(root, `lecture.${kind}`);
    const renderGate = deferred();
    const textGate = deferred();
    const bothStarted = deferred();
    const textWritten = deferred();
    const active = new Set<string>();
    const events: string[] = [];
    const snapshots: Array<{ stage: string; pageCount?: number; completedPages: number }> = [];
    let observerActive = false;
    let observerOverlap = false;
    let settled = false;
    await writeFile(sourcePath, kind === "pdf" ? "%PDF-1.7" : "PK synthetic pptx");
    const runProcess: ProcessRunner = async (command, args, options) => {
      if (command === "python") return { stdout: JSON.stringify({ accepted: true, slideTitles: Array.from({ length: 10 }, (_, i) => i === 0 ? "Slide title" : `Slide ${i + 1}`) }), stderr: "" };
      if (command === "soffice") await writeFile(join(options.cwd, "source.pdf"), "%PDF-1.7");
      if (command === "pdfinfo") {
        events.push("counted");
        return { stdout: "Pages: 10\n", stderr: "" };
      }
      if (command === "pdftoppm" || command === "pdftotext") {
        const branch = command === "pdftoppm" ? "render" : "text";
        active.add(branch);
        events.push(`${branch}:start`);
        if (active.size === 2) bothStarted.resolve();
        try {
          if (branch === "render") {
            // This filename exists while its bytes are incomplete.
            await writeFile(join(options.cwd, "page-1.png"), testPng().subarray(0, 4));
            await renderGate.promise;
            for (let page = 10; page >= 1; page -= 1) await writeFile(join(options.cwd, `page-${page}.png`), testPng());
          } else {
            await textGate.promise;
            await writeFile(args.at(-1)!, Array.from({ length: 10 }, (_, index) => `Title ${index + 1}\r\nBody  \r\n`).join("\f"));
            textWritten.resolve();
          }
        } finally {
          active.delete(branch);
          events.push(`${branch}:end`);
        }
      }
      return { stdout: "", stderr: "" };
    };
    const converting = convertMaterial({ id: "overlap", sourcePath, originalName: `lecture.${kind}`, kind, outputDir: join(root, "out"), createdAt: new Date().toISOString() }, {
      runProcess, binaries: testBinaries(),
      onProgress: async (snapshot) => {
        if (observerActive) observerOverlap = true;
        observerActive = true;
        snapshots.push(snapshot);
        await new Promise<void>((resolve) => setImmediate(resolve));
        observerActive = false;
      }
    });
    void converting.then(() => { settled = true; }, () => { settled = true; });
    try {
      await bothStarted.promise;
      expect(events.slice(0, 3)).toEqual(["counted", "render:start", "text:start"]);
      expect(active.size).toBe(2);
      expect(snapshots.at(-1)).toMatchObject({ stage: "rendering_pages", pageCount: 10, completedPages: 0 });
      if (first === "render") {
        renderGate.resolve();
        await vi.waitFor(() => expect(snapshots.at(-1)).toMatchObject({ stage: "extracting_text", completedPages: 0 }));
        expect(active).toEqual(new Set(["text"]));
      } else {
        textGate.resolve();
        await textWritten.promise;
        expect(snapshots.at(-1)).toMatchObject({ stage: "rendering_pages", completedPages: 0 });
        expect(active).toEqual(new Set(["render"]));
      }
      expect(settled).toBe(false);
      expect(snapshots.every((snapshot) => snapshot.completedPages === 0)).toBe(true);
      renderGate.resolve();
      textGate.resolve();
      const result = await converting;
      expect(result.pages.map((page) => [page.pageNumber, page.text])).toEqual(
        Array.from({ length: 10 }, (_, index) => [index + 1, `Title ${index + 1}\nBody`])
      );
      expect(result.pages[0]!.title).toBe(kind === "pptx" ? "Slide title" : "Title 1");
      expect(events.indexOf(`${first}:end`)).toBeLessThan(events.indexOf(`${first === "render" ? "text" : "render"}:end`));
      expect(active.size).toBe(0);
      expect(observerOverlap).toBe(false);
      expect(snapshots.at(-2)).toMatchObject({ stage: "finalizing", pageCount: 10, completedPages: 10 });
      expect(snapshots.at(-1)).toMatchObject({ stage: "completed", pageCount: 10, completedPages: 10 });
      const stages = snapshots.map((snapshot) => snapshot.stage);
      if (stages.includes("extracting_text")) expect(stages.lastIndexOf("rendering_pages")).toBeLessThan(stages.indexOf("extracting_text"));
    } finally {
      renderGate.resolve();
      textGate.resolve();
      await converting.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["render", false], ["text", false], ["render", true], ["text", true]
  ] as const)("waits for the other process before releasing a failed queue job (%s fails first, other fails: %s)", async (first, otherFails) => {
    const root = await mkdtemp(join(tmpdir(), "course-os-converter-overlap-failure-"));
    const queueRoot = join(root, "queue");
    const sourcePath = join(root, "lecture.pdf");
    const request = { id: "overlap-failure", sourcePath, originalName: "lecture.pdf", kind: "pdf" as const, outputDir: join(root, "out"), createdAt: new Date().toISOString() };
    await writeFile(sourcePath, "%PDF-1.7");
    await mkdir(join(queueRoot, "pending"), { recursive: true });
    await writeFile(join(queueRoot, "pending", `${request.id}.json`), JSON.stringify(request));
    const firstGate = deferred();
    const otherGate = deferred();
    const bothStarted = deferred();
    const failureRaised = deferred();
    const active = new Set<string>();
    const snapshots: Array<{ stage: string; completedPages: number }> = [];
    const runProcess: ProcessRunner = async (command, args, options) => {
      if (command === "pdfinfo") return { stdout: "Pages: 1\n", stderr: "" };
      const branch = command === "pdftoppm" ? "render" : "text";
      active.add(branch);
      if (active.size === 2) bothStarted.resolve();
      try {
        await (branch === first ? firstGate : otherGate).promise;
        if (branch === first || otherFails) throw new Error(`CONVERSION_${branch.toUpperCase()}_TEST_FAILURE`);
        if (branch === "render") await writeFile(join(options.cwd, "page-1.png"), testPng());
        else await writeFile(args.at(-1)!, "Title\f");
        return { stdout: "", stderr: "" };
      } finally {
        active.delete(branch);
        if (branch === first) failureRaised.resolve();
      }
    };
    const worker = new FileConversionQueueWorker({ queueRoot, runProcess, binaries: testBinaries(), onProgress: (snapshot) => { snapshots.push(snapshot); } });
    let settled = false;
    const working = worker.runOnce();
    void working.then(() => { settled = true; }, () => { settled = true; });
    try {
      await bothStarted.promise;
      firstGate.resolve();
      await failureRaised.promise;
      // Allow rejection handlers to run while the sibling still owns its files.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(active.size).toBe(1);
      expect(await readdir(join(queueRoot, "processing"))).toEqual([`${request.id}.json`]);
      expect(await readdir(join(queueRoot, "results"))).toEqual([]);
      expect(snapshots.some((snapshot) => snapshot.stage === "failed" || snapshot.completedPages > 0)).toBe(false);
      otherGate.resolve();
      expect(await working).toBe(true);
      expect(active.size).toBe(0);
      expect(await readdir(join(queueRoot, "processing"))).toEqual([]);
      const issue = `CONVERSION_${otherFails ? "RENDER" : first.toUpperCase()}_TEST_FAILURE`;
      const result = JSON.parse(await readFile(join(queueRoot, "results", `${request.id}.json`), "utf8"));
      expect(result).toMatchObject({ state: "failed", pages: [], issues: [issue] });
      expect(snapshots.at(-1)).toMatchObject({ stage: "failed", pageCount: 1, completedPages: 0, issue });
      expect(snapshots.some((snapshot) => snapshot.stage === "completed" || snapshot.stage === "finalizing")).toBe(false);
    } finally {
      firstGate.resolve();
      otherGate.resolve();
      await working.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["page count", "CONVERSION_PAGE_COUNT_INVALID"],
    ["missing image", "CONVERSION_RENDER_PAGE_MISMATCH"],
    ["duplicate number", "CONVERSION_RENDER_PAGE_MISMATCH"],
    ["text limit", "CONVERSION_EXTRACTED_TEXT_TOO_LARGE"]
  ])("retains the %s guard with parallel processes", async (scenario, issue) => {
    const root = await mkdtemp(join(tmpdir(), "course-os-converter-overlap-guard-"));
    const sourcePath = join(root, "lecture.pdf");
    await writeFile(sourcePath, "%PDF-1.7");
    const commands: string[] = [];
    const snapshots: Array<{ stage: string; completedPages: number }> = [];
    const runProcess: ProcessRunner = async (command, args, options) => {
      commands.push(command);
      if (command === "pdfinfo") return { stdout: `Pages: ${scenario === "page count" ? 501 : 2}\n`, stderr: "" };
      if (command === "pdftoppm") {
        await writeFile(join(options.cwd, "page-1.png"), testPng());
        if (scenario !== "missing image") await writeFile(join(options.cwd, scenario === "duplicate number" ? "page-01.png" : "page-2.png"), testPng());
      }
      if (command === "pdftotext") await writeFile(args.at(-1)!, scenario === "text limit" ? Buffer.alloc(20 * 1024 * 1024 + 1, 65) : "Title 1\fTitle 2\f");
      return { stdout: "", stderr: "" };
    };
    try {
      await expect(convertMaterial({ id: "parallel-guard", sourcePath, originalName: "lecture.pdf", kind: "pdf", outputDir: join(root, "out"), createdAt: new Date().toISOString() }, {
        runProcess, binaries: testBinaries(), onProgress: (snapshot) => { snapshots.push(snapshot); }
      })).rejects.toThrow(issue);
      expect(snapshots.at(-1)).toMatchObject({ stage: "failed", completedPages: 0, issue });
      if (scenario === "page count") expect(commands).toEqual(["pdfinfo"]);
      else expect(commands).toEqual(["pdfinfo", "pdftoppm", "pdftotext"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

describe("preview queue lanes", () => {
  function worker(options: FileConversionQueueOptions, purpose?: "inspect" | "convert") {
    const scopedOptions = { ...options, purpose };
    return new FileConversionQueueWorker(scopedOptions);
  }

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "course-os-preview-lanes-"));
    const queueRoot = join(root, "queue");
    const sourcePath = join(root, "source.pdf");
    await writeFile(sourcePath, "%PDF-1.7 synthetic queue fixture");
    const request = (id: string, purpose?: "inspect"): ConversionRequest => ({
      id, purpose, kind: "pdf", sourcePath, originalName: "source.pdf",
      outputDir: join(root, id), createdAt: new Date().toISOString()
    });
    const enqueue = async (item: ConversionRequest, directory = "pending") => {
      await mkdir(join(queueRoot, directory), { recursive: true });
      await writeFile(join(queueRoot, directory, `${item.id}.json`), JSON.stringify(item));
    };
    return { root, queueRoot, request, enqueue };
  }

  function runner(gate?: { promise: Promise<void>; resolve: () => void }, started?: { resolve: () => void }): ProcessRunner {
    return async (command, args, options) => {
      if (command === "python") return { stdout: JSON.stringify({ pages: [], inspection: {
        sourceSha256: "a".repeat(64), physicalPageCount: 10, logicalPageCount: 10
      } }), stderr: "" };
      if (command === "pdfinfo") return { stdout: "Pages: 42", stderr: "" };
      if (command === "pdftoppm") {
        started?.resolve();
        await gate?.promise;
        for (let page = 1; page <= 42; page++) await writeFile(join(options.cwd, `page-${page}.png`), testPng());
      }
      if (command === "pdftotext") await writeFile(args.at(-1)!, "Page\f".repeat(42));
      return { stdout: "", stderr: "" };
    };
  }

  it("finishes inspection while a real queue conversion is held at the render barrier", async () => {
    const f = await fixture();
    const gate = deferred();
    const started = deferred();
    const convert = worker({ queueRoot: f.queueRoot, runProcess: runner(gate, started), binaries: testBinaries() }, "convert");
    const inspect = worker({ queueRoot: f.queueRoot, runProcess: runner(), binaries: testBinaries() }, "inspect");
    await f.enqueue(f.request("a-active"));
    const converting = convert.runOnce();
    let converted = false;
    void converting.then(() => { converted = true; }, () => undefined);
    try {
      await started.promise;
      await f.enqueue(f.request("b-next-conversion"));
      await f.enqueue(f.request("z-inspection", "inspect"));
      expect(await inspect.runOnce()).toBe(true);
      expect(await readdir(join(f.queueRoot, "results"))).toEqual(["z-inspection.json"]);
      expect(JSON.parse(await readFile(join(f.queueRoot, "results", "z-inspection.json"), "utf8")))
        .toMatchObject({ state: "completed", pages: [], inspection: { logicalPageCount: 10 } });
      expect(converted).toBe(false);
      expect(await readdir(join(f.queueRoot, "processing"))).toEqual(["a-active.json"]);
      expect(await readdir(join(f.queueRoot, "pending"))).toEqual(["b-next-conversion.json"]);
    } finally {
      gate.resolve();
      await converting;
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it.each(["inspect", "convert"] as const)("does not claim or recover foreign processing/results in the %s lane", async (purpose) => {
    const f = await fixture();
    const foreignPurpose = purpose === "inspect" ? undefined : "inspect";
    const ownPurpose = purpose === "inspect" ? "inspect" : undefined;
    try {
      await f.enqueue(f.request("a-foreign-pending", foreignPurpose));
      await f.enqueue(f.request("b-foreign-stale", foreignPurpose), "processing");
      await f.enqueue(f.request("c-foreign-durable", foreignPurpose), "processing");
      const old = new Date(Date.now() - 60_000);
      for (const id of ["b-foreign-stale", "c-foreign-durable"]) await utimes(join(f.queueRoot, "processing", `${id}.json`), old, old);
      await mkdir(join(f.queueRoot, "results"), { recursive: true });
      await writeFile(join(f.queueRoot, "results", "c-foreign-durable.json"), JSON.stringify({ requestId: "c-foreign-durable", state: "completed", pages: [] }));
      const lane = worker({ queueRoot: f.queueRoot, processingRecoveryMs: 0, runProcess: runner(), binaries: testBinaries() }, purpose);
      expect(await lane.runOnce()).toBe(false);
      expect(await readdir(join(f.queueRoot, "pending"))).toEqual(["a-foreign-pending.json"]);
      expect(await readdir(join(f.queueRoot, "processing"))).toEqual(["b-foreign-stale.json", "c-foreign-durable.json"]);
      await f.enqueue(f.request("z-own-stale", ownPurpose), "processing");
      await utimes(join(f.queueRoot, "processing", "z-own-stale.json"), old, old);
      expect(await lane.runOnce()).toBe(true);
      expect(await readdir(join(f.queueRoot, "processing"))).toEqual(["b-foreign-stale.json", "c-foreign-durable.json"]);
      expect(await readdir(join(f.queueRoot, "results"))).toEqual(["c-foreign-durable.json", "z-own-stale.json"]);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("keeps inspection requests working in the undefined legacy purpose mode", async () => {
    const f = await fixture();
    try {
      await f.enqueue(f.request("legacy-inspection", "inspect"));
      expect(await worker({ queueRoot: f.queueRoot, runProcess: runner(), binaries: testBinaries() }).runOnce()).toBe(true);
      expect(JSON.parse(await readFile(join(f.queueRoot, "results", "legacy-inspection.json"), "utf8")))
        .toMatchObject({ requestId: "legacy-inspection", state: "completed", pages: [] });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("refreshes processing mtime at claim rather than treating time queued as processing age", async () => {
    const f = await fixture();
    const gate = deferred();
    const started = deferred();
    await f.enqueue(f.request("old-pending"));
    const old = new Date(Date.now() - 60_000);
    await utimes(join(f.queueRoot, "pending", "old-pending.json"), old, old);
    const beforeClaim = Date.now();
    const options = { queueRoot: f.queueRoot, processingRecoveryMs: 30_000, runProcess: runner(gate, started), binaries: testBinaries() };
    const converting = worker(options, "convert").runOnce();
    try {
      await started.promise;
      const claimed = await stat(join(f.queueRoot, "processing", "old-pending.json"));
      expect(claimed.mtimeMs).toBeGreaterThanOrEqual(beforeClaim - 5);
      expect(await worker(options, "convert").runOnce()).toBe(false);
      expect(await readdir(join(f.queueRoot, "processing"))).toEqual(["old-pending.json"]);
    } finally {
      gate.resolve();
      await converting;
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("uses atomic claims once and preserves a durable result when a pending duplicate remains", async () => {
    const f = await fixture();
    const calls = vi.fn(runner());
    const options = { queueRoot: f.queueRoot, runProcess: calls, binaries: testBinaries() };
    try {
      await f.enqueue(f.request("once", "inspect"));
      const inspect = worker(options, "inspect");
      const convert = worker(options, "convert");
      const claims = await Promise.all([inspect.runOnce(), inspect.runOnce(), convert.runOnce()]);
      expect(claims.sort()).toEqual([false, false, true]);
      expect(calls).toHaveBeenCalledTimes(1);
      const resultPath = join(f.queueRoot, "results", "once.json");
      const durable = await readFile(resultPath, "utf8");
      await writeFile(join(f.root, "once", "sentinel"), "keep output");
      await f.enqueue(f.request("once", "inspect"));
      expect(await worker(options, "inspect").runOnce()).toBe(true);
      expect(await readFile(resultPath, "utf8")).toBe(durable);
      expect(await readFile(join(f.root, "once", "sentinel"), "utf8")).toBe("keep output");
      expect(calls).toHaveBeenCalledTimes(1);
      const client = new FileConversionQueueClient({ queueRoot: f.queueRoot });
      expect(await client.enqueueAndWait(f.request("once", "inspect"))).toEqual(JSON.parse(durable));
      expect(await readdir(join(f.queueRoot, "pending"))).toEqual([]);
      expect(await readdir(join(f.queueRoot, "processing"))).toEqual([]);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("stops claims on shutdown while finishing the active job and its durable result", async () => {
    const f = await fixture();
    const gate = deferred();
    const started = deferred();
    const controller = new AbortController();
    await f.enqueue(f.request("a-active"));
    await f.enqueue(f.request("b-queued"));
    const lane = worker({ queueRoot: f.queueRoot, runProcess: runner(gate, started), binaries: testBinaries(), pollIntervalMs: 1 }, "convert");
    const serving = lane.serve(controller.signal);
    let stopped = false;
    void serving.then(() => { stopped = true; }, () => undefined);
    try {
      await started.promise;
      controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);
      gate.resolve();
      await serving;
      expect(await readdir(join(f.queueRoot, "results"))).toEqual(["a-active.json"]);
      expect(await readdir(join(f.queueRoot, "pending"))).toEqual(["b-queued.json"]);
      expect(await readdir(join(f.queueRoot, "processing"))).toEqual([]);
      // Already-aborted shutdown must also prevent a direct claim during a scan.
      expect(await lane.runOnce(controller.signal)).toBe(false);
    } finally {
      controller.abort();
      gate.resolve();
      await serving;
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe("preview queue lanes service shutdown", () => {
  it.each(["SIGTERM", "SIGINT", "sibling error"] as const)("drains both service workers after %s", async (stop) => {
    vi.resetModules();
    const gates = [deferred(), deferred()];
    const registered = deferred();
    const signals: Array<AbortSignal | undefined> = [];
    const purposes: Array<unknown> = [];
    const handlers = new Map<string, () => void>();
    const once = process.once.bind(process);
    const listener = vi.spyOn(process, "once").mockImplementation(((event: string, handler: () => void) => {
      if (event === "SIGTERM" || event === "SIGINT") { handlers.set(event, handler); return process; }
      return once(event, handler);
    }) as typeof process.once);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.doMock("@course-os/converter", () => ({ FileConversionQueueWorker: class {
      constructor(options: FileConversionQueueOptions & { purpose?: string }) { purposes.push(options.purpose); }
      async serve(signal?: AbortSignal) {
        const index = signals.length;
        signals.push(signal);
        if (signals.length === 2) registered.resolve();
        await gates[index]!.promise;
        if (stop === "sibling error" && index === 0) throw new Error("QUEUE_LANE_FAILURE");
      }
    } }));
    const entry = "../../../apps/converter/src/index.ts";
    const boot = import(entry);
    // Attach rejection handling immediately, including a failure before both workers start.
    let settled = false;
    const outcome = boot.then(() => { settled = true; return undefined; }, (error: unknown) => { settled = true; return error; });
    try {
      await Promise.race([registered.promise, new Promise<void>((resolve) => setTimeout(resolve, 100))]);
      expect(purposes).toEqual(["inspect", "convert"]);
      if (stop === "sibling error") gates[0]!.resolve();
      else handlers.get(stop)!();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(signals.every((signal) => signal?.aborted)).toBe(true);
      expect(settled).toBe(false);
      if (stop !== "sibling error") gates[0]!.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      gates[1]!.resolve();
      const result = await outcome;
      if (stop === "sibling error") expect(result).toMatchObject({ message: "QUEUE_LANE_FAILURE" });
      else expect(result).toBeUndefined();
    } finally {
      for (const handler of handlers.values()) handler();
      gates.forEach((gate) => gate.resolve());
      await outcome;
      listener.mockRestore();
      stdout.mockRestore();
      vi.doUnmock("@course-os/converter");
      vi.resetModules();
    }
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe("PPTX slide coverage", () => {
  it("rejects an export that silently skips source slides before any generation-ready pages", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-hidden-slide-"));
    const sourcePath = join(root, "hidden.pptx");
    await writeFile(sourcePath, "PK synthetic pptx");
    let exportHidden = false;
    let rendered = false;
    const runProcess: ProcessRunner = async (command, args, options) => {
      if (command === "python") return { stdout: JSON.stringify({ accepted: true, slideTitles: ["Visible", "Hidden", "Visible after hidden"] }), stderr: "" };
      if (command === "soffice") {
        const filter = args[args.indexOf("--convert-to") + 1]!;
        exportHidden = JSON.parse(filter.slice(filter.indexOf("{")).trim()).ExportHiddenSlides.value === "true";
        await writeFile(join(options.cwd, "source.pdf"), "%PDF-1.7");
      }
      if (command === "pdfinfo") return { stdout: "Pages: 2", stderr: "" };
      if (command === "pdftoppm") rendered = true;
      return { stdout: "", stderr: "" };
    };
    try {
      await expect(convertMaterial({ id: "hidden", sourcePath, originalName: "hidden.pptx", kind: "pptx", outputDir: join(root, "out"), createdAt: new Date().toISOString() },
        { runProcess, binaries: testBinaries() })).rejects.toThrow("CONVERSION_PPTX_SLIDE_COUNT_MISMATCH");
      expect(exportHidden).toBe(true);
      expect(rendered).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});


describe("PPTX inspection failure closure", () => {
  it.each(["not-json", "{}", '{"accepted":false,"slideTitles":[]}', '{"accepted":"true"}'])
    ("stops before LibreOffice when the inspector does not explicitly approve: %s", async (stdout) => {
      const root = await mkdtemp(join(tmpdir(), "course-os-pptx-inspection-"));
      const sourcePath = join(root, "lecture.pptx");
      await writeFile(sourcePath, "PK fixture");
      const calls: string[] = [];
      const runProcess: ProcessRunner = async (command) => { calls.push(command); return { stdout, stderr: "" }; };
      await expect(convertMaterial({ id: "inspection", kind: "pptx", originalName: "lecture.pptx", sourcePath,
        outputDir: join(root, "out"), createdAt: new Date().toISOString() }, { runProcess, binaries: testBinaries() }))
        .rejects.toThrow(/CONVERSION_PPTX_INSPECTION_/);
      expect(calls).toEqual([testBinaries().python]);
    });
});
