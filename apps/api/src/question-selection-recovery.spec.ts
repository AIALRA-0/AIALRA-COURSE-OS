import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { FileReadWeaveCourseApi } from "@course-os/readweave-adapter";
import type { CourseProject, CourseRelease, IdempotentWriteContext, LessonDraft, QuestionBankItem, QuestionSelection, ReleaseManifest } from "@course-os/contracts";
import { createApp, createDefaultDependencies } from "./app.js";

const writeContext = (idempotencyKey: string): IdempotentWriteContext => ({
  idempotencyKey, actor: "test", workspaceId: "personal", schemaVersion: "2.1.0", requestId: idempotencyKey
});

describe("question selection recovery", () => {
  it("grades the saved snapshot after restart and keeps selection refresh stable", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-question-recovery-"));
    const readweave = new FileReadWeaveCourseApi(join(root, "readweave.json"));
    const release = testRelease();
    const course: CourseProject = {
      id: release.courseId, workspaceId: "personal", title: release.courseTitle, status: "active",
      createdAt: release.publishedAt, updatedAt: release.publishedAt
    };
    await readweave.createCourse(course, writeContext("seed-course"));
    await readweave.publishRelease(release, testManifest(release.id), writeContext("seed-release"));

    const firstApp = createApp(createDefaultDependencies(root, readweave));
    const session = await request(firstApp).post("/api/v1/sessions").send({ courseReleaseId: release.id }).expect(201);
    const selected = await request(firstApp).post("/api/v1/pages/page-1/questions:select")
      .set("Idempotency-Key", "select-old-bank")
      .send({ sessionId: session.body.id, seed: "recover-this-batch", count: 2 }).expect(201);
    const selectedQuestion = selected.body.questions[0] as QuestionBankItem;
    const savedSelection = selected.body.selection as QuestionSelection;
    expect(savedSelection.questionSnapshots?.find((item) => item.id === selectedQuestion.id)?.version).toBe(1);

    const changedPage = structuredClone(release.pages[0]!);
    changedPage.questionBank = changedPage.questionBank!.map((item) => item.id === selectedQuestion.id
      ? { ...item, version: 2, expectedAnswer: "new answer", options: ["new answer", "old answer"] }
      : item);
    const draft: LessonDraft = {
      id: "draft:page-1", workspaceId: "personal", courseId: release.courseId, moduleId: release.moduleId,
      sourceReleaseId: release.id, pageId: "page-1", revision: 0, status: "ready", page: changedPage,
      changedBlockIds: [], contentHash: "changed-question-version", updatedAt: new Date().toISOString()
    };
    await readweave.saveDraft(draft, 0, writeContext("save-changed-question"));

    // Recreate the API and operational store so the in-memory selection map is empty.
    const restartedApp = createApp(createDefaultDependencies(root, readweave));
    const graded = await request(restartedApp).post("/api/v1/question-attempts")
      .set("Idempotency-Key", "grade-saved-question")
      .send({
        selectionId: savedSelection.id, sessionId: session.body.id, courseReleaseId: release.id,
        pageId: "page-1", questionId: selectedQuestion.id, questionVersion: 1, answer: "old answer", usedHintLevel: 0
      }).expect(201);
    expect(graded.body.attempt).toMatchObject({ questionId: selectedQuestion.id, questionVersion: 1, correct: true });

    const refreshed = await request(restartedApp).post("/api/v1/pages/page-1/questions:select")
      .set("Idempotency-Key", "refresh-saved-batch")
      .send({ sessionId: session.body.id, seed: "recover-this-batch", count: 2 }).expect(201);
    expect(refreshed.body.selection.id).toBe(savedSelection.id);
    expect(refreshed.body.questions).toEqual(selected.body.questions);

    const otherSession = await request(restartedApp).post("/api/v1/sessions").send({ courseReleaseId: release.id }).expect(201);
    await request(restartedApp).post("/api/v1/question-attempts")
      .set("Idempotency-Key", "reject-selection-from-other-session")
      .send({
        selectionId: savedSelection.id, sessionId: otherSession.body.id, courseReleaseId: release.id,
        pageId: "page-1", questionId: selectedQuestion.id, questionVersion: 1, answer: "old answer", usedHintLevel: 0
      }).expect(409);

    const legacySelection: QuestionSelection = {
      id: "legacy-selection", sessionId: session.body.id, courseReleaseId: release.id, pageId: "page-1",
      seed: "legacy", questionIds: [selectedQuestion.id], createdAt: new Date().toISOString()
    };
    await readweave.saveQuestionSelection(legacySelection, writeContext("save-legacy-selection"));
    const beforeLegacy = await readweave.listQuestionAttempts();
    await request(restartedApp).post("/api/v1/question-attempts")
      .set("Idempotency-Key", "reject-stale-legacy-version")
      .send({
        selectionId: legacySelection.id, sessionId: session.body.id, courseReleaseId: release.id,
        pageId: "page-1", questionId: selectedQuestion.id, questionVersion: 1, answer: "old answer", usedHintLevel: 0
      }).expect(409);
    expect(await readweave.listQuestionAttempts()).toHaveLength(beforeLegacy.length);

    await request(restartedApp).post("/api/v1/question-attempts")
      .set("Idempotency-Key", "accept-matching-legacy-version")
      .send({
        selectionId: legacySelection.id, sessionId: session.body.id, courseReleaseId: release.id,
        pageId: "page-1", questionId: selectedQuestion.id, questionVersion: 2, answer: "new answer", usedHintLevel: 0
      }).expect(201);

    await request(restartedApp).post("/api/v1/question-attempts")
      .set("Idempotency-Key", "reject-unknown-selection")
      .send({
        selectionId: "missing-selection", sessionId: session.body.id, courseReleaseId: release.id,
        pageId: "page-1", questionId: selectedQuestion.id, questionVersion: 2, answer: "new answer", usedHintLevel: 0
      }).expect(409);
    expect(await readweave.listQuestionAttempts()).toHaveLength(beforeLegacy.length + 1);
  });
});

