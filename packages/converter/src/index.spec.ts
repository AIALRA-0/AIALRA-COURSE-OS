import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { convertMaterial, FileConversionQueueWorker, type ProcessRunner } from "./index.js";

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
      if (command === "soffice") await writeFile(join(options.cwd, "source.pdf"), "%PDF-1.7", "utf8");
      if (command === "pdfinfo") return { stdout: "Pages:          2\n", stderr: "" };
      if (command === "pdftoppm") {
        await writeFile(join(options.cwd, "page-1.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        await writeFile(join(options.cwd, "page-2.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      }
      if (command === "pdftotext") await writeFile(args.at(-1)!, "First page\fSecond page\f", "utf8");
      return { stdout: "", stderr: "" };
    };
    const result = await convertMaterial(
      { id: `${kind}-1`, sourcePath, originalName: `lecture.${kind}`, kind, outputDir: join(root, "out"), createdAt: new Date().toISOString() },
      { runProcess, binaries: { pdfinfo: "pdfinfo", pdftoppm: "pdftoppm", pdftotext: "pdftotext", soffice: "soffice", python: "python", pptxInspector: "inspect.py" } }
    );
    expect(result.pages.map((page) => [page.pageNumber, page.title])).toEqual([[1, "First page"], [2, "Second page"]]);
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
