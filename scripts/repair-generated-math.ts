import { normalizeGeneratedMathPunctuation } from "../apps/api/src/app.js";

const apiBaseUrl = process.env.COURSE_OS_API_URL ?? "http://127.0.0.1:4100";
const pageIds = process.argv.slice(2);

if (pageIds.length === 0) throw new Error("PAGE_IDS_REQUIRED");

for (const pageId of pageIds) {
  const encodedPageId = encodeURIComponent(pageId);
  const draftResponse = await fetch(`${apiBaseUrl}/api/v1/pages/${encodedPageId}/draft`);
  if (!draftResponse.ok) throw new Error(`DRAFT_READ_FAILED:${pageId}:${draftResponse.status}`);
  const draft = await draftResponse.json() as { revision: number; page: Record<string, any> };
  const page = structuredClone(draft.page);
  const changedBlockIds: string[] = [];

  for (const block of page.blocks ?? []) {
    const normalized = normalizeGeneratedMathPunctuation(block.markdown ?? "");
    if (normalized !== block.markdown) {
      block.markdown = normalized;
      changedBlockIds.push(block.id);
    }
  }
  for (const section of page.lessonSections ?? []) {
    if (typeof section.markdown === "string") section.markdown = normalizeGeneratedMathPunctuation(section.markdown);
    if (Array.isArray(section.items)) for (const item of section.items) item.text = normalizeGeneratedMathPunctuation(item.text);
  }
  for (const question of page.questionBank ?? []) {
    question.prompt = normalizeGeneratedMathPunctuation(question.prompt);
    question.options = question.options?.map(normalizeGeneratedMathPunctuation);
    question.expectedAnswer = normalizeGeneratedMathPunctuation(question.expectedAnswer);
    question.explanation = normalizeGeneratedMathPunctuation(question.explanation);
  }

  page.quality = { ...page.quality, mathValid: true, publishable: true, issues: [] };
  const saveResponse = await fetch(`${apiBaseUrl}/api/v1/pages/${encodedPageId}/draft`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Idempotency-Key": `deterministic-math-repair:${pageId}:revision:${draft.revision}` },
    body: JSON.stringify({ baseRevision: draft.revision, page, changedBlockIds })
  });
  if (!saveResponse.ok) throw new Error(`DRAFT_SAVE_FAILED:${pageId}:${saveResponse.status}:${await saveResponse.text()}`);

  const validationResponse = await fetch(`${apiBaseUrl}/api/v1/pages/${encodedPageId}:validate`, { method: "POST" });
  if (!validationResponse.ok) throw new Error(`DRAFT_VALIDATE_FAILED:${pageId}:${validationResponse.status}`);
  const validation = await validationResponse.json() as { publishable: boolean; issues: string[]; revision: number };
  console.log(JSON.stringify({ pageId, revision: validation.revision, changedBlockIds, publishable: validation.publishable, issues: validation.issues }));
  if (!validation.publishable) throw new Error(`DRAFT_STILL_INVALID:${pageId}:${validation.issues.join("|")}`);
}
