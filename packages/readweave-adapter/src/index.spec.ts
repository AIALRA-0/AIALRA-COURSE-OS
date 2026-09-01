import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CourseProject, CourseRelease, CourseTreeNode, IdempotentWriteContext, LessonDraft, ReleaseManifest } from "@course-os/contracts";
import { EtapiReadWeaveCourseApi, FileReadWeaveCourseApi, HttpReadWeaveCourseApi } from "./index.js";

const context: IdempotentWriteContext = {
  idempotencyKey: "publish-1",
  actor: "test",
  workspaceId: "personal",
  schemaVersion: "2.1.0",
  requestId: "request-1"
};

const release: CourseRelease = {
  id: "release-1",
  courseId: "course-1",
  courseTitle: "Course",
  moduleId: "module-1",
  moduleTitle: "Module",
  version: 1,
  publishedAt: "2026-08-28T00:00:00.000Z",
  pageIds: [],
  pages: [],
  assessments: [],
  manifestHash: "hash",
  writingPolicySnapshotId: "policy-1",
  modelRoute: "deterministic-seed",
  qualityHarnessVersion: "quality-v1",
  costUsd: 0
};

const manifest: ReleaseManifest = {
  id: "manifest-1",
  schemaVersion: "2.1.0",
  courseReleaseId: "release-1",
  sourceHashes: [],
  pageHashes: [],
  explanationHashes: [],
  assessmentHashes: [],
  writingPolicySnapshotId: "policy-1",
  modelRoutes: ["deterministic-seed"],
  qualityHarnessVersion: "quality-v1",
  costInputs: [],
  createdAt: "2026-08-28T00:00:00.000Z"
};

describe("file ReadWeave adapter", () => {
  it("replays the same idempotency key and rejects an in-place release replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-readweave-"));
    const api = new FileReadWeaveCourseApi(join(root, "state.json"));
    expect((await api.publishRelease(release, manifest, context)).id).toBe("release-1");
    expect((await api.publishRelease(release, manifest, context)).id).toBe("release-1");
    await expect(api.publishRelease({ ...release, courseTitle: "Changed" }, manifest, { ...context, idempotencyKey: "publish-2" })).rejects.toThrow("READWEAVE_RELEASE_IMMUTABLE");
  });

  it("persists a revision conflict without poisoning later writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-readweave-"));
    const api = new FileReadWeaveCourseApi(join(root, "state.json"));
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const first = await api.saveDraft(draftFor(pageRelease), 0, { ...context, idempotencyKey: "draft-1" });
    await expect(api.saveDraft({ ...first, revision: 2 }, 0, { ...context, idempotencyKey: "draft-stale" })).rejects.toThrow("READWEAVE_REVISION_CONFLICT");
    expect((await api.listConflicts()).filter((item) => item.status === "open")).toHaveLength(1);
    await expect(api.saveQuestion({
      id: "question-after-conflict",
      sessionId: "session-1",
      courseReleaseId: pageRelease.id,
      pageId: "page-1",
      anchorIds: [],
      question: "为什么",
      learnerAttempt: "我的尝试",
      hintLevel: 1,
      response: "提示",
      reviewPolicy: "include",
      status: "active",
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, { ...context, idempotencyKey: "question-after-conflict" })).resolves.toMatchObject({ id: "question-after-conflict" });
  });

  it("removes only the selected draft source and its page drafts", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-readweave-"));
    const api = new FileReadWeaveCourseApi(join(root, "state.json"));
    const source = { ...releaseWithPage(), id: "draft-source-1", lifecycle: "draft_source" as const };
    await api.registerDraftSource(source, { ...context, idempotencyKey: "source-1" });
    await api.saveDraft(draftFor(source), 0, { ...context, idempotencyKey: "source-draft-1" });
    await api.removeDraftSource(source.id, { ...context, idempotencyKey: "remove-source-1" });
    expect(await api.getRelease(source.id)).toBeUndefined();
    expect(await api.getDraftByPage("page-1")).toBeUndefined();
  });
});

