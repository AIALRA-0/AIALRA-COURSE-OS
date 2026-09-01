import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { CourseRelease, ReleaseManifest } from "@course-os/contracts";
import { FileReadWeaveCourseApi } from "@course-os/readweave-adapter";
import { createApp, createDefaultDependencies } from "./app.js";

describe("Course OS API route journey", () => {
  it("walks the read-only routes without leaking another workspace", async () => {
    const { app } = await seededRouteApp();
    const routes: Array<[string, string]> = [
      ["GET", "/healthz"],
      ["GET", "/api/v1/courses"],
      ["GET", "/api/v1/workspaces/personal/tree?view=library"],
      ["GET", "/api/v1/workspaces/other/tree?view=library"],
      ["GET", "/api/v1/trash"],
      ["GET", "/api/v1/settings"],
      ["GET", "/api/v1/model-providers"],
      ["GET", "/api/v1/model-providers/models"],
      ["GET", "/api/v1/model-route-policy"],
      ["GET", "/api/v1/sync/status"],
      ["GET", "/api/v1/conflicts"],
      ["GET", "/api/v1/releases"],
      ["GET", "/api/v1/costs"],
      ["GET", "/api/v1/review-map"],
      ["GET", "/api/v1/review-queue"],
      ["GET", "/api/v1/review-sessions/current"]
    ];
    for (const [method, path] of routes) {
      const response = await request(app)[method.toLowerCase() as "get"](path).expect(200);
      expect(response.headers["x-course-api-version"]).toBe("2.4.0");
    }
    const foreignTree = await request(app).get("/api/v1/workspaces/other/tree").expect(200);
    expect(foreignTree.body.courses).toEqual([]);
    expect(foreignTree.body.rootMaterials).toEqual([]);
    expect(foreignTree.body.trash.subtitle).toBe("暂时为空");
  });

  it("walks material identity, page access, CRUD, trash recovery and review preparation paths", async () => {
    const { app, release } = await seededRouteApp();
    const tree = await request(app).get("/api/v1/workspaces/personal/tree?view=library").expect(200);
    const material = tree.body.courses[0].children[0] as { id: string; revision: number; readweaveNoteId: string };
    expect(material.id).toBe(`material:${release.courseId}:${release.moduleId}`);

    const secondCourse = await request(app).post("/api/v1/courses").set("Idempotency-Key", "routes-second-course").send({ title: "第二门测试课程" }).expect(201);
    const renamed = await request(app).patch(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}`).set("Idempotency-Key", "routes-rename").send({ expectedRevision: material.revision, title: "算法材料" }).expect(200);
    const moved = await request(app).post(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}:move`).set("Idempotency-Key", "routes-move").send({ expectedRevision: renamed.body.revision, parentId: secondCourse.body.id, sortOrder: 0 }).expect(200);
    expect(moved.body.parentId).toBe(secondCourse.body.id);
    const duplicate = await request(app).post(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}:duplicate`).set("Idempotency-Key", "routes-duplicate").expect(201);
    expect(duplicate.body.kind).toBe("material");
    const trashed = await request(app).post(`/api/v1/tree/nodes/${encodeURIComponent(duplicate.body.id)}:trash`).set("Idempotency-Key", "routes-trash").expect(201);
    const restored = await request(app).post(`/api/v1/trash/${encodeURIComponent(trashed.body.id)}:restore`).set("Idempotency-Key", "routes-restore").send({ restoreMode: "root" }).expect(200);
    expect(restored.body.parentId).toBeUndefined();
    expect((await request(app).get("/api/v1/trash").expect(200)).body[0].restoreAvailable).toBe(false);

    await request(app).get(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}/properties`).expect(200);
    await request(app).get(`/api/v1/tree/nodes/${encodeURIComponent(material.id)}/versions`).expect(200);
    await request(app).get(`/api/v1/readweave/links/${encodeURIComponent(material.readweaveNoteId)}`).expect(200);
    await request(app).get("/api/v1/pages/route-page-1/draft").expect(200);
    await request(app).get("/api/v1/pages/route-page-1/lesson").expect(200);
    await request(app).post("/api/v1/pages/route-page-1:validate").expect(200);
    await request(app).get(`/api/v1/releases/${encodeURIComponent(release.id)}`).expect(200);
    await request(app).get(`/api/v1/releases/${encodeURIComponent(release.id)}/manifest`).expect(200);

    const emptyPlan = await request(app).post("/api/v1/review-plans").set("Idempotency-Key", "routes-empty-plan").send({ source: "manual", objectiveIds: [], seed: "routes", budgetUsd: 4 }).expect(422);
    expect(JSON.stringify(emptyPlan.body)).not.toContain("READWEAVE_TREE_NODE_NOT_FOUND");
    const stale = await request(app).patch("/api/v1/tree/nodes/stale-material").set("Idempotency-Key", "routes-stale").send({ expectedRevision: 0, title: "不应修改" }).expect(409);
    expect(stale.body.error.code).toBe("TREE_NODE_STALE");
    expect(stale.body.error.message).toContain("重新载入");
  });
});

