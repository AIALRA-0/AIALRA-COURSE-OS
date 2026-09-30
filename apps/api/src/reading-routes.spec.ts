import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CourseProject, CourseRelease, LessonDraft, PageLesson } from "@course-os/contracts";
import { FileReadWeaveCourseApi } from "@course-os/readweave-adapter";
import { buildReadingTree, createApp, createDefaultDependencies } from "./app.js";
import { ReadingRuntime } from "./reading-runtime.js";
import { registerSelfRetellingRoutes } from "./self-retelling-routes.js";

const roots: string[] = [];
const stamp = "2026-09-30T12:00:00.000Z";

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function testPage(): PageLesson {
  return {
    id: "page-a",
    pageNumber: 1,
    title: "Page A",
    imageUrl: "/page-a.png",
    anchors: [{ id: "anchor-a", pageId: "page-a", kind: "text", label: "Source", text: "Source text" }],
    atoms: [],
    blocks: [{ id: "block-a", title: "Check", kind: "check", markdown: "What is the answer?", sourceAnchorIds: [], atomIds: [] }],
    questionBank: [{
      id: "question-a", pageId: "page-a", objectiveId: "objective-a", kind: "comprehension",
      prompt: "Answer yes?", expectedAnswer: "yes", explanation: "The confirmed answer is yes.",
      sourceAnchorIds: ["anchor-a"], status: "approved", version: 1, generatedBy: "test"
    }],
    coverageRequirements: [],
    coverageClaims: [],
    quality: { highRiskCoverage: 1, generalCoverage: 1, mathValid: true, publishable: true, issues: [] }
  };
}

function testRelease(page = testPage()): CourseRelease {
  return {
    id: "release-a", courseId: "course-a", courseTitle: "Course A", moduleId: "module-a", moduleTitle: "Module A",
    version: 1, publishedAt: stamp, pageIds: [page.id], pages: [page], assessments: [], manifestHash: "manifest-a",
    writingPolicySnapshotId: "policy-a", modelRoute: "test", qualityHarnessVersion: "test", costUsd: 0, lifecycle: "published"
  };
}

function testDraft(release = testRelease(), page = release.pages[0]!): LessonDraft {
  return {
    id: "draft:page-a", workspaceId: "personal", courseId: release.courseId, moduleId: release.moduleId,
    sourceReleaseId: release.id, pageId: page.id, revision: 1, status: "ready", page: structuredClone(page),
    changedBlockIds: [], contentHash: "draft-hash-a", updatedAt: stamp
  };
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "course-os-reading-routes-"));
  roots.push(root);
  const authority = new FileReadWeaveCourseApi(join(root, "authority.json"));
  const dependencies = createDefaultDependencies(root, authority);
  const course: CourseProject = { id: "course-a", workspaceId: "personal", title: "Course A", status: "active", createdAt: stamp, updatedAt: stamp };
  const release = testRelease();
  const draft = testDraft(release);
  const reading = new ReadingRuntime(join(root, "reading"), authority, "personal", "authority:reading-routes", () => buildReadingTree([course], [], [], "personal"));
  await reading.initialize();
  await reading.replica.replace({ courses: [course], releases: [release], drafts: [draft], tree: buildReadingTree([course], [], [], "personal"), trash: [] });
  dependencies.reading = reading;
  const app = createApp(dependencies);
  registerSelfRetellingRoutes(app, dependencies);
  return { app, authority, dependencies, reading, release, draft };
}

