import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

export type ConversionProgressStage = "queued" | "preparing" | "counting_pages" | "rendering_pages" | "extracting_text" | "finalizing" | "saving_pages" | "completed" | "failed";

export interface ConversionProgressSnapshot {
  requestId: string;
  stage: ConversionProgressStage;
  pageCount?: number;
  /** Pages with a complete conversion artifact, never files still being written. */
  completedPages: number;
  issue?: string;
  updatedAt: string;
}

export type ConversionProgressCallback = (snapshot: ConversionProgressSnapshot) => void | Promise<void>;

export interface ConversionProgressUpdate {
  pageCount?: number;
  completedPages?: number;
  issue?: string;
}

export type ConversionProgressReporter = (stage: ConversionProgressStage, update?: ConversionProgressUpdate) => Promise<void>;

export interface ConvertOptions {
  binaries?: Partial<ConverterBinaries>;
  runProcess?: ProcessRunner;
  onProgress?: ConversionProgressCallback;
}

export interface FileConversionQueueOptions extends ConvertOptions {
  queueRoot: string;
  pollIntervalMs?: number;
  resultTimeoutMs?: number;
  processingRecoveryMs?: number;
}

export class FileConversionQueueClient {
  private readonly pendingDir: string;
  private readonly processingDir: string;
  private readonly resultsDir: string;
  private readonly progressDir: string;

  constructor(private readonly options: FileConversionQueueOptions) {
    this.pendingDir = join(options.queueRoot, "pending");
    this.processingDir = join(options.queueRoot, "processing");
    this.resultsDir = join(options.queueRoot, "results");
    this.progressDir = join(options.queueRoot, "progress");
  }

  async enqueueAndWait(request: ConversionRequest, onProgress?: ConversionProgressCallback): Promise<ConversionResult> {
    const id = safeId(request.id);
    await Promise.all([
      mkdir(this.pendingDir, { recursive: true }),
      mkdir(this.processingDir, { recursive: true }),
      mkdir(this.resultsDir, { recursive: true }),
      mkdir(this.progressDir, { recursive: true })
    ]);
    const resultPath = join(this.resultsDir, `${id}.json`);
    const pendingPath = join(this.pendingDir, `${id}.json`);
    const processingPath = join(this.processingDir, `${id}.json`);
    const progressPath = join(this.progressDir, `${id}.json`);
    let lastSent: ConversionProgressSnapshot | undefined;
    const emit = async (snapshot: ConversionProgressSnapshot) => {
      if (lastSent && sameProgress(lastSent, snapshot)) return;
      lastSent = snapshot;
      try { await onProgress?.(structuredClone(snapshot)); } catch { /* Progress observers cannot fail conversion work. */ }
    };
    const existing = await readJsonIfPresent<ConversionResult>(resultPath);
    if (existing) {
      const progress = await this.readProgressAt(progressPath, request.id);
      await emit(progress ? terminalProgressFromResult(existing, progress) : terminalProgressFromResult(existing));
      return existing;
    }
    const pending = await pathExists(pendingPath);
    const processing = await pathExists(processingPath);
    if (!pending && !processing) {
      await writeJsonAtomic(pendingPath, request);
      await emit({ requestId: request.id, stage: "queued", completedPages: 0, updatedAt: new Date().toISOString() });
    } else {
      const progress = await this.readProgressAt(progressPath, request.id);
      await emit(progress ?? { requestId: request.id, stage: "queued", completedPages: 0, updatedAt: new Date().toISOString() });
    }
    const deadline = Date.now() + (this.options.resultTimeoutMs ?? 12 * 60 * 1000);
    while (Date.now() < deadline) {
      const progress = await this.readProgressAt(progressPath, request.id);
      if (progress) await emit(progress);
      const result = await readJsonIfPresent<ConversionResult>(resultPath);
      if (result) {
        await emit(terminalProgressFromResult(result, progress ?? lastSent));
        return result;
      }
      await delay(this.options.pollIntervalMs ?? 250);
    }
    throw new Error("CONVERSION_RESULT_TIMEOUT");
  }

  async getProgressSnapshot(requestId: string): Promise<ConversionProgressSnapshot | undefined> {
    const id = safeId(requestId);
    return this.readProgressAt(join(this.progressDir, `${id}.json`), requestId);
  }

  private async readProgressAt(path: string, requestId: string): Promise<ConversionProgressSnapshot | undefined> {
    const value = await readJsonIfPresent<unknown>(path);
    return validateProgressSnapshot(value, requestId);
  }
}

export class FileConversionQueueWorker {
  private readonly pendingDir: string;
  private readonly processingDir: string;
  private readonly resultsDir: string;
  private readonly progressDir: string;

