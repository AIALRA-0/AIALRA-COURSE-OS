import type { CourseRelease, LessonDraft, PageLesson } from "@course-os/contracts";
import { sha256Text, stableStringify } from "@course-os/domain";

export interface IncomingPage {
  title: string;
  text: string;
  imageSha256: string;
}

export interface IncrementalPageMatch {
  pageNumber: number;
  previousPageId?: string;
  regenerate: boolean;
}

export interface IncrementalPagePlan {
  matches: IncrementalPageMatch[];
  insertedPageNumbers: number[];
  regenerationPageNumbers: number[];
}

function sourceText(page: PageLesson): string {
  return page.anchors.find((anchor) => anchor.kind === "text")?.text ?? "";
}

function imageHash(page: PageLesson): string {
  const hash = /^\/api\/v1\/media\/([a-f0-9]{64})$/.exec(page.imageUrl)?.[1];
  if (!hash) throw new Error("INCREMENTAL_SOURCE_IMAGE_UNAVAILABLE");
  return hash;
}

function normalizeText(text: string): string {
  // Imported pages are persisted with the same limit by createImportedPage.
  return text.slice(0, 40_000).replace(/\s+/g, " ").trim();
}

function fingerprint(title: string, text: string, imageSha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(imageSha256)) throw new Error("INCREMENTAL_SOURCE_IMAGE_UNAVAILABLE");
  return sha256Text(stableStringify({
    title: title.replace(/\s+/g, " ").trim(),
    text: normalizeText(text),
    imageSha256
  }));
}

/** A page number is deliberately absent: inserted slides may shift every later number. */
export function planIncrementalPages(previous: CourseRelease, incoming: IncomingPage[]): IncrementalPagePlan {
  if (previous.lifecycle !== "draft_source" || previous.pages.length === 0 || incoming.length === 0
    || previous.pageIds.length !== previous.pages.length
    || previous.pages.some((page, index) => previous.pageIds[index] !== page.id)) {
    throw new Error("INCREMENTAL_SOURCE_INVALID");
  }
  const oldKeys = previous.pages.map((page) => fingerprint(page.title, sourceText(page), imageHash(page)));
  const newKeys = incoming.map((page) => fingerprint(page.title, page.text, page.imageSha256));
  if (newKeys.length < oldKeys.length) throw new Error("INCREMENTAL_ONLY_INSERT_APPEND");

  // Repeated identical slides have no reliable identity after another copy is inserted.
  // Refuse the update instead of attaching a generated explanation to the wrong copy.
  const oldCounts = new Map<string, number>();
  const newCounts = new Map<string, number>();
  for (const key of oldKeys) oldCounts.set(key, (oldCounts.get(key) ?? 0) + 1);
  for (const key of newKeys) newCounts.set(key, (newCounts.get(key) ?? 0) + 1);
  if (oldKeys.some((key) => (oldCounts.get(key) ?? 0) !== (newCounts.get(key) ?? 0) && ((oldCounts.get(key) ?? 0) > 1 || (newCounts.get(key) ?? 0) > 1))) {
    throw new Error("INCREMENTAL_PAGE_MATCH_AMBIGUOUS");
  }

  const matches: IncrementalPageMatch[] = newKeys.map((_, index) => ({ pageNumber: index + 1, regenerate: false }));
  let nextIndex = 0;
  for (let oldIndex = 0; oldIndex < oldKeys.length; oldIndex += 1) {
    while (nextIndex < newKeys.length && newKeys[nextIndex] !== oldKeys[oldIndex]) nextIndex += 1;
    if (nextIndex === newKeys.length) throw new Error("INCREMENTAL_ONLY_INSERT_APPEND");
    matches[nextIndex]!.previousPageId = previous.pages[oldIndex]!.id;
    nextIndex += 1;
  }
  const insertedPageNumbers = matches.filter((item) => !item.previousPageId).map((item) => item.pageNumber);
  const regenerate = new Set(insertedPageNumbers);
  for (let index = 0; index < matches.length; index += 1) {
    if (matches[index]!.previousPageId) continue;
    if (matches[index - 1]?.previousPageId) regenerate.add(index);
    if (matches[index + 1]?.previousPageId) regenerate.add(index + 2);
  }
  for (const match of matches) match.regenerate = regenerate.has(match.pageNumber);
  return { matches, insertedPageNumbers, regenerationPageNumbers: [...regenerate].sort((a, b) => a - b) };
}

function movePage(page: PageLesson, pageId: string, pageNumber: number): PageLesson {
  const oldId = page.id;
  const remap = (value: unknown): unknown => {
    if (typeof value === "string") return value === oldId || value.startsWith(`${oldId}:`)
      ? `${pageId}${value.slice(oldId.length)}` : value;
    if (Array.isArray(value)) return value.map(remap);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)]));
    return value;
  };
  const moved = remap(page) as PageLesson;
  moved.pageNumber = pageNumber;
  for (const anchor of moved.anchors) {
    if (anchor.kind === "page" || anchor.kind === "text") {
      anchor.label = anchor.kind === "page" ? `第 ${pageNumber} 页原始画面` : `第 ${pageNumber} 页离线提取文本`;
    }
  }
  return moved;
}