async function seededRouteApp() {
  const root = await mkdtemp(join(tmpdir(), "course-os-routes-e2e-"));
  const readweave = new FileReadWeaveCourseApi(join(root, "readweave.json"));
  const release = routeRelease();
  await readweave.publishRelease(release, routeManifest(release.id), {
    idempotencyKey: "routes-seed",
    actor: "route-test",
    workspaceId: "personal",
    schemaVersion: "2.4.0",
    requestId: "routes-seed"
  });
  return { app: createApp(createDefaultDependencies(root, readweave)), release };
}

function routeRelease(): CourseRelease {
  return {
    id: "routes-release-v1",
    courseId: "routes-course",
    courseTitle: "路径测试课程",
    moduleId: "routes-material",
    moduleTitle: "路径测试材料",
    version: 1,
    publishedAt: "2026-08-31T00:00:00.000Z",
    pageIds: ["route-page-1"],
    pages: [{
      id: "route-page-1",
      pageNumber: 1,
      title: "路径测试页面",
      imageUrl: "/page.png",
      anchors: [],
      atoms: [],
      blocks: [{ id: "route-block", title: "核心解释", kind: "core", markdown: "输入经过规则得到输出", sourceAnchorIds: [], atomIds: [] }],
      lessonSections: [
        { id: "route-objective", kind: "learning_objectives", title: "学习目标", items: [{ id: "route-objective-item", text: "能够解释输入、规则和输出之间的关系", sourceAnchorIds: [] }], sourceAnchorIds: [], atomIds: [] },
        { id: "route-main", kind: "main_content", title: "主要内容", markdown: "页面说明一个可以复现的处理过程", sourceAnchorIds: [], atomIds: [] },
        { id: "route-prior", kind: "prior_knowledge", title: "先验知识", items: [{ id: "route-prior-item", text: "先知道输入和输出分别表示什么", sourceAnchorIds: [] }], sourceAnchorIds: [], atomIds: [] },
        { id: "route-full", kind: "full_explanation", title: "完整讲解", markdown: "先确认输入，再执行规则，最后核对输出是否满足目标", sourceAnchorIds: [], atomIds: [] },
        { id: "route-misconception", kind: "misconceptions", title: "易错点", items: [{ id: "route-misconception-item", text: "不能跳过输入条件直接套用结论", sourceAnchorIds: [] }], sourceAnchorIds: [], atomIds: [] }
      ],
      questionBank: [],
      coverageRequirements: [],
      coverageClaims: [],
      quality: { highRiskCoverage: 1, generalCoverage: 1, mathValid: true, publishable: true, issues: [] }
    }],
    assessments: [],
    manifestHash: "routes-manifest-hash",
    writingPolicySnapshotId: "routes-policy",
    modelRoute: "deterministic-route-test",
    qualityHarnessVersion: "routes-quality-v1",
    costUsd: 0
  };
}

function routeManifest(releaseId: string): ReleaseManifest {
  return {
    id: `${releaseId}:manifest`,
    schemaVersion: "2.4.0",
    courseReleaseId: releaseId,
    sourceHashes: [],
    pageHashes: [],
    explanationHashes: [],
    assessmentHashes: [],
    writingPolicySnapshotId: "routes-policy",
    modelRoutes: ["deterministic-route-test"],
    qualityHarnessVersion: "routes-quality-v1",
    costInputs: [],
    createdAt: "2026-08-31T00:00:00.000Z"
  };
}
