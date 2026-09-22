import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { CourseRelease } from "@course-os/contracts";
import type { AppDependencies } from "./app.js";
import { registerSelfRetellingRoutes } from "./self-retelling-routes.js";

function harness() {
  const release = { id: "release-1", courseId: "course-1", pageIds: ["page-1"], pages: [] } as unknown as CourseRelease;
  const state = { selfRetellings: {} as Record<string, any>, idempotency: {} as Record<string, { kind: string; objectId: string }> };
  const dependencies = {
    readweave: {
      getRelease: async (id: string) => id === release.id ? release : undefined,
      listCourses: async () => [{ id: "course-1", workspaceId: "personal" }]
    },
    operations: {
      read: async () => state,
      urgentMutate: async <T>(change: (value: typeof state) => T) => change(state)
    }
  } as unknown as AppDependencies;
  const app = express();
  app.use(express.json());
  registerSelfRetellingRoutes(app, dependencies);
  return { app, state };
}

function writeHeaders(key: string) {
  return { "X-Workspace-Id": "personal", "X-Actor": "test-user", "X-Request-Id": `request-${key}`, "X-Schema-Version": "2.4.0", "Idempotency-Key": key };
}

describe("self retelling routes", () => {
  it("persists one release-page answer and lists it for reading progress", async () => {
    const { app, state } = harness();
    const saved = await request(app).put("/api/v1/self-retellings/release-1/page-1").set(writeHeaders("answer-1")).send({ answer: "我能用自己的话解释这一页的主要关系" }).expect(200);
    expect(saved.body).toMatchObject({ workspaceId: "personal", releaseId: "release-1", pageId: "page-1", answer: "我能用自己的话解释这一页的主要关系" });
    expect(Object.keys(state.selfRetellings)).toHaveLength(1);
    expect((await request(app).get("/api/v1/self-retellings?releaseId=release-1").set("X-Workspace-Id", "personal").expect(200)).body).toHaveLength(1);
  });

  it("replays an idempotent write without creating a second record", async () => {
    const { app, state } = harness();
    const path = "/api/v1/self-retellings/release-1/page-1";
    const headers = writeHeaders("answer-replay");
    await request(app).put(path).set(headers).send({ answer: "第一次提交" }).expect(200);
    const replay = await request(app).put(path).set(headers).send({ answer: "重放请求" }).expect(200);
    expect(replay.body.answer).toBe("第一次提交");
    expect(Object.keys(state.selfRetellings)).toHaveLength(1);
  });

  it("rejects invalid, unowned, and unverified writes", async () => {
    const { app } = harness();
    await request(app).put("/api/v1/self-retellings/release-1/page-1").set(writeHeaders("empty-answer")).send({ answer: " " }).expect(422);
    await request(app).put("/api/v1/self-retellings/release-1/foreign-page").set(writeHeaders("foreign-page")).send({ answer: "回答" }).expect(404);
    await request(app).put("/api/v1/self-retellings/release-1/page-1").set({ "Idempotency-Key": "missing-context" }).send({ answer: "回答" }).expect(400);
  });

  it("schedules an answered card for ten minutes or one day after rating", async () => {
    const { app } = harness();
    const path = "/api/v1/self-retellings/release-1/page-1";
    await request(app).put(path).set(writeHeaders("answer-before-review")).send({ answer: "完整回答" }).expect(200);
    const beforeAgain = Date.now();
    const again = await request(app).post(`${path}/review`).set(writeHeaders("rating-again")).send({ result: "again" }).expect(200);
    const againDelay = Date.parse(again.body.nextReviewAt) - beforeAgain;
    expect(againDelay).toBeGreaterThanOrEqual(9 * 60_000);
    expect(againDelay).toBeLessThanOrEqual(11 * 60_000);
    const beforeRemembered = Date.now();
    const remembered = await request(app).post(`${path}/review`).set(writeHeaders("rating-remembered")).send({ result: "remembered" }).expect(200);
    const rememberedDelay = Date.parse(remembered.body.nextReviewAt) - beforeRemembered;
    expect(rememberedDelay).toBeGreaterThanOrEqual(23 * 60 * 60_000);
    expect(rememberedDelay).toBeLessThanOrEqual(25 * 60 * 60_000);
  });
});