describe("ReadWeave ETAPI adapter", () => {
  it("creates the course tree and imports direct block edits as a new revision", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({
      baseUrl: "http://readweave",
      token: "secret",
      parentNoteId: "root",
      publicUrl: "https://readweave.example.com",
      fetchImpl: remote.fetch
    });
    const pageRelease = releaseWithPage();
    await api.publishRelease(pageRelease, { ...manifest, courseReleaseId: pageRelease.id }, context);
    const saved = await api.saveDraft(draftFor(pageRelease), 0, { ...context, idempotencyKey: "etapi-draft-1" });
    expect(saved.readweaveNoteId).toBeTruthy();
    expect(remote.titles()).toEqual(expect.arrayContaining(["Course OS", "02 课程材料", "04 完整讲解", "核心解释"]));
    remote.editByTitle("核心解释", "ReadWeave 中直接完成的逐块修改");
    const reconciled = await api.getDraftByPage("page-1");
    expect(reconciled?.revision).toBe(2);
    expect(reconciled?.page.blocks[0]?.markdown).toBe("ReadWeave 中直接完成的逐块修改");
    expect((await api.getSyncStatus()).mode).toBe("etapi");
  });

  it("projects tree changes to ReadWeave branches and validates exact links", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({
      baseUrl: "http://readweave",
      token: "secret",
      parentNoteId: "root",
      publicUrl: "https://readweave.example.com",
      fetchImpl: remote.fetch
    });
    const course = {
      id: "tree-course",
      workspaceId: "personal",
      title: "树测试课程",
      status: "active" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await api.createCourse(course, { ...context, idempotencyKey: "tree-course" });
    expect(remote.requests.some((request) => request.method === "POST" && request.headers["idempotency-key"] === "tree-course")).toBe(true);
    expect(remote.requests.some((request) => request.method === "GET" && request.path.startsWith("/notes/"))).toBe(true);
    const node: CourseTreeNode = { id: "tree-module", kind: "module", title: "第一章", parentId: course.id, revision: 0, status: "draft", archived: false, children: [] };
    const created = await api.createTreeNode(node, { ...context, idempotencyKey: "tree-module" });
    expect(created.readweaveNoteId).toMatch(/^note/);
    const renamed = await api.updateTreeNode(created.id, { title: "第一章：基础" }, 0, { ...context, idempotencyKey: "tree-rename" });
    expect(renamed).toMatchObject({ title: "第一章：基础", revision: 1 });
    const moved = await api.updateTreeNode(created.id, { parentId: `material:${course.id}:current` }, 1, { ...context, idempotencyKey: "tree-move" });
    expect(moved.parentId).toBe(`material:${course.id}:current`);
    const trashed = await api.trashTreeNode(created.id, { ...context, idempotencyKey: "tree-trash" });
    expect(trashed.readweaveNoteId).toBe(created.readweaveNoteId);
    const restored = await api.restoreTrash(trashed.id, { ...context, idempotencyKey: "tree-restore" });
    expect(restored).toMatchObject({ id: created.id, archived: false });
    const link = await api.getDeepLink(created.readweaveNoteId!);
    expect(link).toEqual(expect.objectContaining({ host: "readweave.example.com", verified: true, url: `https://readweave.example.com/#root/${created.readweaveNoteId}` }));
    await expect(api.permanentlyDeleteTrash(trashed.id, { ...context, idempotencyKey: "tree-permanent-delete" })).rejects.toThrow("READWEAVE_PERMANENT_DELETE_UNSUPPORTED");
  });

  it("keeps release-only materials stable across cross-course moves, root restore and trash", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({
      baseUrl: "http://readweave",
      token: "secret",
      parentNoteId: "root",
      publicUrl: "https://readweave.example.com",
      fetchImpl: remote.fetch
    });
    const releaseOnly = {
      ...releaseWithPage(),
      id: "release-only-1",
      courseId: "release-course",
      courseTitle: "发布记录生成的课程",
      moduleId: "slides-a",
      moduleTitle: "算法课件"
    } satisfies CourseRelease;
    await api.publishRelease(releaseOnly, { ...manifest, id: "manifest-release-only", courseReleaseId: releaseOnly.id }, { ...context, idempotencyKey: "release-only-publish" });

    const initial = (await api.listTreeNodes()).find((node) => node.kind === "material");
    expect(initial).toMatchObject({ id: "material:release-course:slides-a", materialId: "material:release-course:slides-a", parentId: "release-course" });
    expect(initial?.readweaveNoteId).toBeTruthy();

    const secondCourse: CourseProject = {
      id: "second-course",
      workspaceId: "personal",
      title: "第二门课程",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await api.createCourse(secondCourse, { ...context, idempotencyKey: "second-course" });
    const moved = await api.updateTreeNode(initial!.id, { parentId: secondCourse.id }, initial!.revision ?? 0, { ...context, idempotencyKey: "move-to-second-course" });
    expect(moved.parentId).toBe(secondCourse.id);
    expect(remote.parentTitleOf(moved.readweaveNoteId!)).toBe("02 课程材料");

    const rootMaterial = await api.updateTreeNode(moved.id, { parentId: null }, moved.revision ?? 0, { ...context, idempotencyKey: "move-to-workspace-root" });
    expect(rootMaterial.parentId).toBeUndefined();
    expect(remote.parentTitleOf(rootMaterial.readweaveNoteId!)).toBe("00 工作区根材料");

    const trashed = await api.trashTreeNode(rootMaterial.id, { ...context, idempotencyKey: "trash-root-material" });
    expect(remote.parentTitleOf(trashed.readweaveNoteId!)).toBe("回收站");
    expect((await api.listTreeNodes()).some((node) => node.id === rootMaterial.id)).toBe(false);

    const restored = await api.restoreTrash(trashed.id, { ...context, idempotencyKey: "restore-root-material" }, { restoreMode: "root" });
    expect(restored).toMatchObject({ id: rootMaterial.id, kind: "material", archived: false });
    expect(restored.parentId).toBeUndefined();
    expect(remote.parentTitleOf(restored.readweaveNoteId!)).toBe("00 工作区根材料");
    await expect(api.restoreTrash(trashed.id, { ...context, idempotencyKey: "restore-root-material" }, { restoreMode: "root" })).resolves.toMatchObject({ id: rootMaterial.id });
  });

  it("falls back from a stale cached branch to the remote branch before moving", async () => {
    const remote = new FakeEtapi();
    const api = new EtapiReadWeaveCourseApi({
      baseUrl: "http://readweave",
      token: "secret",
      parentNoteId: "root",
      publicUrl: "https://readweave.example.com",
      fetchImpl: remote.fetch
    });
    const course = {
      id: "stale-branch-course",
      workspaceId: "personal",
      title: "分支恢复测试",
      status: "active" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await api.createCourse(course, { ...context, idempotencyKey: "stale-branch-course" });
    const node: CourseTreeNode = { id: "stable-material-for-branch", kind: "material", materialId: "stable-material-for-branch", title: "分支材料", parentId: course.id, revision: 0, status: "draft", archived: false, children: [] };
    const created = await api.createTreeNode(node, { ...context, idempotencyKey: "stale-branch-material" });
    remote.removeBranch(remote.branchIdForNote(created.readweaveNoteId!));
    const moved = await api.updateTreeNode(created.id, { parentId: null }, 0, { ...context, idempotencyKey: "stale-branch-move" });
    expect(moved.parentId).toBeUndefined();
    expect(remote.parentTitleOf(moved.readweaveNoteId!)).toBe("00 工作区根材料");
  });
});

