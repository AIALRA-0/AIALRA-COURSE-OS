import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type {
  AssessmentItem,
  CourseRelease,
  DraftSourceAsset,
  IdempotentWriteContext,
  LessonDraft,
  ReleaseManifest,
  ResearchArchive,
  WritingPolicySnapshot
} from "@course-os/contracts";
import { COURSE_API_VERSION, WRITING_POLICY_SCHEMA_VERSION } from "@course-os/contracts";
import { hashManifest, sha256Text, stableStringify } from "@course-os/domain";
import { EtapiReadWeaveCourseApi, FileReadWeaveCourseApi, type ReadWeaveCourseApi } from "@course-os/readweave-adapter";
import { ContentAddressedStore, writeJsonAtomic } from "@course-os/storage";
import { buildFullCoursePage, type GoldenDeck } from "@course-os/teaching";

const projectRoot = resolve(".");
const dataDir = resolve(process.env.COURSE_OS_DATA_DIR || "./var");
if (!process.env.EE680_SOURCE_DIR) throw new Error("EE680_SOURCE_DIR_REQUIRED");
const sourceDir = resolve(process.env.EE680_SOURCE_DIR);
const cas = new ContentAddressedStore(resolve(dataDir, "cas"));
const readweave = await createReadWeaveApi();

const policySnapshot = await buildWritingPolicySnapshot();
await writeJsonAtomic(resolve(dataDir, "writing-policy-snapshots", `${policySnapshot.id.replace(/[:\\/]/g, "-")}.json`), policySnapshot);
await archiveResearchReport();

const deckConfigs: Array<{
  deck: GoldenDeck;
  moduleId: string;
  moduleTitle: string;
  releaseId: string;
  pages: number[];
  pdf: string;
  markdown: string;
  screenshots: string;
}> = [
  {
    deck: "introduction",
    moduleId: "ee680-introduction",
    moduleTitle: "Introduction",
    releaseId: "ee680-introduction-full-v3",
    pages: Array.from({ length: 25 }, (_, index) => index + 1),
    pdf: "EE680-Introduction.pdf",
    markdown: "EE680-Introduction-高质量讲解.md",
    screenshots: "screenshots"
  },
  {
    deck: "chapter-2",
    moduleId: "ee680-chapter-2",
    moduleTitle: "Chapter 2 Partitioning",
    releaseId: "ee680-chapter-2-full-v3",
    pages: Array.from({ length: 47 }, (_, index) => index + 1),
    pdf: "EE680-Chapter-2-Partitioning.pdf",
    markdown: "EE680-Chapter-2-Partitioning-高质量讲解.md",
    screenshots: "chapter2-screenshots"
  }
];

