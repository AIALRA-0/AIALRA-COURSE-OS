import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { ConversionRequest, ConversionResult, ConvertedPage } from "@course-os/contracts";
import { writeJsonAtomic } from "@course-os/storage";

const execFileAsync = promisify(execFile);
const MAX_PAGES = 500;
const MAX_EXTRACTED_TEXT_BYTES = 20 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 10 * 60 * 1000;

export interface ConverterBinaries {
  pdfinfo: string;
  pdftoppm: string;
  pdftotext: string;
  soffice: string;
  python: string;
  pptxInspector: string;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (command: string, args: string[], options: { cwd: string; timeoutMs: number }) => Promise<ProcessResult>;

export interface ConvertOptions {
  binaries?: Partial<ConverterBinaries>;
  runProcess?: ProcessRunner;
}

export interface FileConversionQueueOptions extends ConvertOptions {
  queueRoot: string;
  pollIntervalMs?: number;
  resultTimeoutMs?: number;
  processingRecoveryMs?: number;
}

export class FileConversionQueueClient {
  private readonly pendingDir: string;
  private readonly resultsDir: string;

  constructor(private readonly options: FileConversionQueueOptions) {
    this.pendingDir = join(options.queueRoot, "pending");
    this.resultsDir = join(options.queueRoot, "results");
  }

  async enqueueAndWait(request: ConversionRequest): Promise<ConversionResult> {
    await Promise.all([mkdir(this.pendingDir, { recursive: true }), mkdir(this.resultsDir, { recursive: true })]);
    const resultPath = join(this.resultsDir, `${safeId(request.id)}.json`);
    const existing = await readJsonIfPresent<ConversionResult>(resultPath);
    if (existing) return existing;
    await writeJsonAtomic(join(this.pendingDir, `${safeId(request.id)}.json`), request);
    const deadline = Date.now() + (this.options.resultTimeoutMs ?? 12 * 60 * 1000);
    while (Date.now() < deadline) {
      const result = await readJsonIfPresent<ConversionResult>(resultPath);
      if (result) return result;
      await delay(this.options.pollIntervalMs ?? 250);
    }
    throw new Error("CONVERSION_RESULT_TIMEOUT");
  }
}

export class FileConversionQueueWorker {
  private readonly pendingDir: string;
  private readonly processingDir: string;
  private readonly resultsDir: string;

  constructor(private readonly options: FileConversionQueueOptions) {
    this.pendingDir = join(options.queueRoot, "pending");
    this.processingDir = join(options.queueRoot, "processing");
    this.resultsDir = join(options.queueRoot, "results");
  }

  async runOnce(): Promise<boolean> {
    await Promise.all([
      mkdir(this.pendingDir, { recursive: true }),
      mkdir(this.processingDir, { recursive: true }),
      mkdir(this.resultsDir, { recursive: true })
    ]);
    await this.recoverStaleProcessing();
    const name = (await readdir(this.pendingDir)).filter((item) => item.endsWith(".json")).sort()[0];
    if (!name) return false;
    const pendingPath = join(this.pendingDir, name);
    const processingPath = join(this.processingDir, name);
    try {
      await rename(pendingPath, processingPath);
    } catch {
      return false;
    }
    const request = JSON.parse(await readFile(processingPath, "utf8")) as ConversionRequest;
    const result = await convertMaterial(request, this.options).catch((error): ConversionResult => ({
      requestId: request.id,
      state: "failed",
      pages: [],
      issues: [safeErrorCode(error)],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    }));
    await writeJsonAtomic(join(this.resultsDir, `${safeId(request.id)}.json`), result);
    await rm(processingPath, { force: true });
    return true;
  }

  private async recoverStaleProcessing(): Promise<void> {
    const recoveryMs = this.options.processingRecoveryMs ?? PROCESS_TIMEOUT_MS * 2;
    const now = Date.now();
    const names = (await readdir(this.processingDir)).filter((item) => item.endsWith(".json"));
    for (const name of names) {
      const processingPath = join(this.processingDir, name);
      const resultPath = join(this.resultsDir, name);
      const existingResult = await readJsonIfPresent<ConversionResult>(resultPath);
      if (existingResult) {
        await rm(processingPath, { force: true });
        continue;
      }
      const details = await stat(processingPath).catch(() => undefined);
      if (!details || now - details.mtimeMs < recoveryMs) continue;
      const pendingPath = join(this.pendingDir, name);
      const pending = await stat(pendingPath).catch(() => undefined);
      if (pending) {
        await rm(processingPath, { force: true });
        continue;
      }
      await rename(processingPath, pendingPath).catch(() => undefined);
    }
  }

  async serve(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      const processed = await this.runOnce();
      if (!processed) await delay(this.options.pollIntervalMs ?? 250);
    }
  }
}

