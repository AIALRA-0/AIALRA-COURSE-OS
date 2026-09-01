import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CourseRelease, IdempotentWriteContext, LessonDraft, ReleaseManifest } from "@course-os/contracts";
import { COURSE_API_VERSION } from "@course-os/contracts";
import { sha256Text, stableStringify } from "@course-os/domain";
import { EtapiReadWeaveCourseApi, type ReadWeaveFileState } from "@course-os/readweave-adapter";
import { buildPromotionPlan, pageHash, selectLatestFormalReleases } from "./readweave-promotion.js";

const args = new Set(process.argv.slice(2));
for (const arg of args) if (arg !== "--apply") throw new Error(`UNKNOWN_ARGUMENT:${arg}`);
const apply = args.has("--apply");
const dataDir = resolve(process.env.COURSE_OS_DATA_DIR || "./var");
const statePath = resolve(dataDir, "readweave-course-store.json");
const state = JSON.parse(await readFile(statePath, "utf8")) as ReadWeaveFileState;
const token = process.env.READWEAVE_API_TOKEN_FILE
  ? (await readFile(resolve(process.env.READWEAVE_API_TOKEN_FILE), "utf8")).trim()
  : process.env.READWEAVE_API_TOKEN?.trim() || "";
if (!token) throw new Error("READWEAVE_API_TOKEN_REQUIRED");
const remote = new EtapiReadWeaveCourseApi({
  baseUrl: process.env.READWEAVE_BASE_URL || "http://127.0.0.1:37840",
  token,
  parentNoteId: process.env.READWEAVE_ROOT_NOTE_ID || "root",
  publicUrl: process.env.READWEAVE_PUBLIC_URL,
  workspaceId: process.env.COURSE_OS_WORKSPACE_ID || "personal"
});
const explicitIds = (process.env.COURSE_OS_PROMOTION_RELEASE_IDS || "").split(",").map((value) => value.trim()).filter(Boolean);
const selected = selectLatestFormalReleases(state, explicitIds);

const initial = await inspectRemote(selected);
printReport(apply ? "preflight" : "dry-run", initial.plan);
if (initial.plan.conflicts.length) process.exit(2);
if (!apply) process.exit(0);

const manifestByRelease = new Map(state.manifests.map((manifest) => [manifest.courseReleaseId, manifest]));
for (const releaseId of initial.plan.releasesToCreate) {
  const release = selected.find((candidate) => candidate.id === releaseId)!;
  const manifest = manifestByRelease.get(releaseId);
  if (!manifest) throw new Error(`LOCAL_MANIFEST_MISSING:${releaseId}`);
  await remote.publishRelease(release, manifest, writeContext(`release:${releaseId}:${release.manifestHash.slice(0, 16)}`));
}
for (const action of initial.plan.draftsToCreate) {
  const release = selected.find((candidate) => candidate.id === action.releaseId)!;
  const page = release.pages.find((candidate) => candidate.id === action.pageId)!;
  const draft: LessonDraft = {
    id: `draft:${page.id}`,
    workspaceId: process.env.COURSE_OS_WORKSPACE_ID || "personal",
    courseId: release.courseId,
    moduleId: release.moduleId,
    sourceReleaseId: release.id,
    pageId: page.id,
    revision: 0,
    status: "clean",
    page: structuredClone(page),
    changedBlockIds: [],
    contentHash: pageHash(page),
    updatedAt: release.publishedAt
  };
  await remote.saveDraft(draft, 0, writeContext(`draft:${page.id}:${draft.contentHash.slice(0, 16)}`));
}

const verified = await inspectRemote(selected);
printReport("verified", verified.plan);
if (verified.plan.conflicts.length || verified.plan.releasesToCreate.length || verified.plan.draftsToCreate.length) throw new Error("READWEAVE_PROMOTION_READBACK_FAILED");

async function inspectRemote(releases: CourseRelease[]) {
  const remoteReleases = await remote.listReleases();
  const remoteManifests = new Map<string, ReleaseManifest | undefined>();
  const remoteDrafts = new Map<string, LessonDraft | undefined>();
  for (const release of releases) {
    remoteManifests.set(release.id, await remote.getManifest(release.id));
    for (const page of release.pages) remoteDrafts.set(page.id, await remote.getDraftByPage(page.id));
  }
  return { plan: buildPromotionPlan(state, releases, remoteReleases, remoteManifests, remoteDrafts) };
}

function writeContext(objectKey: string): IdempotentWriteContext {
  const idempotencyKey = `course-os-promote:2.4.0:${objectKey}`;
  return { idempotencyKey, actor: "course-os-operator", workspaceId: process.env.COURSE_OS_WORKSPACE_ID || "personal", schemaVersion: COURSE_API_VERSION, requestId: sha256Text(idempotencyKey).slice(0, 32) };
}

function printReport(mode: "dry-run" | "preflight" | "verified", plan: ReturnType<typeof buildPromotionPlan>): void {
  process.stdout.write(`${JSON.stringify({ mode, contract: COURSE_API_VERSION, sourceState: "readweave-course-store.json", destructiveOperations: false, ...plan }, null, 2)}\n`);
}