for (const config of deckConfigs) {
  const sourcePdfBytes = await readFile(resolve(sourceDir, config.pdf));
  const sourcePdf = await cas.put(sourcePdfBytes);
  const markdown = await readFile(resolve(sourceDir, config.markdown), "utf8");
  const pages = [];
  const sourceAssets: DraftSourceAsset[] = [];
  for (const pageNumber of config.pages) {
    const fileName = `page-${String(pageNumber).padStart(2, "0")}.png`;
    const imageBytes = await readFile(resolve(sourceDir, config.screenshots, fileName));
    const image = await cas.put(imageBytes);
    sourceAssets.push({ sha256: image.sha256, fileName, mediaType: "image/png", bytes: imageBytes });
    pages.push(buildFullCoursePage({
      deck: config.deck,
      pageNumber,
      markdown,
      imageUrl: `/api/v1/media/${image.sha256}`,
      materialVersionId: `${config.moduleId}:${sourcePdf.sha256.slice(0, 12)}`
    }));
  }
  const failedPages = pages.filter((page) => !page.quality.publishable);
  if (failedPages.length) throw new Error(`PUBLISH_GATE_FAILED:${failedPages.map((page) => `${page.pageNumber}:${page.quality.issues.join("|")}`).join(",")}`);
  const assessments = pages.map((page): AssessmentItem => ({
    id: `${page.id}:assessment:recall`,
    objectiveId: page.questionBank?.[0]?.objectiveId ?? `${page.id}:objective`,
    pageId: page.id,
    prompt: page.questionBank?.[0]?.prompt ?? assessmentPrompt(config.deck, page.pageNumber),
    expectedAnswer: page.questionBank?.[0]?.expectedAnswer ?? assessmentAnswer(config.deck, page.pageNumber),
    transfer: false
  }));
  const manifest: ReleaseManifest = {
    id: `${config.releaseId}:manifest`,
    schemaVersion: COURSE_API_VERSION,
    courseReleaseId: config.releaseId,
    sourceHashes: [sourcePdf.sha256, sha256Text(markdown)],
    pageHashes: pages.map((page) => sha256Text(stableStringify(page))),
    explanationHashes: pages.flatMap((page) => page.blocks.map((block) => sha256Text(stableStringify(block)))),
    assessmentHashes: assessments.map((item) => sha256Text(stableStringify(item))),
    writingPolicySnapshotId: policySnapshot.id,
    modelRoutes: ["curated-source-import-v1"],
    qualityHarnessVersion: "ee680-full-v3",
    costInputs: [],
    createdAt: "2026-08-28T12:00:00.000Z"
  };
  const release: CourseRelease = {
    id: config.releaseId,
    courseId: "usc-ee680",
    courseTitle: "USC EE680 Computer-Aided Design of Digital Systems",
    moduleId: config.moduleId,
    moduleTitle: config.moduleTitle,
    version: 3,
    publishedAt: "2026-08-28T12:00:00.000Z",
    pageIds: pages.map((page) => page.id),
    pages,
    assessments,
    manifestHash: hashManifest(manifest),
    writingPolicySnapshotId: policySnapshot.id,
    modelRoute: "curated-source-import-v1",
    qualityHarnessVersion: "ee680-full-v3",
    costUsd: 0
  };
  await readweave.publishRelease(release, manifest, context(`seed:${config.releaseId}`));
  for (const [index, page] of pages.entries()) {
    const current = await readweave.getDraftByPage(page.id);
    if (current && current.status !== "clean") {
      process.stdout.write(`Preserved edited ReadWeave draft for page ${page.pageNumber}\n`);
      continue;
    }
    const draft: LessonDraft = {
      id: current?.id ?? `draft:${page.id}`,
      workspaceId: "personal",
      courseId: release.courseId,
      moduleId: release.moduleId,
      sourceReleaseId: release.id,
      pageId: page.id,
      revision: current?.revision ?? 0,
      status: "clean",
      page: structuredClone(page),
      changedBlockIds: [],
      readweaveNoteId: current?.readweaveNoteId,
      contentHash: sha256Text(stableStringify(page)),
      updatedAt: release.publishedAt
    };
    await readweave.saveDraft(draft, current?.revision ?? 0, context(`seed:${config.releaseId}:page-projection-v2:${page.pageNumber}`), sourceAssets[index]);
  }
  process.stdout.write(`Published ${config.releaseId} with ${pages.length} verified pages\n`);
}

for (const term of ["P0-20", "EE680-G20", "cost_inputs", "AGPL-3.0-only", "Kernighan-Lin"]) {
  const results = await readweave.searchResearch(term);
  if (results.length === 0) throw new Error(`RESEARCH_SEARCH_FAILED:${term}`);
  process.stdout.write(`Research search verified: ${term}\n`);
}

async function archiveResearchReport(): Promise<void> {
  const path = resolve(projectRoot, "docs/research/2026-08-28-course-os-decision-report.md");
  const bytes = await readFile(path);
  const content = bytes.toString("utf8");
  const archive: ResearchArchive = {
    id: "research:course-os-decision-report:2026-08-28",
    version: 1,
    title: "Course OS 决策报告",
    content,
    sha256: createHash("sha256").update(bytes).digest("hex").toUpperCase(),
    byteCount: bytes.length,
    characterCount: content.length,
    lineCount: content.split(/\r?\n/).length - (content.endsWith("\n") ? 1 : 0),
    sourceDate: "2026-08-28",
    gitPath: "docs/research/2026-08-28-course-os-decision-report.md",
    immutable: true,
    createdAt: "2026-08-28T12:00:00.000Z"
  };
  if (archive.sha256 !== "9C5DC68687ED9670D1BD7677AC9C35AB52E240D18816611E7BAECA87AD8FC8D4") throw new Error("RESEARCH_ARCHIVE_HASH_MISMATCH");
  await readweave.archiveResearch(archive, context("seed:research:2026-08-28"));
}

