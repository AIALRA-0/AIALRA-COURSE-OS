import type { CourseRelease, PageLesson, SelfRetelling } from "@course-os/contracts";

export type SelfRetellingCard = {
  release: CourseRelease;
  page: PageLesson;
  retelling: SelfRetelling;
};

export function readingProgress(pageIds: string[], retellings: SelfRetelling[]): { answered: number; total: number; percent: number } {
  const pageSet = new Set(pageIds);
  const answered = new Set(retellings.filter((item) => pageSet.has(item.pageId) && item.answer.trim().length > 0).map((item) => item.pageId)).size;
  const total = pageSet.size;
  return { answered, total, percent: total ? Math.round(answered / total * 100) : 0 };
}

export function selfRetellingCards(releases: CourseRelease[], retellings: SelfRetelling[], now = Date.now(), dueOnly = true): SelfRetellingCard[] {
  const byKey = new Map(retellings.map((item) => [`${item.releaseId}\u0000${item.pageId}`, item]));
  return releases.flatMap((release) => release.pages.flatMap((page) => {
    const retelling = byKey.get(`${release.id}\u0000${page.id}`);
    if (!retelling?.answer.trim()) return [];
    const dueAt = Date.parse(retelling.nextReviewAt ?? retelling.answeredAt);
    if (dueOnly && Number.isFinite(dueAt) && dueAt > now) return [];
    return [{ release, page, retelling }];
  })).sort((a, b) => Date.parse(a.retelling.nextReviewAt ?? a.retelling.answeredAt) - Date.parse(b.retelling.nextReviewAt ?? b.retelling.answeredAt));
}