function testRelease(): CourseRelease {
  const pageId = "page-1";
  const questionBank: QuestionBankItem[] = ["q1", "q2"].map((id, index) => ({
    id, pageId, objectiveId: "objective-1", kind: "multiple_choice", prompt: `Question ${index + 1}`,
    options: ["old answer", "other answer"], expectedAnswer: "old answer", explanation: "Check the saved explanation.",
    sourceAnchorIds: [], status: "approved", version: 1, generatedBy: "test"
  }));
  return {
    id: "recovery-release", courseId: "recovery-course", courseTitle: "Recovery test", moduleId: "module-1",
    moduleTitle: "Module", version: 1, publishedAt: "2026-09-30T00:00:00.000Z", pageIds: [pageId],
    pages: [{
      id: pageId, pageNumber: 1, title: "Question recovery", imageUrl: "", anchors: [], atoms: [], blocks: [],
      questionBank, coverageRequirements: [], coverageClaims: [],
      quality: { highRiskCoverage: 1, generalCoverage: 1, mathValid: true, publishable: true, issues: [] }
    }],
    assessments: [], manifestHash: "recovery-manifest", writingPolicySnapshotId: "policy", modelRoute: "test",
    qualityHarnessVersion: "test", costUsd: 0, lifecycle: "published"
  };
}

function testManifest(releaseId: string): ReleaseManifest {
  return {
    id: `${releaseId}:manifest`, schemaVersion: "2.1.0", courseReleaseId: releaseId,
    sourceHashes: [], pageHashes: [], explanationHashes: [], assessmentHashes: [],
    writingPolicySnapshotId: "policy", modelRoutes: ["test"], qualityHarnessVersion: "test", costInputs: [],
    createdAt: "2026-09-30T00:00:00.000Z"
  };
}
