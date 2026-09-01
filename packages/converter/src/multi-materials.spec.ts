import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";
import { convertMaterial, type ProcessRunner } from "./index.js";

type Fixture = {
  id: string;
  originalName: string;
  kind: "pptx" | "pdf" | "syllabus";
  expectedPages: number;
  titlePrefix: string;
};

const fixtures = JSON.parse(await readFile(resolve(process.cwd(), "tests/fixtures/material-catalog.json"), "utf8")) as Fixture[];

describe("multi-material conversion fixtures", () => {
  it.each(fixtures)("converts $id with stable ordered pages", async (fixture) => {
    const root = await mkdtemp(join(tmpdir(), `course-os-material-${fixture.id}-`));
    const sourcePath = join(root, fixture.originalName);
    const outputOne = join(root, "out-one");
    const outputTwo = join(root, "out-two");
    const source = fixture.kind === "syllabus"
      ? Array.from({ length: fixture.expectedPages }, (_, index) => `# Week ${index + 1}\nTopic ${index + 1}: identify the input, process, output, and boundary condition`).join("\f")
      : fixture.kind === "pdf" ? "%PDF-1.7 synthetic fixture" : "PK synthetic pptx fixture";
    await writeFile(sourcePath, source, "utf8");

    const runProcess: ProcessRunner = async (command, args, options) => {
      if (command === "soffice") await writeFile(join(options.cwd, "source.pdf"), "%PDF-1.7", "utf8");
      if (command === "pdfinfo") return { stdout: `Pages:          ${fixture.expectedPages}\n`, stderr: "" };
      if (command === "pdftoppm") {
        await Promise.all(Array.from({ length: fixture.expectedPages }, (_, index) => writeFile(join(options.cwd, `page-${index + 1}.png`), Buffer.from([0x89, 0x50, 0x4e, 0x47]))));
      }
      if (command === "pdftotext") {
        await writeFile(args.at(-1)!, Array.from({ length: fixture.expectedPages }, (_, index) => `${fixture.titlePrefix} page ${index + 1}\f`).join(""), "utf8");
      }
      return { stdout: "", stderr: "" };
    };

    const input = { id: fixture.id, sourcePath, originalName: fixture.originalName, kind: fixture.kind, createdAt: new Date().toISOString() };
    const first = await convertMaterial({ ...input, outputDir: outputOne }, { runProcess, binaries: testBinaries() });
    const second = await convertMaterial({ ...input, outputDir: outputTwo }, { runProcess, binaries: testBinaries() });
    expect(first.state).toBe("completed");
    expect(first.pages).toHaveLength(fixture.expectedPages);
    expect(first.pages.map((page) => page.pageNumber)).toEqual(Array.from({ length: fixture.expectedPages }, (_, index) => index + 1));
    expect(first.pages.every((page) => page.title.startsWith(fixture.titlePrefix))).toBe(true);
    expect(first.pages.map((page) => page.text)).toEqual(second.pages.map((page) => page.text));
    expect(await imageDigests(first.pages)).toEqual(await imageDigests(second.pages));
  });
});

async function imageDigests(pages: Array<{ imagePath: string }>): Promise<string[]> {
  return Promise.all(pages.map(async (page) => createHash("sha256").update(await readFile(page.imagePath)).digest("hex")));
}

function testBinaries() {
  return { pdfinfo: "pdfinfo", pdftoppm: "pdftoppm", pdftotext: "pdftotext", soffice: "soffice", python: "python", pptxInspector: "inspect.py" };
}
