import type { Express, Request, Response } from "express";
import type { CourseRelease, SelfRetelling } from "@course-os/contracts";
import type { AppDependencies } from "./app.js";

const recordKey = (workspaceId: string, releaseId: string, pageId: string) => JSON.stringify([workspaceId, releaseId, pageId]);

function problem(response: Response, status: number, code: string, message: string) {
  return response.status(status).json({ error: { code, message, retryable: status >= 500 } });
}

async function ownedPage(dependencies: AppDependencies, workspaceId: string, releaseId: string, pageId: string): Promise<CourseRelease | undefined> {
  const release = await dependencies.readweave.getRelease(releaseId);
  if (!release?.pageIds.includes(pageId)) return undefined;
  const courses = await dependencies.readweave.listCourses();
  return courses.some(course => course.id === release.courseId && course.workspaceId === workspaceId) ? release : undefined;
}

function headers(request: Request, response: Response): { workspaceId: string; idempotencyKey: string } | undefined {
  const workspaceId = request.header("X-Workspace-Id") || "personal";
  const idempotencyKey = request.header("Idempotency-Key")?.trim();
  if (!idempotencyKey || !request.header("X-Actor") || !request.header("X-Request-Id") || request.header("X-Schema-Version") !== "2.4.0") {
    problem(response, 400, "WRITE_HEADERS_REQUIRED", "保存缺少必要请求信息，请刷新后重试");
    return undefined;
  }
  return { workspaceId, idempotencyKey };
}

/** Mounted by server.ts after the existing Course OS routes and before listen. */
export function registerSelfRetellingRoutes(app: Express, dependencies: AppDependencies): void {
  app.get("/api/v1/self-retellings", async (request, response) => {
    try {
      const workspaceId = request.header("X-Workspace-Id") || "personal";
      const releaseId = typeof request.query.releaseId === "string" ? request.query.releaseId : undefined;
      const records = Object.values((await dependencies.operations.read()).selfRetellings)
        .filter(record => record.workspaceId === workspaceId && (!releaseId || record.releaseId === releaseId));
      response.json(records);
    } catch { problem(response, 503, "RETELLINGS_UNAVAILABLE", "暂时无法读取自我重述，请重试"); }
  });

  app.put("/api/v1/self-retellings/:releaseId/:pageId", async (request, response) => {
    try {
      const context = headers(request, response);
      if (!context) return;
      const answer = typeof request.body.answer === "string" ? request.body.answer.trim() : "";
      if (!answer || answer.length > 12_000) return problem(response, 422, "RETELLING_INVALID", "请填写不超过 12000 字的自我重述");
      const { releaseId, pageId } = request.params;
      if (!await ownedPage(dependencies, context.workspaceId, releaseId, pageId)) return problem(response, 404, "PAGE_NOT_FOUND", "找不到当前课程页面");
      const key = recordKey(context.workspaceId, releaseId, pageId);
      const replayKey = `self-retelling:${context.workspaceId}:${context.idempotencyKey}`;
      const result = await dependencies.operations.urgentMutate(state => {
        const replay = state.idempotency[replayKey];
        if (replay) {
          if (replay.kind !== "self_retelling" || replay.objectId !== key) throw new Error("IDEMPOTENCY_CONFLICT");
          return state.selfRetellings[key];
        }
        const now = new Date().toISOString();
        const previous = state.selfRetellings[key];
        const record: SelfRetelling = {
          workspaceId: context.workspaceId, releaseId, pageId, answer,
          answeredAt: previous?.answeredAt ?? now, updatedAt: now,
          reviewedAt: previous?.reviewedAt, nextReviewAt: now
        };
        state.selfRetellings[key] = record;
        state.idempotency[replayKey] = { kind: "self_retelling", objectId: key };
        return record;
      });
      response.json(result);
    } catch (error) {
      if ((error as Error).message === "IDEMPOTENCY_CONFLICT") return problem(response, 409, "IDEMPOTENCY_CONFLICT", "本次提交编号已被其他操作使用");
      problem(response, 503, "RETELLING_SAVE_FAILED", "自我重述尚未保存，请重试");
    }
  });

  app.post("/api/v1/self-retellings/:releaseId/:pageId/review", async (request, response) => {
    try {
      const context = headers(request, response);
      if (!context) return;
      const { releaseId, pageId } = request.params;
      const result = request.body.result;
      if (result !== "again" && result !== "remembered") return problem(response, 422, "REVIEW_RESULT_INVALID", "请选择再复习或已记住");
      if (!await ownedPage(dependencies, context.workspaceId, releaseId, pageId)) return problem(response, 404, "PAGE_NOT_FOUND", "找不到当前课程页面");
      const key = recordKey(context.workspaceId, releaseId, pageId);
      const replayKey = `self-retelling-review:${context.workspaceId}:${context.idempotencyKey}`;
      const updated = await dependencies.operations.urgentMutate(state => {
        const previous = state.selfRetellings[key];
        if (!previous) return undefined;
        const replay = state.idempotency[replayKey];
        if (replay) {
          if (replay.kind !== "self_retelling_review" || replay.objectId !== key) throw new Error("IDEMPOTENCY_CONFLICT");
          return previous;
        }
        const now = new Date();
        const record = { ...previous, reviewedAt: now.toISOString(), nextReviewAt: new Date(now.getTime() + (result === "again" ? 10 * 60_000 : 24 * 60 * 60_000)).toISOString() };
        state.selfRetellings[key] = record;
        state.idempotency[replayKey] = { kind: "self_retelling_review", objectId: key };
        return record;
      });
      if (!updated) return problem(response, 404, "RETELLING_NOT_FOUND", "先提交自我重述，再开始卡片复习");
      response.json(updated);
    } catch (error) {
      if ((error as Error).message === "IDEMPOTENCY_CONFLICT") return problem(response, 409, "IDEMPOTENCY_CONFLICT", "本次提交编号已被其他操作使用");
      problem(response, 503, "REVIEW_SAVE_FAILED", "复习结果尚未保存，请重试");
    }
  });
}
