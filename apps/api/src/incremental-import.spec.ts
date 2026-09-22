import { describe, expect, it } from "vitest";
import type { CourseRelease, LessonDraft, PageLesson } from "@course-os/contracts";
import { prepareIncrementalVersion, planIncrementalPages, type IncomingPage } from "./incremental-import.js";

const hash = (character: string) => character.repeat(64);

function page(pageId: string, pageNumber: number, title: string, text: string, imageSha256: string): PageLesson {
  const anchorId = `${pageId}:text`;
  const blockId = `${pageId}:explanation`;
  return {
    id: pageId,
    pageNumber,
    title,
    imageUrl: `/api/v1/media/${imageSha256}`,
    anchors: [{ id: anchorId, pageId, kind: "text", label: `第 ${pageNumber} 页文本`, text }],
    atoms: [],
    blocks: [{ id: blockId, title: "讲解", kind: "core", markdown: `讲解：${text}`, sourceAnchorIds: [anchorId], atomIds: [] }],
    coverageRequirements: [],
    coverageClaims: [],
    quality: { highRiskCoverage: 1, generalCoverage: 1, mathValid: true, publishable: true, issues: [] }
  };
}

function release(pages: PageLesson[]): CourseRelease {
  return {
    id: "source-old",
    courseId: "course-1",
    courseTitle: "示例课程",
    moduleId: "module-1",
    moduleTitle: "示例材料",
    version: 1,
    publishedAt: "2026-09-22T00:00:00.000Z",
    pageIds: pages.map((item) => item.id),
    pages,
    assessments: [],
    manifestHash: hash("f"),
    writingPolicySnapshotId: "policy-1",
    modelRoute: "test",
    qualityHarnessVersion: "test",
    costUsd: 0,
    lifecycle: "draft_source"
  };
}

function draft(source: CourseRelease, sourcePage: PageLesson, markdown = `保留的讲解：${sourcePage.title}`): LessonDraft {
  const lesson = structuredClone(sourcePage);
  lesson.blocks[0]!.markdown = markdown;
  return {
    id: `draft:${sourcePage.id}`,
    workspaceId: "workspace-1",
    courseId: source.courseId,
    moduleId: source.moduleId,
    sourceReleaseId: source.id,
    pageId: sourcePage.id,
    revision: 3,
    status: "ready",
    page: lesson,
    changedBlockIds: [lesson.blocks[0]!.id],
    contentHash: "old-content-hash",
    updatedAt: "2026-09-22T00:00:00.000Z"
  };
}

function incoming(pages: PageLesson[]): IncomingPage[] {
  return pages.map((item) => ({
    title: item.title,
    text: item.anchors.find((anchor) => anchor.kind === "text")?.text ?? "",
    imageSha256: item.imageUrl.split("/").at(-1)!
  }));
}

const createdAt = "2026-09-22T01:00:00.000Z";