export async function convertMaterial(request: ConversionRequest, options: ConvertOptions = {}): Promise<ConversionResult> {
  const startedAt = new Date().toISOString();
  const sourcePath = resolve(request.sourcePath);
  const outputDir = resolve(request.outputDir);
  const source = await stat(sourcePath);
  if (!source.isFile()) throw new Error("CONVERSION_SOURCE_NOT_FILE");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const binaries = resolveBinaries(options.binaries);
  const runProcess = options.runProcess ?? defaultProcessRunner;
  const pages = request.kind === "syllabus"
    ? await convertSyllabus(sourcePath, outputDir)
    : await convertPagedDocument(request.kind, sourcePath, outputDir, binaries, runProcess);
  if (pages.length === 0) throw new Error("CONVERSION_NO_PAGES");
  return {
    requestId: request.id,
    state: "completed",
    pages,
    issues: [],
    startedAt,
    completedAt: new Date().toISOString()
  };
}

async function convertPagedDocument(kind: "pdf" | "pptx", sourcePath: string, outputDir: string, binaries: ConverterBinaries, runProcess: ProcessRunner): Promise<ConvertedPage[]> {
  let pdfPath = sourcePath;
  if (kind === "pptx") {
    await runProcess(binaries.python, [binaries.pptxInspector, sourcePath], { cwd: outputDir, timeoutMs: PROCESS_TIMEOUT_MS });
    const localPptx = join(outputDir, "source.pptx");
    await writeFile(localPptx, await readFile(sourcePath), { flag: "wx" });
    const userInstallation = pathToFileURL(join(outputDir, "libreoffice-profile")).href;
    await runProcess(binaries.soffice, [`-env:UserInstallation=${userInstallation}`, "--headless", "--nologo", "--nodefault", "--nolockcheck", "--convert-to", "pdf", "--outdir", outputDir, localPptx], { cwd: outputDir, timeoutMs: PROCESS_TIMEOUT_MS });
    pdfPath = join(outputDir, "source.pdf");
    await assertFile(pdfPath, "CONVERSION_PPTX_PDF_MISSING");
  }
  const info = await runProcess(binaries.pdfinfo, [pdfPath], { cwd: outputDir, timeoutMs: PROCESS_TIMEOUT_MS });
  const pageCount = parsePageCount(info.stdout);
  if (pageCount < 1 || pageCount > MAX_PAGES) throw new Error("CONVERSION_PAGE_COUNT_INVALID");
  const imagePrefix = join(outputDir, "page");
  const textPath = join(outputDir, "document.txt");
  await runProcess(binaries.pdftoppm, ["-png", "-r", "144", pdfPath, imagePrefix], { cwd: outputDir, timeoutMs: PROCESS_TIMEOUT_MS });
  await runProcess(binaries.pdftotext, ["-layout", pdfPath, textPath], { cwd: outputDir, timeoutMs: PROCESS_TIMEOUT_MS });
  const textStat = await stat(textPath);
  if (textStat.size > MAX_EXTRACTED_TEXT_BYTES) throw new Error("CONVERSION_EXTRACTED_TEXT_TOO_LARGE");
  const pageTexts = (await readFile(textPath, "utf8")).split("\f");
  const imageFiles = (await readdir(outputDir))
    .filter((name) => /^page-\d+\.png$/i.test(name))
    .sort((left, right) => pageNumberFromFile(left) - pageNumberFromFile(right));
  if (imageFiles.length !== pageCount) throw new Error("CONVERSION_RENDER_PAGE_MISMATCH");
  return imageFiles.map((name, index) => {
    const text = normalizeExtractedText(pageTexts[index] ?? "");
    return {
      pageNumber: index + 1,
      title: inferTitle(text, index + 1),
      text,
      imagePath: join(outputDir, name),
      imageMediaType: "image/png"
    };
  });
}

async function convertSyllabus(sourcePath: string, outputDir: string): Promise<ConvertedPage[]> {
  const bytes = await readFile(sourcePath);
  const text = decodeText(bytes);
  const logicalPages = paginateText(text);
  const pages: ConvertedPage[] = [];
  for (let index = 0; index < logicalPages.length; index += 1) {
    const pageNumber = index + 1;
    const pageText = logicalPages[index]!;
    const imagePath = join(outputDir, `page-${pageNumber}.svg`);
    await writeFile(imagePath, renderTextPage(pageText, pageNumber), "utf8");
    pages.push({ pageNumber, title: inferTitle(pageText, pageNumber), text: pageText, imagePath, imageMediaType: "image/svg+xml" });
  }
  return pages;
}