describe("ReadWeave HTTP deep links", () => {
  it("projects only masked credential status and never sends the provider secret to ReadWeave", async () => {
    let requestBody = "";
    let requestHeaders: Record<string, string> = {};
    const api = new HttpReadWeaveCourseApi("https://readweave.example/api/course/v1", "secret", async (_input, init) => {
      requestBody = String(init?.body || "");
      requestHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return Response.json({ id: "deepseek", credential: { configured: true, maskedValue: "••••alue", updatedAt: "2026-08-30T00:00:00.000Z" } });
    });
    const result = await api.saveModelProviderCredential("deepseek", { configured: true, maskedValue: "••••alue", updatedAt: "2026-08-30T00:00:00.000Z" }, { ...context, idempotencyKey: "credential-status" });
    expect(result.credential.maskedValue).toBe("••••alue");
    expect(requestBody).toContain('"credential"');
    expect(requestBody).not.toContain("deepseek-secret-value");
    expect(requestBody).not.toContain("secret");
    expect(requestHeaders["idempotency-key"]).toBe("credential-status");
    expect(requestHeaders["x-workspace-id"]).toBe("personal");
  });

  it("rejects a remote link that is not verified for the live host", async () => {
    const api = new HttpReadWeaveCourseApi("https://readweave.example/api/course/v1", "secret", async () => Response.json({
      noteId: "note-1",
      url: "https://evil.example/#root/note-1",
      host: "evil.example",
      verified: true,
      verifiedAt: new Date().toISOString()
    }));
    await expect(api.getDeepLink("note-1")).resolves.toBeUndefined();
  });

  it("normalizes a verified link to the only public ReadWeave host", async () => {
    const api = new HttpReadWeaveCourseApi("https://readweave.example/api/course/v1", "secret", async () => Response.json({
      noteId: "note-1",
      url: "https://readweave.example.com/legacy/path",
      host: "readweave.example.com",
      verified: true,
      verifiedAt: "2026-08-30T00:00:00.000Z"
    }));
    await expect(api.getDeepLink("note-1")).resolves.toMatchObject({
      url: "https://readweave.example.com/#root/note-1",
      host: "readweave.example.com",
      verified: true
    });
  });

  it("retries transient ReadWeave failures but does not retry a revision or permission conflict", async () => {
    let transientCalls = 0;
    const transient = new HttpReadWeaveCourseApi("https://readweave.example/api/course/v1", "secret", async () => {
      transientCalls += 1;
      if (transientCalls < 3) return new Response("temporarily unavailable", { status: 503 });
      return Response.json({ noteId: "note-1", url: "https://readweave.example.com/#root/note-1", host: "readweave.example.com", verified: true });
    });
    await expect(transient.getDeepLink("note-1")).resolves.toMatchObject({ noteId: "note-1", verified: true });
    expect(transientCalls).toBe(3);

    let conflictCalls = 0;
    const conflict = new HttpReadWeaveCourseApi("https://readweave.example/api/course/v1", "secret", async () => {
      conflictCalls += 1;
      return new Response("conflict", { status: 409 });
    });
    await expect(conflict.getDeepLink("note-1")).rejects.toThrow("READWEAVE_HTTP_409");
    expect(conflictCalls).toBe(1);
  });
});