describe("replica-backed reading routes", () => {
  it("serves an exact local snapshot and reconciles only after local workspace/release/page authorization", async () => {
    const { app, authority, reading, draft } = await harness();
    const getDraftByPage = vi.spyOn(authority, "getDraftByPage").mockRejectedValue(new Error("REMOTE_READ_MUST_NOT_RUN"));
    const confirm = vi.spyOn(reading, "confirmPage").mockResolvedValue();

    const local = await request(app).get("/api/v1/pages/page-a/draft?view=snapshot&releaseId=release-a")
      .set("X-Workspace-Id", "personal").expect(200);
    expect(local.body).toMatchObject({ id: draft.id, sourceReleaseId: "release-a", pageId: "page-a" });
    expect(local.headers["cache-control"]).toBe("private, no-store");
    expect(local.headers.vary).toContain("X-Workspace-Id");
    expect(confirm).not.toHaveBeenCalled();

    await request(app).get("/api/v1/pages/page-a/draft?view=snapshot&releaseId=release-a&confirm=1")
      .set("X-Workspace-Id", "personal").expect(200);
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith("page-a", "release-a");

    await request(app).get("/api/v1/pages/page-a/draft?view=snapshot&releaseId=release-a&confirm=1")
      .set("X-Workspace-Id", "other").expect(404);
    await request(app).get("/api/v1/pages/other-page/draft?view=snapshot&releaseId=release-a&confirm=1")
      .set("X-Workspace-Id", "personal").expect(404);
    expect(confirm).toHaveBeenCalledOnce();
    expect(getDraftByPage).not.toHaveBeenCalled();
  });

  it("uses local release/page snapshots for sessions, question selection, and answer validation while keeping writes authoritative", async () => {
    const { app, authority, dependencies, release } = await harness();
    const getRelease = vi.spyOn(authority, "getRelease").mockRejectedValue(new Error("FULL_RELEASE_READ_MUST_NOT_RUN"));
    const getDraftByPage = vi.spyOn(authority, "getDraftByPage").mockRejectedValue(new Error("DRAFT_READ_MUST_NOT_RUN"));
    const saveSelection = vi.spyOn(authority, "saveQuestionSelection").mockImplementation(async (selection) => selection);
    vi.spyOn(authority, "saveQuestion").mockImplementation(async (question) => question);
    vi.spyOn(authority, "saveQuestionAttemptTransaction").mockImplementation(async (attempt, assessmentAttempt, reduceMastery) => ({
      attempt, assessmentAttempt, mastery: reduceMastery(undefined)
    }));

    const index = await request(app).get("/api/v1/releases/release-a").set("X-Workspace-Id", "personal").expect(200);
    expect(index.body).toMatchObject({ id: release.id, pageIds: ["page-a"], pages: [{ id: "page-a", questionBank: [] }] });
    const sessionResponse = await request(app).post("/api/v1/sessions").set("X-Workspace-Id", "personal")
      .send({ courseReleaseId: release.id }).expect(201);
    expect(sessionResponse.body.courseReleaseId).toBe(release.id);

    await request(app).post(`/api/v1/pages/page-a/questions:select`).set("X-Workspace-Id", "personal")
      .set("Idempotency-Key", "selection-a").send({ sessionId: sessionResponse.body.id, seed: "seed-a" }).expect(201);
    expect(saveSelection).toHaveBeenCalledOnce();

    await request(app).post("/api/v1/question-attempts").set("X-Workspace-Id", "personal")
      .set("Idempotency-Key", "attempt-a")
      .send({ courseReleaseId: release.id, pageId: "page-a", questionId: "question-a", answer: "yes", sessionId: sessionResponse.body.id, selectionId: "selection-a" })
      .expect(201);
    expect(getRelease).not.toHaveBeenCalled();
    expect(getDraftByPage).not.toHaveBeenCalled();
    expect(dependencies.reading?.status().ready).toBe(true);
  });

  it("validates self-retelling ownership locally before preserving the existing idempotent write", async () => {
    const { app, authority, dependencies } = await harness();
    const getRelease = vi.spyOn(authority, "getRelease").mockRejectedValue(new Error("FULL_RELEASE_READ_MUST_NOT_RUN"));
    const listCourses = vi.spyOn(authority, "listCourses").mockRejectedValue(new Error("COURSE_READ_MUST_NOT_RUN"));
    const mutate = vi.spyOn(dependencies.operations, "urgentMutate");
    const headers = {
      "X-Workspace-Id": "personal", "X-Actor": "test", "X-Request-Id": "retelling-request",
      "X-Schema-Version": "2.4.0", "Idempotency-Key": "retelling-a"
    };

    await request(app).put("/api/v1/self-retellings/release-a/page-a")
      .set({ ...headers, "X-Workspace-Id": "other" }).send({ answer: "My own explanation" }).expect(404);
    expect(mutate).not.toHaveBeenCalled();

    const saved = await request(app).put("/api/v1/self-retellings/release-a/page-a")
      .set(headers).send({ answer: "My own explanation" }).expect(200);
    expect(saved.body).toMatchObject({ workspaceId: "personal", releaseId: "release-a", pageId: "page-a", answer: "My own explanation" });
    expect(getRelease).not.toHaveBeenCalled();
    expect(listCourses).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledOnce();
  });
});