function paginateText(text: string): string[] {
  const pages: string[] = [];
  const sourcePages = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\f");
  for (const sourcePage of sourcePages) {
    const lines = sourcePage.split("\n");
    let current: string[] = [];
    let units = 0;
    for (const line of lines) {
      const wrapped = wrapLine(line, 64);
      if (units + wrapped.length > 34 && current.length > 0) {
        pages.push(current.join("\n").trim());
        current = [];
        units = 0;
      }
      current.push(...wrapped);
      units += wrapped.length;
    }
    if (current.length > 0) pages.push(current.join("\n").trim());
  }
  if (pages.length === 0) pages.push("");
  if (pages.length > MAX_PAGES) throw new Error("CONVERSION_PAGE_COUNT_INVALID");
  return pages;
}

function wrapLine(line: string, width: number): string[] {
  if (!line) return [""];
  const output: string[] = [];
  for (let offset = 0; offset < line.length; offset += width) output.push(line.slice(offset, offset + width));
  return output;
}

function renderTextPage(text: string, pageNumber: number): string {
  const lines = text.split("\n").slice(0, 36);
  const tspans = lines.map((line, index) => `<text x="96" y="${148 + index * 20}" class="body">${escapeXml(line || " ")}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="#fffdf8"/><rect x="55" y="50" width="10" height="800" rx="5" fill="#3157d5"/><text x="96" y="95" class="header">COURSE MATERIAL</text>${tspans}<text x="1490" y="842" text-anchor="end" class="page">${pageNumber}</text><style>.header{font:700 22px Arial,sans-serif;letter-spacing:3px;fill:#3157d5}.body{font:20px 'Noto Sans CJK SC','Microsoft YaHei',Arial,sans-serif;fill:#172033}.page{font:600 18px Arial,sans-serif;fill:#6b7280}</style></svg>`;
}

function decodeText(bytes: Buffer): string {
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^\uFEFF/, "");
  const replacements = [...decoded].filter((character) => character === "\uFFFD").length;
  if (replacements > Math.max(3, decoded.length * 0.01)) throw new Error("CONVERSION_TEXT_ENCODING_UNSUPPORTED");
  return decoded;
}

function inferTitle(text: string, pageNumber: number): string {
  const first = text.split("\n").map((line) => line.trim().replace(/^#{1,6}\s+/, "")).find(Boolean);
  return first ? first.slice(0, 90) : `第 ${pageNumber} 页`;
}

function normalizeExtractedText(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(/[ \t]+$/gm, "").replace(/\n{4,}/g, "\n\n\n").trim();
}

function parsePageCount(stdout: string): number {
  const match = stdout.match(/^Pages:\s+(\d+)\s*$/mi);
  return match ? Number(match[1]) : 0;
}

function pageNumberFromFile(name: string): number {
  return Number(name.match(/(\d+)\.png$/i)?.[1] ?? 0);
}

function resolveBinaries(overrides: Partial<ConverterBinaries> = {}): ConverterBinaries {
  return {
    pdfinfo: overrides.pdfinfo ?? process.env.COURSE_OS_PDFINFO_BIN ?? "pdfinfo",
    pdftoppm: overrides.pdftoppm ?? process.env.COURSE_OS_PDFTOPPM_BIN ?? "pdftoppm",
    pdftotext: overrides.pdftotext ?? process.env.COURSE_OS_PDFTOTEXT_BIN ?? "pdftotext",
    soffice: overrides.soffice ?? process.env.COURSE_OS_SOFFICE_BIN ?? "soffice",
    python: overrides.python ?? process.env.COURSE_OS_PYTHON_BIN ?? "python3",
    pptxInspector: overrides.pptxInspector ?? process.env.COURSE_OS_PPTX_INSPECTOR ?? "/app/scripts/inspect-pptx.py"
  };
}

async function defaultProcessRunner(command: string, args: string[], options: { cwd: string; timeoutMs: number }): Promise<ProcessResult> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      windowsHide: true,
      maxBuffer: 25 * 1024 * 1024,
      env: { ...process.env, TMPDIR: options.cwd }
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code || "FAILED";
    throw new Error(`CONVERSION_PROCESS_${basename(command).toUpperCase()}_${code}`);
  }
}

async function assertFile(path: string, code: string): Promise<void> {
  try {
    if (!(await stat(path)).isFile()) throw new Error(code);
  } catch {
    throw new Error(code);
  }
}

async function readJsonIfPresent<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function safeId(value: string): string {
  if (!/^[a-zA-Z0-9:_-]+$/.test(value)) throw new Error("CONVERSION_ID_INVALID");
  return value.replaceAll(":", "_");
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "CONVERSION_UNKNOWN_FAILURE";
  return /^[A-Z0-9_:-]+$/.test(message) ? message.slice(0, 240) : "CONVERSION_INTERNAL_FAILURE";
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export async function removeConversionOutput(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export function newConversionRequest(input: Omit<ConversionRequest, "id" | "createdAt">): ConversionRequest {
  return { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
}