function releaseWithPage(): CourseRelease {
  return {
    ...release,
    id: "release-with-page",
    pageIds: ["page-1"],
    pages: [{
      id: "page-1",
      pageNumber: 1,
      title: "测试页面",
      imageUrl: "/page.png",
      anchors: [],
      atoms: [],
      blocks: [{ id: "block-1", title: "核心解释", kind: "core", markdown: "原始讲解", sourceAnchorIds: [], atomIds: [] }],
      coverageRequirements: [],
      coverageClaims: [],
      quality: { highRiskCoverage: 1, generalCoverage: 1, mathValid: true, publishable: true, issues: [] }
    }]
  };
}

function draftFor(pageRelease: CourseRelease): LessonDraft {
  return {
    id: "draft:page-1",
    workspaceId: "personal",
    courseId: pageRelease.courseId,
    moduleId: pageRelease.moduleId,
    sourceReleaseId: pageRelease.id,
    pageId: "page-1",
    revision: 0,
    status: "editing",
    page: structuredClone(pageRelease.pages[0]!),
    changedBlockIds: ["block-1"],
    contentHash: "draft-hash",
    updatedAt: new Date().toISOString()
  };
}

class FakeEtapi {
  private sequence = 0;
  readonly requests: Array<{ path: string; method: string; headers: Record<string, string> }> = [];
  private readonly notes = new Map<string, { title: string; content: string; labels: Record<string, string>; type: string; mime: string; parentBranchIds: string[]; deleted: boolean }>([["root", { title: "root", content: "", labels: {}, type: "text", mime: "text/html", parentBranchIds: [], deleted: false }]]);
  private readonly branches = new Map<string, { branchId: string; noteId: string; parentNoteId: string; notePosition: number }>();

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const path = url.pathname.replace(/^\/etapi/, "");
    this.requests.push({ path, method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (path === "/notes" && (init?.method ?? "GET") === "GET") {
      const query = url.searchParams.get("search") ?? "";
      const match = /^#([^=]+)=(.*)$/.exec(query);
      const results = [...this.notes.entries()].filter(([, note]) => !note.deleted && match && note.labels[match[1]!] === match[2]).map(([noteId, note]) => ({ noteId, title: note.title, type: note.type, mime: note.mime, parentBranchIds: note.parentBranchIds }));
      return Response.json({ results });
    }
    if (path === "/create-note" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { parentNoteId: string; title: string; content: string; type?: string; mime?: string };
      const noteId = `note${++this.sequence}`;
      const branchId = `branch${this.sequence}`;
      this.notes.set(noteId, { title: body.title, content: body.content, labels: {}, type: body.type || "text", mime: body.mime || "text/html", parentBranchIds: [branchId], deleted: false });
      this.branches.set(branchId, { branchId, noteId, parentNoteId: body.parentNoteId, notePosition: 10 });
      return Response.json({ note: { noteId, title: body.title, type: body.type || "text", mime: body.mime || "text/html", parentBranchIds: [branchId] }, branch: { branchId, noteId, parentNoteId: body.parentNoteId, notePosition: 10 } }, { status: 201 });
    }
    if (path === "/attributes" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { noteId: string; name: string; value: string };
      this.notes.get(body.noteId)!.labels[body.name] = body.value;
      return Response.json({ attributeId: `attr${++this.sequence}`, ...body }, { status: 201 });
    }
    const noteMatch = /^\/notes\/([^/]+)$/.exec(path);
    if (noteMatch && (init?.method ?? "GET") === "GET") {
      const note = this.notes.get(noteMatch[1]!);
      if (!note || note.deleted) return new Response("not found", { status: 404 });
      return Response.json({ noteId: noteMatch[1], title: note.title, type: note.type, mime: note.mime, parentBranchIds: note.parentBranchIds });
    }
    if (noteMatch && init?.method === "PATCH") {
      const note = this.notes.get(noteMatch[1]!);
      if (!note || note.deleted) return new Response("not found", { status: 404 });
      const body = JSON.parse(String(init.body)) as { title?: string };
      if (body.title) note.title = body.title;
      return Response.json({ noteId: noteMatch[1], title: note.title, type: note.type, mime: note.mime, parentBranchIds: note.parentBranchIds });
    }
    if (noteMatch && init?.method === "DELETE") {
      const note = this.notes.get(noteMatch[1]!);
      if (!note) return new Response("not found", { status: 404 });
      note.deleted = true;
      return new Response(null, { status: 204 });
    }
    const undeleteMatch = /^\/notes\/([^/]+)\/undelete$/.exec(path);
    if (undeleteMatch && init?.method === "PUT") {
      const note = this.notes.get(undeleteMatch[1]!);
      if (!note) return new Response("not found", { status: 404 });
      note.deleted = false;
      return new Response(null, { status: 204 });
    }
    const branchMatch = /^\/branches\/([^/]+)$/.exec(path);
    if (branchMatch && (init?.method ?? "GET") === "GET") {
      const branch = this.branches.get(branchMatch[1]!);
      return branch ? Response.json(branch) : new Response("not found", { status: 404 });
    }
    if (path === "/branches" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { noteId: string; parentNoteId: string; notePosition?: number };
      const branchId = `branch${++this.sequence}`;
      const branch = { branchId, noteId: body.noteId, parentNoteId: body.parentNoteId, notePosition: body.notePosition ?? 10 };
      this.branches.set(branchId, branch);
      const note = this.notes.get(body.noteId);
      if (note && !note.parentBranchIds.includes(branchId)) note.parentBranchIds.push(branchId);
      return Response.json(branch, { status: 201 });
    }
    const moveMatch = /^\/branches\/([^/]+)\/move-to\/([^/]+)$/.exec(path);
    if (moveMatch && init?.method === "PUT") {
      const branch = this.branches.get(moveMatch[1]!);
      const parent = this.branches.get(moveMatch[2]!);
      if (!branch || !parent) return new Response("not found", { status: 404 });
      branch.parentNoteId = parent.noteId;
      return Response.json({ success: true });
    }
    const contentMatch = /^\/notes\/([^/]+)\/content$/.exec(path);
    if (contentMatch && (init?.method ?? "GET") === "GET") {
      const note = this.notes.get(contentMatch[1]!);
      return note && !note.deleted ? new Response(note.content, { status: 200 }) : new Response("not found", { status: 404 });
    }
    if (contentMatch && init?.method === "PUT") {
      const note = this.notes.get(contentMatch[1]!);
      if (!note || note.deleted) return new Response("not found", { status: 404 });
      note.content = String(init.body ?? "");
      return new Response(null, { status: 204 });
    }
    if (/^\/notes\/[^/]+\/revision$/.test(path) && init?.method === "POST") return new Response(null, { status: 204 });
    return new Response("not found", { status: 404 });
  };

  titles(): string[] {
    return [...this.notes.values()].map((note) => note.title);
  }

  branchIdForNote(noteId: string): string {
    const note = this.notes.get(noteId);
    const branchId = note?.parentBranchIds.find((candidate) => this.branches.has(candidate));
    if (!branchId) throw new Error(`missing branch for ${noteId}`);
    return branchId;
  }

  removeBranch(branchId: string | undefined): void {
    if (!branchId) return;
    this.branches.delete(branchId);
  }

  parentTitleOf(noteId: string): string | undefined {
    const branch = this.notes.get(noteId)?.parentBranchIds
      .map((branchId) => this.branches.get(branchId))
      .find((candidate) => candidate !== undefined);
    return branch ? this.notes.get(branch.parentNoteId)?.title : undefined;
  }

  editByTitle(title: string, content: string): void {
    const note = [...this.notes.values()].find((item) => item.title === title);
    if (!note) throw new Error(`missing note ${title}`);
    note.content = content;
  }
}
