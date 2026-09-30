import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
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
  it.each(["READWEAVE_ETAPI_401", "READWEAVE_ETAPI_403", "READWEAVE_HTTP_401", "READWEAVE_HTTP_403"])(
    "reports %s as terminal access denial on the first confirmation and blocks previously readable copies",
    async (upstreamCode) => {
      const { app, authority, reading } = await harness();
      await request(app).get("/api/v1/pages/page-a/draft?view=snapshot&releaseId=release-a")
        .set("X-Workspace-Id", "personal").expect(200);
      vi.spyOn(authority, "getDraftByPage").mockRejectedValue(new Error(`${upstreamCode}: source access denied`));

      const denied = await request(app).get("/api/v1/pages/page-a/draft?view=snapshot&releaseId=release-a&confirm=1")
        .set("X-Workspace-Id", "personal").expect(403);
      expect(denied.body.error).toMatchObject({ code: "ACCESS_DENIED", retryable: false });
      expect(reading.status()).toMatchObject({ accessDenied: true, ready: false });
      for (const path of [
        "/api/v1/pages/page-a/draft?view=snapshot&releaseId=release-a",
        "/api/v1/pages/page-a/lesson?releaseId=release-a",
        "/api/v1/releases?view=index"
      ]) {
        const blocked = await request(app).get(path).set("X-Workspace-Id", "personal").expect(403);
        expect(blocked.body.error).toMatchObject({ code: "ACCESS_DENIED", retryable: false });
      }
    }
  );

  it("keeps confirmed copies readable after a temporary source failure", async () => {
    const { app, authority, reading, draft } = await harness();
    vi.spyOn(authority, "getDraftByPage").mockRejectedValue(new Error("READWEAVE_ETAPI_503: temporary outage"));
    const failed = await request(app).get("/api/v1/pages/page-a/draft?view=snapshot&releaseId=release-a&confirm=1")
      .set("X-Workspace-Id", "personal").expect(503);
    expect(failed.body.error).toMatchObject({ code: "READWEAVE_UNAVAILABLE", retryable: true });
    expect(reading.status()).toMatchObject({ accessDenied: false, ready: true, synchronization: "degraded" });
    const local = await request(app).get("/api/v1/pages/page-a/draft?view=snapshot&releaseId=release-a")
      .set("X-Workspace-Id", "personal").expect(200);
    expect(local.body).toMatchObject({ contentHash: draft.contentHash, sourceReleaseId: draft.sourceReleaseId });
  });

  it("serves replica release indexes as equivalent gzip and identity JSON without authority reads", async () => {
    const { app, authority } = await harness();
    const listReleaseIndexes = vi.spyOn(authority, "listReleaseIndexes").mockRejectedValue(new Error("REMOTE_INDEX_READ_MUST_NOT_RUN"));
    const listReleases = vi.spyOn(authority, "listReleases").mockRejectedValue(new Error("REMOTE_RELEASE_READ_MUST_NOT_RUN"));
    const listCourses = vi.spyOn(authority, "listCourses").mockRejectedValue(new Error("REMOTE_COURSE_READ_MUST_NOT_RUN"));
    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS_UNAVAILABLE");
      const getIndexes = (acceptEncoding: string) => new Promise<{
        headers: import("node:http").IncomingHttpHeaders;
        body: Buffer;
      }>((resolve, reject) => {
        const req = httpRequest({
          host: "127.0.0.1",
          port: address.port,
          path: "/api/v1/releases?view=index",
          headers: { "Accept-Encoding": acceptEncoding, "X-Workspace-Id": "personal" }
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
          res.on("error", reject);
        });
        req.on("error", reject);
        req.end();
      });

      const plain = await getIndexes("identity");
      const compressed = await getIndexes("gzip");
      const plainJson = JSON.parse(plain.body.toString("utf8"));
      const compressedJson = JSON.parse(gunzipSync(compressed.body).toString("utf8"));
      expect(compressedJson).toEqual(plainJson);
      expect(plain.headers["content-encoding"]).toBeUndefined();
      expect(compressed.headers["content-encoding"]).toBe("gzip");
      for (const headers of [plain.headers, compressed.headers]) {
        const vary = (headers.vary ?? "").split(",").map((value) => value.trim().toLowerCase());
        expect(vary).toContain("accept-encoding");
        expect(vary).toContain("x-workspace-id");
        expect(headers["cache-control"]).toBe("private, no-store");
      }
      expect(listReleaseIndexes).not.toHaveBeenCalled();
      expect(listReleases).not.toHaveBeenCalled();
      expect(listCourses).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

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