  constructor(private readonly options: FileConversionQueueOptions) {
    this.pendingDir = join(options.queueRoot, "pending");
    this.processingDir = join(options.queueRoot, "processing");
    this.resultsDir = join(options.queueRoot, "results");
    this.progressDir = join(options.queueRoot, "progress");
  }

  async runOnce(): Promise<boolean> {
    await Promise.all([
      mkdir(this.pendingDir, { recursive: true }),
      mkdir(this.processingDir, { recursive: true }),
      mkdir(this.resultsDir, { recursive: true }),
      mkdir(this.progressDir, { recursive: true })
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
    let lastProgress: ConversionProgressSnapshot = {
      requestId: request.id,
      stage: "preparing",
      completedPages: 0,
      updatedAt: new Date().toISOString()
    };
    const progressPath = join(this.progressDir, `${safeId(request.id)}.json`);
    const publishProgress: ConversionProgressCallback = async (snapshot) => {
      lastProgress = snapshot;
      await writeJsonAtomic(progressPath, snapshot);
      try { await this.options.onProgress?.(structuredClone(snapshot)); } catch { /* Progress observers cannot fail conversion work. */ }
    };
    await publishProgress(lastProgress);
    const result = await convertMaterial(request, { ...this.options, onProgress: publishProgress }).catch(async (error): Promise<ConversionResult> => {
      const failed: ConversionProgressSnapshot = {
        ...lastProgress,
        stage: "failed",
        issue: safeErrorCode(error),
        updatedAt: new Date().toISOString()
      };
      await publishProgress(failed);
      return {
      requestId: request.id,
      state: "failed",
      pages: [],
      issues: [failed.issue!],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
      };
    });
    if (result.state === "completed" && lastProgress.stage !== "completed") {
      await publishProgress({ requestId: request.id, stage: "completed", pageCount: result.pages.length,
        completedPages: result.pages.length, updatedAt: result.completedAt });
    }
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
  let currentPageCount: number | undefined;
  let completedPages = 0;
  const report: ConversionProgressReporter = async (stage, update = {}) => {
    currentPageCount = update.pageCount ?? currentPageCount;
    completedPages = update.completedPages ?? completedPages;
    const snapshot: ConversionProgressSnapshot = {
      requestId: request.id,
      stage,
      ...(currentPageCount === undefined ? {} : { pageCount: currentPageCount }),
      completedPages,
      ...(update.issue ? { issue: update.issue } : {}),
      updatedAt: new Date().toISOString()
    };
    try { await options.onProgress?.(snapshot); } catch { /* Progress observers cannot fail conversion work. */ }
  };
  try {
    await report("preparing");
    const sourcePath = resolve(request.sourcePath);
    const outputDir = resolve(request.outputDir);
    const source = await stat(sourcePath);
    if (!source.isFile()) throw new Error("CONVERSION_SOURCE_NOT_FILE");
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });
    const binaries = resolveBinaries(options.binaries);
    const runProcess = options.runProcess ?? defaultProcessRunner;
    if (request.kind === "pdf" && (request.purpose === "inspect" || request.pdfLayout)) {
      const settings = join(outputDir, "layout-request.json");
      await writeJsonAtomic(settings, { purpose: request.purpose ?? "convert", ...request.pdfLayout });
      await report("counting_pages");
      const result = await runProcess(binaries.python, [fileURLToPath(new URL("../../../scripts/pdf-handout.py", import.meta.url)), sourcePath, settings, outputDir], { cwd: outputDir, timeoutMs: PROCESS_TIMEOUT_MS });
      const parsed = JSON.parse(result.stdout) as Pick<ConversionResult, "pages" | "inspection">;
      if (!parsed.inspection || parsed.inspection.sourceSha256.length !== 64 || !Array.isArray(parsed.pages)) throw new Error("PDF_LAYOUT_RESULT_INVALID");
      if (!request.purpose && (!parsed.pages.length || parsed.pages.length > MAX_PAGES)) throw new Error("CONVERSION_PAGE_COUNT_INVALID");
      for (const page of parsed.pages) await assertPngArtifact(page.imagePath);
      await report("completed", { pageCount: parsed.inspection.logicalPageCount, completedPages: request.purpose ? 0 : parsed.pages.length });
      return { requestId: request.id, state: "completed", ...parsed, issues: [], startedAt, completedAt: new Date().toISOString() };
    }
    const pages = request.kind === "syllabus"
      ? await convertSyllabus(sourcePath, outputDir, report)
      : await convertPagedDocument(request.kind, sourcePath, outputDir, binaries, runProcess, report);
    if (pages.length === 0) throw new Error("CONVERSION_NO_PAGES");
    await report("completed", { pageCount: pages.length, completedPages: pages.length });
    return {
      requestId: request.id,
      state: "completed",
      pages,
      issues: [],
      startedAt,
      completedAt: new Date().toISOString()
    };
  } catch (error) {
    await report("failed", { issue: safeErrorCode(error) });
    throw error;
  }
}

async function convertPagedDocument(kind: "pdf" | "pptx", sourcePath: string, outputDir: string, binaries: ConverterBinaries, runProcess: ProcessRunner, report: ConversionProgressReporter): Promise<ConvertedPage[]> {
  let pdfPath = sourcePath;
  let pptxTitles: string[] = [];
  if (kind === "pptx") {
    const inspection = await runProcess(binaries.python, [binaries.pptxInspector, sourcePath], { cwd: outputDir, timeoutMs: PROCESS_TIMEOUT_MS });
    try {
      const parsed: unknown = JSON.parse(inspection.stdout);
      if (parsed && typeof parsed === "object" && "slideTitles" in parsed && Array.isArray(parsed.slideTitles)) {
        pptxTitles = parsed.slideTitles.map((title: unknown) => typeof title === "string" ? title.trim().slice(0, 90) : "");
      }
    } catch { /* Older inspectors did not return slide titles; retain PDF text inference. */ }
    const localPptx = join(outputDir, "source.pptx");
    await writeFile(localPptx, await readFile(sourcePath), { flag: "wx" });
    const userInstallation = pathToFileURL(join(outputDir, "libreoffice-profile")).href;
    await runProcess(binaries.soffice, [`-env:UserInstallation=${userInstallation}`, "--headless", "--nologo", "--nodefault", "--nolockcheck", "--convert-to", "pdf", "--outdir", outputDir, localPptx], { cwd: outputDir, timeoutMs: PROCESS_TIMEOUT_MS });
    pdfPath = join(outputDir, "source.pdf");
    await assertFile(pdfPath, "CONVERSION_PPTX_PDF_MISSING");
  }
  await report("counting_pages");
  const info = await runProcess(binaries.pdfinfo, [pdfPath], { cwd: outputDir, timeoutMs: PROCESS_TIMEOUT_MS });
  const pageCount = parsePageCount(info.stdout);
  if (pageCount < 1 || pageCount > MAX_PAGES) throw new Error("CONVERSION_PAGE_COUNT_INVALID");
  await report("rendering_pages", { pageCount, completedPages: 0 });
  const imagePrefix = join(outputDir, "page");
  const textPath = join(outputDir, "document.txt");
  await runProcess(binaries.pdftoppm, ["-png", "-r", "144", pdfPath, imagePrefix], { cwd: outputDir, timeoutMs: PROCESS_TIMEOUT_MS });
  const imageFiles = (await readdir(outputDir))
    .filter((name) => /^page-\d+\.png$/i.test(name))
    .sort((left, right) => pageNumberFromFile(left) - pageNumberFromFile(right));
  if (imageFiles.length !== pageCount || imageFiles.some((name, index) => pageNumberFromFile(name) !== index + 1)) {
    throw new Error("CONVERSION_RENDER_PAGE_MISMATCH");
  }
  for (const name of imageFiles) await assertPngArtifact(join(outputDir, name));
  await report("extracting_text", { pageCount, completedPages: 0 });
  await runProcess(binaries.pdftotext, ["-layout", pdfPath, textPath], { cwd: outputDir, timeoutMs: PROCESS_TIMEOUT_MS });
  const textStat = await stat(textPath);
  if (textStat.size > MAX_EXTRACTED_TEXT_BYTES) throw new Error("CONVERSION_EXTRACTED_TEXT_TOO_LARGE");
  const pageTexts = (await readFile(textPath, "utf8")).split("\f");
  await report("finalizing", { pageCount, completedPages: pageCount });
  return imageFiles.map((name, index) => {
    const text = normalizeExtractedText(pageTexts[index] ?? "");
    return {
      pageNumber: index + 1,
      title: pptxTitles[index] || inferTitle(text, index + 1),
      text,
      imagePath: join(outputDir, name),
      imageMediaType: "image/png"
    };
  });
}

async function convertSyllabus(sourcePath: string, outputDir: string, report: ConversionProgressReporter): Promise<ConvertedPage[]> {
  const bytes = await readFile(sourcePath);
  const text = decodeText(bytes);
  const logicalPages = paginateText(text);
  const pages: ConvertedPage[] = [];
  await report("rendering_pages", { pageCount: logicalPages.length, completedPages: 0 });
  for (let index = 0; index < logicalPages.length; index += 1) {
    const pageNumber = index + 1;
    const pageText = logicalPages[index]!;
    const imagePath = join(outputDir, `page-${pageNumber}.svg`);
    await writeFile(imagePath, renderTextPage(pageText, pageNumber), "utf8");
    await assertNonEmptyFile(imagePath, "CONVERSION_PAGE_ARTIFACT_INVALID");
    pages.push({ pageNumber, title: inferTitle(pageText, pageNumber), text: pageText, imagePath, imageMediaType: "image/svg+xml" });
    if (pageNumber % 8 === 0 || pageNumber === logicalPages.length) {
      await report("rendering_pages", { pageCount: logicalPages.length, completedPages: pageNumber });
    }
  }
  await report("finalizing", { pageCount: logicalPages.length, completedPages: logicalPages.length });
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

async function assertNonEmptyFile(path: string, code: string): Promise<void> {
  try {
    const details = await stat(path);
    if (!details.isFile() || details.size === 0) throw new Error(code);
  } catch {
    throw new Error(code);
  }
}

async function assertPngArtifact(path: string): Promise<void> {
  try {
    const bytes = await readFile(path);
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature)) throw new Error("CONVERSION_PAGE_ARTIFACT_INVALID");
    let offset = 8;
    let hasHeader = false;
    let hasImageData = false;
    while (offset + 12 <= bytes.length) {
      const chunkLength = bytes.readUInt32BE(offset);
      const chunkType = bytes.toString("ascii", offset + 4, offset + 8);
      const nextOffset = offset + 12 + chunkLength;
      if (nextOffset > bytes.length) throw new Error("CONVERSION_PAGE_ARTIFACT_INVALID");
      if (offset === 8 && (chunkType !== "IHDR" || chunkLength !== 13
        || bytes.readUInt32BE(offset + 8) === 0 || bytes.readUInt32BE(offset + 12) === 0)) {
        throw new Error("CONVERSION_PAGE_ARTIFACT_INVALID");
      }
      if (chunkType === "IHDR") hasHeader = true;
      if (chunkType === "IDAT" && chunkLength > 0) hasImageData = true;
      if (chunkType === "IEND") {
        if (chunkLength !== 0 || nextOffset !== bytes.length || !hasHeader || !hasImageData) {
          throw new Error("CONVERSION_PAGE_ARTIFACT_INVALID");
        }
        return;
      }
      offset = nextOffset;
    }
    throw new Error("CONVERSION_PAGE_ARTIFACT_INVALID");
  } catch {
    throw new Error("CONVERSION_PAGE_ARTIFACT_INVALID");
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

const conversionProgressStages: ConversionProgressStage[] = [
  "queued", "preparing", "counting_pages", "rendering_pages", "extracting_text", "finalizing", "saving_pages", "completed", "failed"
];

function validateProgressSnapshot(value: unknown, requestId: string): ConversionProgressSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<ConversionProgressSnapshot>;
  if (candidate.requestId !== requestId || !conversionProgressStages.includes(candidate.stage as ConversionProgressStage)
    || !Number.isInteger(candidate.completedPages) || (candidate.completedPages ?? -1) < 0 || (candidate.completedPages ?? 501) > MAX_PAGES
    || typeof candidate.updatedAt !== "string" || Number.isNaN(Date.parse(candidate.updatedAt))) return undefined;
  if (candidate.pageCount !== undefined && (!Number.isInteger(candidate.pageCount) || candidate.pageCount < 1 || candidate.pageCount > MAX_PAGES)) return undefined;
  if (candidate.pageCount !== undefined && candidate.completedPages! > candidate.pageCount) return undefined;
  if (candidate.issue !== undefined && (typeof candidate.issue !== "string" || !/^[A-Z0-9_:-]{1,240}$/u.test(candidate.issue))) return undefined;
  return {
    requestId,
    stage: candidate.stage as ConversionProgressStage,
    ...(candidate.pageCount === undefined ? {} : { pageCount: candidate.pageCount }),
    completedPages: candidate.completedPages!,
    ...(candidate.issue === undefined ? {} : { issue: candidate.issue }),
    updatedAt: candidate.updatedAt
  };
}

function sameProgress(left: ConversionProgressSnapshot, right: ConversionProgressSnapshot): boolean {
  return left.requestId === right.requestId && left.stage === right.stage && left.pageCount === right.pageCount
    && left.completedPages === right.completedPages && left.issue === right.issue;
}

function terminalProgressFromResult(result: ConversionResult, previous?: ConversionProgressSnapshot): ConversionProgressSnapshot {
  const completed = result.state === "completed";
  const pageCount = completed ? result.pages.length : previous?.pageCount;
  const completedPages = completed ? result.pages.length : previous?.completedPages ?? 0;
  return {
    requestId: result.requestId,
    stage: completed ? "completed" : "failed",
    ...(pageCount === undefined ? {} : { pageCount }),
    completedPages,
    ...(!completed && result.issues[0] ? { issue: safeErrorCode(new Error(result.issues[0])) } : {}),
    updatedAt: result.completedAt
  };
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
