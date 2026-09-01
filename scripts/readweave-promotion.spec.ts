import { describe, expect, it } from "vitest";
import type { CourseRelease, LessonDraft, ReleaseManifest } from "@course-os/contracts";
import { EMPTY_STATE, type ReadWeaveFileState } from "@course-os/readweave-adapter";
import { buildPromotionPlan, selectLatestFormalReleases } from "./readweave-promotion.js";

const release = {
  id: "course-module-v4", courseId: "course", courseTitle: "Course", moduleId: "module", moduleTitle: "Module", version: 4,
  publishedAt: "2026-08-31T00:00:00.000Z", pageIds: ["page-1"], pages: [{ id: "page-1", pageNumber: 1, title: "Page", imageUrl: "/api/v1/media/hash", anchors: [], atoms: [], blocks: [], coverageRequirements: [], coverageClaims: [], quality: { highRiskCoverage: 1, generalCoverage: 1, mathValid: true, publishable: true, issues: [] } }],
  assessments: [], manifestHash: "manifest-hash", writingPolicySnapshotId: "writing-policy:test", modelRoute: "test", qualityHarnessVersion: "test", costUsd: 0
} as CourseRelease;
const manifest = { id: "manifest-1", schemaVersion: "2.4.0", courseReleaseId: release.id, sourceHashes: [], pageHashes: [], explanationHashes: [], assessmentHashes: [], writingPolicySnapshotId: release.writingPolicySnapshotId, modelRoutes: [], qualityHarnessVersion: "test", costInputs: [], createdAt: release.publishedAt } as ReleaseManifest;
const state = { ...structuredClone(EMPTY_STATE), releases: [release], manifests: [manifest] } satisfies ReadWeaveFileState;

describe("ReadWeave state promotion planning", () => {
  it("selects only the latest formal release per module", () => {
    const old = { ...release, id: "course-module-v3", version: 3 };
    const synthetic = { ...release, id: "synthetic-release", moduleId: "fixture" };
    expect(selectLatestFormalReleases({ ...state, releases: [old, release, synthetic] }).map((item) => item.id)).toEqual([release.id]);
  });

  it("creates a missing release and becomes a no-op after exact readback", () => {
    const missing = buildPromotionPlan(state, [release], [], new Map(), new Map([["page-1", undefined]]));
    expect(missing).toMatchObject({ releasesToCreate: [release.id], draftsToCreate: [], conflicts: [] });
    const draft = { id: "draft:page-1", pageId: "page-1", page: release.pages[0] } as LessonDraft;
    const exact = buildPromotionPlan(state, [release], [{ ...release, lifecycle: "published" }], new Map([[release.id, manifest]]), new Map([["page-1", draft]]));
    expect(exact).toMatchObject({ releasesToCreate: [], draftsToCreate: [], unchangedReleaseIds: [release.id], conflicts: [] });
  });

  it("stops on same release ID with a different hash", () => {
    const plan = buildPromotionPlan(state, [release], [{ ...release, courseTitle: "Changed", lifecycle: "published" }], new Map([[release.id, manifest]]), new Map());
    expect(plan.conflicts).toEqual([expect.objectContaining({ objectType: "release", objectId: release.id, code: "SAME_ID_DIFFERENT_HASH" })]);
  });

  it("creates only a missing draft for an exact existing release and preserves conflicting drafts", () => {
    const missingDraft = buildPromotionPlan(state, [release], [{ ...release, lifecycle: "published" }], new Map([[release.id, manifest]]), new Map([["page-1", undefined]]));
    expect(missingDraft.draftsToCreate).toEqual([{ releaseId: release.id, pageId: "page-1" }]);
    const conflicting = { id: "draft:page-1", pageId: "page-1", page: { ...release.pages[0], title: "Remote edit" } } as LessonDraft;
    const conflict = buildPromotionPlan(state, [release], [{ ...release, lifecycle: "published" }], new Map([[release.id, manifest]]), new Map([["page-1", conflicting]]));
    expect(conflict.conflicts).toEqual([expect.objectContaining({ objectType: "draft", objectId: "page-1", code: "SAME_PAGE_DIFFERENT_HASH" })]);
  });
});
