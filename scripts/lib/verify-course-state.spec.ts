import { describe, expect, it } from "vitest";
import type { CourseRelease, LessonDraft, PageLesson } from "@course-os/contracts";
import { EMPTY_STATE, type ReadWeaveFileState } from "@course-os/readweave-adapter";
import { inspectCourseState } from "./verify-course-state.js";

describe("generic course state verification", () => {
  it("selects a complete readable draft source through runtime tree identity", () => {
    const state = emptyState();
    const older = release(1, "published", "synthetic-v1");
    const current = release(2, "draft_source", "synthetic-v2");
    state.releases = [older, current];
    state.drafts = [draftFor(current)];

    const inspection = inspectCourseState(state, "synthetic");

    expect(inspection.currentMaterials).toHaveLength(1);
    expect(inspection.currentMaterials[0]).toMatchObject({
      materialId: "material:synthetic-course:module-a",
      releaseId: current.id,
      version: 2,
      lifecycle: "draft_source"
    });
    expect(inspection.issues).toEqual([]);
  });

  it("fails synthetic empty scopes and catches page/version/pointer inconsistencies", () => {
    const empty = inspectCourseState(emptyState(), "synthetic");
    expect(empty.issues.map((issue) => issue.code)).toContain("SYNTHETIC_SCOPE_EMPTY");

    const state = emptyState();
    const first = release(1, "published", "synthetic-v1");
    const duplicateVersion = release(1, "published", "synthetic-v1-duplicate");
    duplicateVersion.pages[0]!.pageNumber = 2;
    duplicateVersion.pageIds = [];
    state.releases = [first, duplicateVersion];
    state.treeNodes = [{
      id: "material:synthetic-course:module-a",
      materialId: "material:synthetic-course:module-a",
      kind: "material",
      title: "Synthetic module",
      currentReleaseId: "missing-release",
      releaseId: "missing-release",
      pageCount: 9,
      children: []
    }];

    const inspection = inspectCourseState(state, "synthetic");
    const codes = inspection.issues.map((issue) => issue.code);
    expect(codes).toContain("DUPLICATE_RELEASE_VERSION:1");
    expect(codes).toContain("RELEASE_PAGE_IDS_MISMATCH");
    expect(codes).toContain("RELEASE_PAGE_NUMBERS_NOT_CONTIGUOUS");
    expect(codes).toContain("CURRENT_RELEASE_POINTER_INVALID");
    expect(codes).toContain("TREE_RELEASE_POINTER_STALE");
    expect(codes).toContain("TREE_PAGE_COUNT_STALE");
  });
});

function emptyState(): ReadWeaveFileState {
  return structuredClone(EMPTY_STATE);
}

function release(version: number, lifecycle: "published" | "draft_source", id: string): CourseRelease {
  const lesson = page(`${id}:page:1`);
  return {
    id,
    courseId: "synthetic-course",
    courseTitle: "Synthetic Course",
    moduleId: "module-a",
    moduleTitle: "Synthetic Module",
    version,
    publishedAt: `2026-10-02T00:00:0${version}.000Z`,
    pageIds: [lesson.id],
    pages: [lesson],
    assessments: [],
    manifestHash: "fixture-hash",
    writingPolicySnapshotId: "fixture-policy",
    modelRoute: "fixture-no-provider",
    qualityHarnessVersion: "fixture-only",
    costUsd: 0,
    lifecycle
  };
}

function draftFor(source: CourseRelease): LessonDraft {
  const sourcePage = source.pages[0]!;
  return {
    id: `${source.id}:draft:${sourcePage.id}`,
    workspaceId: "personal",
    courseId: source.courseId,
    moduleId: source.moduleId,
    sourceReleaseId: source.id,
    pageId: sourcePage.id,
    revision: 1,
    status: "ready",
    page: sourcePage,
    changedBlockIds: [],
    contentHash: "fixture-content-hash",
    updatedAt: source.publishedAt
  };
}

function page(id: string): PageLesson {
  return {
    id,
    pageNumber: 1,
    title: "Synthetic lesson",
    imageUrl: "/api/v1/media/fixture",
    anchors: [],
    atoms: [],
    blocks: [{ id: `${id}:core`, title: "Core", kind: "core", markdown: "A complete synthetic lesson body.", sourceAnchorIds: [], atomIds: [] }],
    questionBank: [],
    coverageRequirements: [],
    coverageClaims: [],
    quality: { highRiskCoverage: 1, generalCoverage: 1, mathValid: true, publishable: true, issues: [] }
  };
}
