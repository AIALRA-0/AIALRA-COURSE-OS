import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codeLayoutHint, readCodeLayoutHint } from "./source-layout.js";

const tsvHeader = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("source layout hints", () => {
  it("orders OCR lines by vertical position and anchors x after leading border punctuation", () => {
    const rows = [
      word("end", { line: 3, word: 1, left: 70, top: 60 }),
      word("if", { line: 2, word: 1, left: 40, top: 40 }),
      word(">", { line: 2, word: 2, left: 55, top: 40 }),
      word("x", { line: 2, word: 3, left: 70, top: 40 }),
      word("0", { line: 2, word: 4, left: 85, top: 40 }),
      word(":", { line: 2, word: 5, left: 100, top: 40 }),
      word("|", { line: 1, word: 1, left: 8, top: 20 }),
      word("while", { line: 1, word: 2, left: 30, top: 20 }),
      word("x", { line: 1, word: 3, left: 62, top: 20 }),
      word("<", { line: 1, word: 4, left: 78, top: 20 }),
      word("4:", { line: 1, word: 5, left: 92, top: 20 })
    ];

    const hint = codeLayoutHint([tsvHeader, ...rows].join("\n"));

    expect(hint).toContain("x=30 | while x < 4:");
    expect(hint).toContain("x=40 if > x 0 :");
    expect(hint).toContain("x=70 end");
    expect(hint).not.toContain("x=8 | while");
    expect(hint.indexOf("x=30 | while")).toBeLessThan(hint.indexOf("x=40 if"));
  });

  it("returns no extra context when OCR text does not contain enough code structure", () => {
    const hint = codeLayoutHint([
      tsvHeader,
      word("if", { line: 1, word: 1, left: 20, top: 10 }),
      word("for", { line: 2, word: 1, left: 24, top: 30 }),
      word("explanation", { line: 3, word: 1, left: 30, top: 50 })
    ].join("\n"));

    expect(hint).toBe("");
  });

  it("preserves a dedented sibling rather than inventing continued nesting", () => {
    const hint = codeLayoutHint([
      tsvHeader,
      word("while", { line: 1, word: 1, left: 30, top: 10 }),
      word("for", { line: 2, word: 1, left: 60, top: 20 }),
      word("if", { line: 3, word: 1, left: 90, top: 30 }),
      word("commit()", { line: 4, word: 1, left: 60, top: 40 }),
      word("end", { line: 5, word: 1, left: 30, top: 50 })
    ].join("\n"));
    expect(hint).toContain("```text\nwhile\n   for\n      if\n   commit()\nend\n```");
  });

  it("keeps each line's x origin local to that line", () => {
    const hint = codeLayoutHint([
      tsvHeader,
      word("if", { line: 1, word: 1, left: 24, top: 10 }),
      word("x", { line: 1, word: 2, left: 50, top: 10 }),
      word("|", { line: 2, word: 1, left: 5, top: 30 }),
      word("end", { line: 2, word: 2, left: 81, top: 30 }),
      word("while", { line: 3, word: 1, left: 36, top: 50 })
    ].join("\n"));

    expect(hint).toContain("x=24 if x");
    expect(hint).toContain("x=81 | end");
    expect(hint).toContain("x=36 while");
  });

  it("ignores malformed TSV rows without throwing or admitting invalid coordinates", () => {
    const hint = codeLayoutHint([
      tsvHeader,
      "5\t1",
      word("for", { line: 1, word: 1, left: Number.NaN, top: 10 }),
      word("begin", { line: 2, word: 1, left: 20, top: 30, confidence: -1 }),
      word("if", { line: 3, word: 1, left: 25, top: 50 }),
      word("while", { line: 4, word: 1, left: 28, top: 70 }),
      word("end", { line: 5, word: 1, left: 30, top: 90 })
    ].join("\n"));

    expect(hint).toContain("x=25 if");
    expect(hint).toContain("x=28 while");
    expect(hint).toContain("x=30 end");
    expect(hint).not.toContain("for");
    expect(hint).not.toContain("begin");
  });

  it("returns an empty hint for non-image input and a missing OCR binary", async () => {
    vi.stubEnv("COURSE_OS_OCR_BIN", join(tmpdir(), `course-os-missing-tesseract-${randomUUID()}.exe`));

    await expect(readCodeLayoutHint("not-an-image-data-url")).resolves.toBe("");
    await expect(readCodeLayoutHint("data:image/png;base64,AA==")).resolves.toBe("");
  });
});

function word(text: string, options: { line: number; word: number; left: number; top: number; confidence?: number }): string {
  return ["5", "1", "1", "1", options.line, options.word, options.left, options.top, "12", "12", options.confidence ?? 90, text].join("\t");
}
