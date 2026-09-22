import type { GenerationPlan, ImportRecord } from "@course-os/contracts";

/** API 可能先返回尚未进入共享契约的渐进发布字段。 */
export type WebImportRecord = ImportRecord & Record<string, unknown>;

/** The task index deliberately excludes source files and private server paths. */
export type ImportTaskSummary = Pick<ImportRecord,
  "id" | "workspaceId" | "originalName" | "state" | "createdAt"
> & Partial<Pick<ImportRecord,
  "courseId" | "parentNodeId" | "autoGenerate" | "generationState" | "pageIds" |
  "generationCompletedPageIds" | "generationFailedPageIds"
>>;

/** API 可能先返回尚未进入共享契约的渐进发布字段。 */
export type WebGenerationPlan = GenerationPlan & Record<string, unknown>;

export type ProgressCount = {
  completed: number;
  total: number;
};

export type ProgressConcurrency = {
  running?: number;
  limit?: number;
};

export type ImportProgressSummary = {
  conversion?: ProgressCount;
  core?: ProgressCount;
  crossPage?: ProgressCount;
  repairCount?: number;
  concurrency?: ProgressConcurrency;
  provider?: string;
  model?: string;
  costUsd?: number;
  costBasis?: "reported" | "estimated" | "mixed";
};