export interface PreparedIncrementalVersion {
  sourceRelease: CourseRelease;
  drafts: LessonDraft[];
  generationPageIds: string[];
  insertedPageIds: string[];
  /** Maps stable old page identity to its version-local page identity. */
  preservedPageIds: Array<{ previousPageId: string; pageId: string }>;
}

/** Prepare a new immutable source version; the caller persists it and starts a plan for generationPageIds. */
export function prepareIncrementalVersion(input: {
  previous: CourseRelease;
  previousDrafts: LessonDraft[];
  incoming: IncomingPage[];
  newSourcePages: PageLesson[];
  newReleaseId: string;
  newManifestHash: string;
  workspaceId: string;
  createdAt: string;
}): PreparedIncrementalVersion {
  const { previous, previousDrafts, incoming, newSourcePages, newReleaseId, workspaceId, createdAt } = input;
  if (newReleaseId.trim() !== newReleaseId || newReleaseId === previous.id || newSourcePages.length !== incoming.length || !newReleaseId
    || !/^[a-f0-9]{64}$/.test(input.newManifestHash)) {
    throw new Error("INCREMENTAL_VERSION_INVALID");
  }
  const plan = planIncrementalPages(previous, incoming);
  const convertedKeys = newSourcePages.map((page) => fingerprint(page.title, sourceText(page), imageHash(page)));
  const incomingKeys = incoming.map((page) => fingerprint(page.title, page.text, page.imageSha256));
  if (convertedKeys.some((key, index) => key !== incomingKeys[index])) throw new Error("INCREMENTAL_CONVERTED_SOURCE_MISMATCH");

  const oldDrafts = new Map<string, LessonDraft>();
  for (const draft of previousDrafts) {
    if (oldDrafts.has(draft.pageId)) throw new Error("INCREMENTAL_PREVIOUS_DRAFT_AMBIGUOUS");
    oldDrafts.set(draft.pageId, draft);
  }
  const oldPages = new Map(previous.pages.map((page) => [page.id, page]));
  const pages: PageLesson[] = [];
  const drafts: LessonDraft[] = [];
  const preservedPageIds: PreparedIncrementalVersion["preservedPageIds"] = [];
  for (const match of plan.matches) {
    const index = match.pageNumber - 1;
    const pageId = `${newReleaseId}:page:${match.pageNumber}`;
    const oldPage = match.previousPageId ? oldPages.get(match.previousPageId) : undefined;
    const oldDraft = match.previousPageId ? oldDrafts.get(match.previousPageId) : undefined;
    if (oldDraft && (!oldPage || oldDraft.sourceReleaseId !== previous.id || oldDraft.courseId !== previous.courseId
      || oldDraft.workspaceId !== workspaceId || oldDraft.page.id !== oldDraft.pageId)) {
      throw new Error("INCREMENTAL_PREVIOUS_DRAFT_UNAVAILABLE");
    }
    // The new source object comes from this upload. Matched pages are content-identical,
    // while using the converted object keeps all source anchors tied to this version.
    const sourcePage = movePage(newSourcePages[index]!, pageId, match.pageNumber);
    pages.push(sourcePage);
    const lessonPage = movePage(oldDraft?.page ?? sourcePage, pageId, match.pageNumber);
    if (oldPage) preservedPageIds.push({ previousPageId: oldPage.id, pageId });
    drafts.push({
      id: `draft:${pageId}`,
      workspaceId,
      courseId: previous.courseId,
      moduleId: previous.moduleId,
      sourceReleaseId: newReleaseId,
      pageId,
      revision: 0,
      status: match.regenerate ? "needs_review" : oldDraft?.status ?? "needs_review",
      page: lessonPage,
      changedBlockIds: oldDraft
        ? oldDraft.changedBlockIds.map((id) => id === oldDraft.pageId || id.startsWith(`${oldDraft.pageId}:`)
          ? `${pageId}${id.slice(oldDraft.pageId.length)}`
          : id)
        : lessonPage.blocks.map((block) => block.id),
      contentHash: sha256Text(stableStringify(lessonPage)),
      updatedAt: createdAt
    });
  }
  const sourceRelease: CourseRelease = {
    ...previous,
    id: newReleaseId,
    version: previous.version + 1,
    publishedAt: createdAt,
    pageIds: pages.map((page) => page.id),
    pages,
    assessments: [],
    manifestHash: input.newManifestHash,
    costUsd: 0,
    lifecycle: "draft_source"
  };
  const regenerationIds = new Set(plan.regenerationPageNumbers.map((number) => pages[number - 1]!.id));
  for (const match of plan.matches) {
    if (match.previousPageId && !oldDrafts.has(match.previousPageId)) regenerationIds.add(pages[match.pageNumber - 1]!.id);
  }
  return {
    sourceRelease,
    drafts,
    generationPageIds: pages.filter((page) => regenerationIds.has(page.id)).map((page) => page.id),
    insertedPageIds: plan.insertedPageNumbers.map((number) => pages[number - 1]!.id),
    preservedPageIds
  };
}