async function buildWritingPolicySnapshot(): Promise<WritingPolicySnapshot> {
  const skillRoot = process.env.HUMAN_READABLE_SKILL_DIR || (process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME, "skills/human-readable-technical-writing") : "");
  if (!skillRoot) throw new Error("HUMAN_READABLE_SKILL_DIR_REQUIRED");
  const paths = [
    resolve(skillRoot, "SKILL.md"),
    resolve(skillRoot, "references/structured-documents.md"),
    resolve(skillRoot, "references/technical-content.md"),
    resolve(skillRoot, "references/complex-reports.md")
  ];
  const sourceFiles = [];
  for (const path of paths) sourceFiles.push({ path: basename(path), sha256: createHash("sha256").update(await readFile(path)).digest("hex") });
  const aggregateSha256 = sha256Text(stableStringify(sourceFiles));
  return { id: `writing-policy:${aggregateSha256.slice(0, 16)}`, schemaVersion: WRITING_POLICY_SCHEMA_VERSION, createdAt: new Date().toISOString(), sourceFiles, aggregateSha256, approved: true };
}

function context(idempotencyKey: string): IdempotentWriteContext {
  return { idempotencyKey, actor: "course-os-seed", workspaceId: "personal", schemaVersion: COURSE_API_VERSION, requestId: idempotencyKey };
}

async function createReadWeaveApi(): Promise<ReadWeaveCourseApi> {
  if (process.env.READWEAVE_MODE !== "etapi") return new FileReadWeaveCourseApi(resolve(dataDir, "readweave-course-store.json"));
  const token = process.env.READWEAVE_API_TOKEN_FILE
    ? (await readFile(process.env.READWEAVE_API_TOKEN_FILE, "utf8")).trim()
    : process.env.READWEAVE_API_TOKEN || "";
  if (!token) throw new Error("READWEAVE_API_TOKEN_REQUIRED");
  return new EtapiReadWeaveCourseApi({
    baseUrl: process.env.READWEAVE_BASE_URL || "http://127.0.0.1:37840",
    token,
    parentNoteId: process.env.READWEAVE_ROOT_NOTE_ID || "root",
    publicUrl: process.env.READWEAVE_PUBLIC_URL,
    workspaceId: process.env.COURSE_OS_WORKSPACE_ID || "personal",
    seedStatePath: resolve(dataDir, "readweave-course-store.json")
  });
}

function assessmentPrompt(deck: GoldenDeck, page: number): string {
  const key = `${deck}:${page}`;
  return ({
    "introduction:2": "物理设计的直接输入是什么，请只写核心术语",
    "introduction:6": "逻辑门版图中控制晶体管导通的结构叫什么",
    "introduction:9": "16 个互异对象的全排列应写成哪个阶乘",
    "introduction:12": "页面没有定义 20K 的对象口径时，应把它标成什么状态",
    "introduction:18": "比较两条运行时间曲线前，必须先核对纵轴的哪两项",
    "introduction:24": "Steiner 布线允许新增的几何分叉点叫什么",
    "chapter-2:3": "跨越两个分区边界的边数量叫什么",
    "chapter-2:6": "不区分左右标签时，4 个顶点平衡二分共有几个方案",
    "chapter-2:9": "KL 一轮中真正提交最佳累计前缀的操作叫什么",
    "chapter-2:11": "KL 选中交换顶点后，为防止本轮重复选择要执行什么操作",
    "chapter-2:18": "FM bucket 的关键索引是什么",
    "chapter-2:41": "谱分割通常使用拉普拉斯矩阵的第几个最小特征向量"
  } as Record<string, string>)[key] || "写出本页核心概念";
}

function assessmentAnswer(deck: GoldenDeck, page: number): string {
  const key = `${deck}:${page}`;
  return ({
    "introduction:2": "门级网表",
    "introduction:6": "栅极",
    "introduction:9": "16!",
    "introduction:12": "来源待核对",
    "introduction:18": "名称和单位",
    "introduction:24": "Steiner点",
    "chapter-2:3": "cutsize",
    "chapter-2:6": "3",
    "chapter-2:9": "ACTUAL-EXCHGE",
    "chapter-2:11": "LOCK",
    "chapter-2:18": "gain",
    "chapter-2:41": "第二小特征向量"
  } as Record<string, string>)[key] || "";
}

try {
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  process.stdout.write(`Git baseline ${commit}\n`);
} catch {
  process.stdout.write("Git baseline is not committed yet\n");
}