describe("incremental PPT insertion and append planning", () => {
  it("keeps matched page identity in the mapping and regenerates only inserted pages plus direct neighbors", () => {
    const oldPages = [page("old:1", 1, "A", "alpha", hash("a")), page("old:2", 2, "B", "beta", hash("b")), page("old:3", 3, "C", "gamma", hash("c"))];
    const nextPages = [oldPages[0]!, page("new:x", 2, "X", "inserted", hash("d")), oldPages[1]!, oldPages[2]!]
      .map((item, index) => ({ ...structuredClone(item), pageNumber: index + 1 }));
    const result = planIncrementalPages(release(oldPages), incoming(nextPages));

    expect(result.matches.map((match) => match.previousPageId ?? null)).toEqual(["old:1", null, "old:2", "old:3"]);
    expect(result.insertedPageNumbers).toEqual([2]);
    expect(result.regenerationPageNumbers).toEqual([1, 2, 3]);
  });

  it("appends a page and regenerates the appended page and its preceding dependent page", () => {
    const oldPages = [page("old:1", 1, "A", "alpha", hash("a")), page("old:2", 2, "B", "beta", hash("b"))];
    const nextPages = [...oldPages, page("new:3", 3, "C", "gamma", hash("c"))];
    const result = planIncrementalPages(release(oldPages), incoming(nextPages));

    expect(result.insertedPageNumbers).toEqual([3]);
    expect(result.regenerationPageNumbers).toEqual([2, 3]);
  });

  it("detects title-only changes as source edits instead of silently treating them as unchanged", () => {
    const old = release([page("old:1", 1, "Original title", "same text", hash("a"))]);
    expect(() => planIncrementalPages(old, [{ title: "Changed title", text: "same text", imageSha256: hash("a") }]))
      .toThrow("INCREMENTAL_ONLY_INSERT_APPEND");
  });

  it("rejects page deletion and reorder because this path only supports insertion and append", () => {
    const oldPages = [page("old:1", 1, "A", "alpha", hash("a")), page("old:2", 2, "B", "beta", hash("b"))];
    expect(() => planIncrementalPages(release(oldPages), incoming([oldPages[1]!]))).toThrow("INCREMENTAL_ONLY_INSERT_APPEND");
    expect(() => planIncrementalPages(release(oldPages), incoming([...oldPages].reverse()))).toThrow("INCREMENTAL_ONLY_INSERT_APPEND");
  });

  it("rejects repeated identical slides when their old-to-new identity would be ambiguous", () => {
    const oldPages = [page("old:1", 1, "Repeat", "same", hash("a"))];
    const nextPages = [oldPages[0]!, page("new:2", 2, "Repeat", "same", hash("a"))];
    expect(() => planIncrementalPages(release(oldPages), incoming(nextPages))).toThrow("INCREMENTAL_PAGE_MATCH_AMBIGUOUS");
  });

  it("copies unchanged teaching drafts, remaps version-local references and marks only dependency pages for regeneration", () => {
    const oldPages = [page("old:1", 1, "A", "alpha", hash("a")), page("old:2", 2, "B", "beta", hash("b")), page("old:3", 3, "C", "gamma", hash("c"))];
    const oldRelease = release(oldPages);
    const oldDrafts = oldPages.map((item) => draft(oldRelease, item));
    const converted = [oldPages[0]!, page("new:x", 2, "X", "inserted", hash("d")), oldPages[1]!, oldPages[2]!]
      .map((item, index) => ({ ...structuredClone(item), pageNumber: index + 1 }));
    const prepared = prepareIncrementalVersion({
      previous: oldRelease,
      previousDrafts: oldDrafts,
      incoming: incoming(converted),
      newSourcePages: converted,
      newReleaseId: "source-new",
      newManifestHash: hash("e"),
      workspaceId: "workspace-1",
      createdAt
    });

    expect(prepared.preservedPageIds).toEqual([
      { previousPageId: "old:1", pageId: "source-new:page:1" },
      { previousPageId: "old:2", pageId: "source-new:page:3" },
      { previousPageId: "old:3", pageId: "source-new:page:4" }
    ]);
    expect(prepared.generationPageIds).toEqual(["source-new:page:1", "source-new:page:2", "source-new:page:3"]);
    expect(prepared.insertedPageIds).toEqual(["source-new:page:2"]);
    expect(prepared.drafts[3]!.page.blocks[0]!.markdown).toBe("保留的讲解：C");
    expect(prepared.drafts[3]!.status).toBe("ready");
    expect(prepared.drafts[2]!.page.blocks[0]!.markdown).toBe("保留的讲解：B");
    expect(prepared.drafts[2]!.status).toBe("needs_review");
    expect(prepared.drafts[3]!.page.blocks[0]!.id).toBe("source-new:page:4:explanation");
    expect(prepared.drafts[3]!.changedBlockIds).toEqual(["source-new:page:4:explanation"]);
    expect(prepared.sourceRelease.pages.map((item) => item.pageNumber)).toEqual([1, 2, 3, 4]);
  });

  it("rejects mismatched converted pages instead of attaching old drafts to the wrong source", () => {
    const oldPages = [page("old:1", 1, "A", "alpha", hash("a"))];
    const oldRelease = release(oldPages);
    const incomingPages = [page("new:1", 1, "A", "alpha", hash("a"))];
    const mismatchedConversion = [page("new:1", 1, "A", "different text", hash("a"))];
    expect(() => prepareIncrementalVersion({
      previous: oldRelease,
      previousDrafts: [draft(oldRelease, oldPages[0]!)],
      incoming: incoming(incomingPages),
      newSourcePages: mismatchedConversion,
      newReleaseId: "source-new",
      newManifestHash: hash("e"),
      workspaceId: "workspace-1",
      createdAt
    })).toThrow("INCREMENTAL_CONVERTED_SOURCE_MISMATCH");
  });

  it("queues a matched page whose old draft is missing instead of silently leaving it ungenerated", () => {
    const oldPages = [page("old:1", 1, "A", "alpha", hash("a")), page("old:2", 2, "B", "beta", hash("b"))];
    const oldRelease = release(oldPages);
    const prepared = prepareIncrementalVersion({
      previous: oldRelease,
      previousDrafts: [draft(oldRelease, oldPages[0]!)],
      incoming: incoming(oldPages),
      newSourcePages: oldPages,
      newReleaseId: "source-new",
      newManifestHash: hash("e"),
      workspaceId: "workspace-1",
      createdAt
    });

    expect(prepared.generationPageIds).toEqual(["source-new:page:2"]);
    expect(prepared.drafts[1]!.status).toBe("needs_review");
  });
});
