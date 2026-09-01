import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const archivePath = resolve("docs/research/2026-08-28-course-os-decision-report.md");
const bytes = await readFile(archivePath);
const text = bytes.toString("utf8");
const result = {
  sha256: createHash("sha256").update(bytes).digest("hex").toUpperCase(),
  byteCount: bytes.length,
  characterCount: text.length,
  lineCount: text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0)
};
const expected = {
  sha256: "9C5DC68687ED9670D1BD7677AC9C35AB52E240D18816611E7BAECA87AD8FC8D4",
  byteCount: 97187,
  characterCount: 63049,
  lineCount: 2541
};
if (JSON.stringify(result) !== JSON.stringify(expected)) {
  process.stderr.write(`Research archive mismatch\nExpected ${JSON.stringify(expected)}\nActual ${JSON.stringify(result)}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Research archive verified ${result.sha256}\n`);
}
