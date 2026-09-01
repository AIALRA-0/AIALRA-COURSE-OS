import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import type {
  ApiError,
  AssessmentAttempt,
  CourseProject,
  CourseRelease,
  CourseTreeNode,
  ConversionRequest,
  ConversionResult,
  CostRollup,
  GenerationCostEntry,
  GenerationJob,
  IdempotentWriteContext,
  ImportRecord,
  LessonSection,
  LessonDraft,
  LearningSession,
  ModelRoutePolicy,
  ModelProviderConfig,
  PageQuestion,
  QuestionAttempt,
  QuestionBankItem,
  QuestionSelection,
  ReviewMap,
  ReviewObjective,
  ReviewPlan,
  ReviewPlanItem,
  ReviewSession,
  ReviewAttemptResult,
  TreeNodeProperties,
  WorkspaceSettings,
  WritingPolicyCurrent,
  CourseTreeNodeKind,
  TrashRecord
} from "@course-os/contracts";
import { COURSE_API_VERSION } from "@course-os/contracts";
import { convertMaterial, FileConversionQueueClient, removeConversionOutput } from "@course-os/converter";
import { applyAttempt, hashManifest, sha256Text, stableStringify, transitionJob } from "@course-os/domain";
import { calculateCoverage, normalizeLegacyMathDelimiters, validatePageForPublication, validateTex } from "@course-os/quality";
import type { ReadWeaveCourseApi } from "@course-os/readweave-adapter";
import { ContentAddressedStore, inspectUpload } from "@course-os/storage";
import { buildModelImageDataUrl } from "./image-payload.js";
import { OperationalStore, PostgresOperationalStore, type OperationalState } from "./store.js";
import { ModelRouterGenerationError, modelRouterFromEnvironment, probeProviderConnection, professorInstructions, providerRouterFromSettings, type ModelRouterClient, type ProviderConnection, type TeachingPackage, type TeachingGenerationResult } from "./model-router.js";
import { SecretVault } from "./secret-vault.js";
import { billingBreakdown, billingModeForProvider, estimateMicrousd, priceSnapshotFor } from "./pricing.js";

export interface AppDependencies {
  dataDir: string;
  operations: OperationalStore;
  readweave: ReadWeaveCourseApi;
  cas: ContentAddressedStore;
  conversion: { enqueueAndWait(request: ConversionRequest): Promise<ConversionResult> };
  modelRouter?: ModelRouterClient;
  credentialVault?: SecretVault;
}

const activeImports = new WeakMap<OperationalStore, Set<string>>();

export function createApp(dependencies: AppDependencies): Express {
  const app = express();
  const credentialVault = dependencies.credentialVault ?? new SecretVault(join(dependencies.dataDir, "settings-secrets.json"));
  dependencies.credentialVault ??= credentialVault;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 1 } });
  app.disable("x-powered-by");
  app.use(cors({ origin: true, credentials: false }));
  app.use(express.json({ limit: "2mb" }));
  app.use((request, response, next) => {
    response.setHeader("X-Request-Id", request.header("X-Request-Id") || randomUUID());
    response.setHeader("X-Course-Api-Version", COURSE_API_VERSION);
    next();
  });

  app.get("/healthz", async (_request, response) => {
    const releases = await dependencies.readweave.listReleases();
    response.json({
      status: "ok",
      apiVersion: COURSE_API_VERSION,
      publishedReleases: releases.filter((release) => release.lifecycle !== "draft_source").length,
    });
  });

  app.get("/api/v1/writing-policy/current", async (_request, response, next) => {
    try {
      response.json(await currentWritingPolicy());
    } catch (error) { next(error); }
  });

  app.get("/api/v1/workspaces/:id/tree", async (request, response, next) => {
    try {
      const workspaceId = request.params.id;
      const courses = formalWorkspaceCourses(await dependencies.readweave.listCourses(), workspaceId);
      const courseIds = new Set(courses.map((course) => course.id));
      const releases = await listWorkspaceReleases(dependencies.readweave, workspaceId);
      const drafts = await dependencies.readweave.listDrafts();
      const treeNodes = (await dependencies.readweave.listTreeNodes()).filter((node) => !isRegressionAsset(node.id, node.title, node.materialId ?? "") && (node.kind === "course"
        ? courseIds.has(node.id)
        : node.kind === "material"
          ? (node.parentId ? courseIds.has(node.parentId) : node.materialId?.split(":")[1] ? courseIds.has(node.materialId.split(":")[1]!) : false)
          : false));
      const trash = (await dependencies.readweave.listTrash()).filter((record) => record.workspaceId === workspaceId);
      const rootNodes = buildCourseTree(courses, releases, drafts, treeNodes, trash);
      response.json({
        workspaceId,
        title: "Course OS 课程空间",
        courses: rootNodes.filter((node) => node.kind === "course"),
        rootMaterials: rootNodes.filter((node) => node.kind === "material"),
        treeVersion: "2.4.0",
        trash: buildTrashNode(trash, workspaceId),
        updatedAt: new Date().toISOString()
      });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/courses", async (_request, response, next) => {
    try {
      const workspaceId = _request.header("X-Workspace-Id") || "personal";
      response.json((await dependencies.readweave.listCourses()).filter((course) => course.workspaceId === workspaceId));
    }
    catch (error) { next(error); }
  });

  app.post("/api/v1/courses", async (request, response, next) => {
    try {
      const idempotencyKey = requireIdempotencyKey(request);
      const title = String(request.body.title || "").trim();
      if (!title) return sendError(request, response, 422, "COURSE_TITLE_REQUIRED", "请填写课程名称", false);
      const now = new Date().toISOString();
      const course: CourseProject = {
        id: String(request.body.id || `course-${randomUUID()}`),
        workspaceId: request.header("X-Workspace-Id") || "personal",
        title,
        description: asOptionalString(request.body.description),
        status: "active",
        createdAt: now,
        updatedAt: now
      };
      response.status(201).json(await dependencies.readweave.createCourse(course, writeContext(request, idempotencyKey)));
    } catch (error) { next(error); }
  });

  app.post("/api/v1/modules", async (request, response, next) => {
    try {
      const idempotencyKey = requireIdempotencyKey(request);
      const title = String(request.body.title || "").trim();
      const parentId = String(request.body.courseId || request.body.parentId || "").trim();
      if (!title) return sendError(request, response, 422, "MODULE_TITLE_REQUIRED", "请填写模块名称", false);
      if (!parentId) return sendError(request, response, 422, "MODULE_COURSE_REQUIRED", "新模块必须归属于一门课程", false);
      const parent = await resolveWorkspaceTreeNode(dependencies.readweave, parentId, request.header("X-Workspace-Id") || "personal");
      if (!parent || parent.kind !== "course") return sendError(request, response, 422, "TREE_PARENT_NOT_FOUND", "目标课程不存在，请重新选择课程", false);
      const node: CourseTreeNode = {
        id: String(request.body.id || `module-${randomUUID()}`),
        kind: "module",
        title,
        subtitle: asOptionalString(request.body.description),
        parentId,
        revision: 0,
        status: "draft",
        archived: false,
        children: []
      };
      response.status(201).json(await dependencies.readweave.createTreeNode(node, writeContext(request, idempotencyKey)));
    } catch (error) { next(error); }
  });

  app.patch("/api/v1/tree/nodes/:id", async (request, response, next) => {
    try {
      const idempotencyKey = requireIdempotencyKey(request);
      const expectedRevision = Number(request.body.expectedRevision);
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) return sendError(request, response, 422, "TREE_REVISION_REQUIRED", "修改课程树时必须提供当前修订号", false);
      await assertWorkspaceTreeNode(dependencies.readweave, request.params.id, request.header("X-Workspace-Id") || "personal");
      const patch = {
        title: typeof request.body.title === "string" ? request.body.title : undefined,
        parentId: request.body.parentId === null ? null : typeof request.body.parentId === "string" ? request.body.parentId : undefined,
        archived: typeof request.body.archived === "boolean" ? request.body.archived : undefined,
        sortOrder: typeof request.body.sortOrder === "number" && Number.isFinite(request.body.sortOrder) ? request.body.sortOrder : undefined
      };
      if (!patch.title?.trim() && patch.parentId === undefined && patch.archived === undefined && patch.sortOrder === undefined) return sendError(request, response, 422, "TREE_PATCH_EMPTY", "没有提供要修改的课程树内容", false);
      response.json(await dependencies.readweave.updateTreeNode(request.params.id, patch, expectedRevision, writeContext(request, idempotencyKey)));
    } catch (error) { next(error); }
  });

  app.post(/^\/api\/v1\/tree\/nodes\/[^/]+:duplicate$/, async (request, response, next) => {
    try {
      const nodeId = decodeURIComponent(request.path.slice("/api/v1/tree/nodes/".length, -":duplicate".length));
      await assertWorkspaceTreeNode(dependencies.readweave, nodeId, request.header("X-Workspace-Id") || "personal");
      response.status(201).json(await dependencies.readweave.duplicateTreeNode(nodeId, writeContext(request, requireIdempotencyKey(request))));
    } catch (error) { next(error); }
  });

  const moveTreeNode = async (request: Request, response: Response, next: NextFunction) => {
    try {
      const expectedRevision = Number(request.body.expectedRevision);
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) return sendError(request, response, 422, "TREE_REVISION_REQUIRED", "移动课程树节点时必须提供当前修订号", false);
      const parentId = request.body.parentId === null || request.body.parentId === "" || request.body.parentId === undefined ? null : String(request.body.parentId);
      const sortOrder = typeof request.body.sortOrder === "number" && Number.isFinite(request.body.sortOrder) ? request.body.sortOrder : undefined;
      const pathMatch = request.path.match(/^\/api\/v1\/tree\/nodes\/(.+?)(?::move|\/move)$/);
      const routeNodeId = pathMatch?.[1] ?? (Array.isArray(request.params.id) ? request.params.id[0] : request.params.id);
      const nodeId = decodeURIComponent(routeNodeId || "");
      if (!nodeId) return sendError(request, response, 422, "TREE_NODE_REQUIRED", "移动课程树节点时缺少节点编号", false);
      const workspaceId = request.header("X-Workspace-Id") || "personal";
      const source = await assertWorkspaceTreeNode(dependencies.readweave, nodeId, workspaceId);
      if (parentId !== null) {
        const target = await assertWorkspaceTreeNode(dependencies.readweave, parentId, workspaceId);
        if (source.kind === "course" && target.kind !== "course") return sendError(request, response, 422, "TREE_TARGET_INVALID", "课程只能在工作区根目录中排序", false);
        if (source.kind === "material" && target.kind !== "course") return sendError(request, response, 422, "TREE_TARGET_INVALID", "材料只能放在课程下面或工作区根目录", false);
      }
      response.json(await dependencies.readweave.updateTreeNode(nodeId, { parentId, sortOrder }, expectedRevision, writeContext(request, requireIdempotencyKey(request))));
    } catch (error) { next(error); }
  };
  app.post(/^\/api\/v1\/tree\/nodes\/[^/]+:move$/, moveTreeNode);
  app.post("/api/v1/tree/nodes/:id/move", moveTreeNode);

  app.post(/^\/api\/v1\/tree\/nodes\/[^/]+:trash$/, async (request, response, next) => {
    try {
      const nodeId = decodeURIComponent(request.path.slice("/api/v1/tree/nodes/".length, -":trash".length));
      await assertWorkspaceTreeNode(dependencies.readweave, nodeId, request.header("X-Workspace-Id") || "personal");
      response.status(201).json(await dependencies.readweave.trashTreeNode(nodeId, writeContext(request, requireIdempotencyKey(request))));
    } catch (error) { next(error); }
  });

  app.get("/api/v1/trash", async (request, response, next) => {
    try {
      const workspaceId = request.header("X-Workspace-Id") || "personal";
      response.json((await dependencies.readweave.listTrash()).filter((record) => record.workspaceId === workspaceId));
    }
    catch (error) { next(error); }
  });

  app.post(/^\/api\/v1\/trash\/[^/]+:restore$/, async (request, response, next) => {
    try {
      const trashId = decodeURIComponent(request.path.slice("/api/v1/trash/".length, -":restore".length));
      const restoreMode = request.body?.restoreMode === "root" ? "root" : "original";
      const workspaceId = request.header("X-Workspace-Id") || "personal";
      const trash = (await dependencies.readweave.listTrash()).find((item) => item.id === trashId && item.workspaceId === workspaceId);
      if (!trash) return sendError(request, response, 404, "TRASH_NOT_FOUND", "没有找到这条回收站记录", false);
      response.json(await dependencies.readweave.restoreTrash(trashId, writeContext(request, requireIdempotencyKey(request)), { restoreMode }));
    } catch (error) { next(error); }
  });

  app.delete("/api/v1/trash/:id", async (request, response, next) => {
    try {
      await dependencies.readweave.permanentlyDeleteTrash(request.params.id, writeContext(request, requireIdempotencyKey(request)));
      response.status(204).end();
    } catch (error) { next(error); }
  });

  app.get("/api/v1/readweave/links/:noteId", async (request, response, next) => {
    try {
      const workspaceId = request.header("X-Workspace-Id") || "personal";
      if (!(await readWeaveNoteBelongsToWorkspace(dependencies.readweave, request.params.noteId, workspaceId))) {
        return sendError(request, response, 404, "READWEAVE_NOTE_NOT_FOUND", "没有找到属于当前工作区的 ReadWeave 笔记", false);
      }
      const link = await dependencies.readweave.getDeepLink(request.params.noteId);
      if (!link) return sendError(request, response, 404, "READWEAVE_NOTE_NOT_FOUND", "没有找到属于当前工作区的 ReadWeave 笔记", false);
      response.json(link);
    } catch (error) { next(error); }
  });

  app.get("/api/v1/tree/nodes/:id/properties", async (request, response, next) => {
    try {
      const nodeId = request.params.id;
      const workspaceId = request.header("X-Workspace-Id") || "personal";
      const node = await resolveWorkspaceTreeNode(dependencies.readweave, nodeId, workspaceId);
      if (node && node.kind !== "course" && node.kind !== "material" && node.kind !== "trash") {
        return sendError(request, response, 409, "TREE_NODE_NOT_EDITABLE", "这个项目是只读版本，请从材料入口建立草稿", false);
      }
      // Page nodes are intentionally hidden from the library tree, but old
      // clients still use this read-only properties route for a page ID
      // while opening the learning view.  Resolve that compatibility read
      // without allowing the hidden ID to become writable.
      const properties = node
        ? (await dependencies.readweave.getTreeNodeProperties(nodeId) ?? await buildTreeNodeProperties(dependencies.readweave, nodeId, workspaceId))
        : await buildTreeNodeProperties(dependencies.readweave, nodeId, workspaceId);
      if (!properties) {
        if (isLikelyLegacyTreeNodeId(nodeId)) return sendError(request, response, 409, "TREE_NODE_STALE", "这个项目已经不在当前课程树中，请重新载入后再试", false);
        return sendError(request, response, 404, "TREE_NODE_NOT_FOUND", "没有找到这个课程树节点，请重新载入后再试", false);
      }
      response.json(properties);
    } catch (error) { next(error); }
  });

  app.get("/api/v1/tree/nodes/:id/versions", async (request, response, next) => {
    try {
      const workspaceId = request.header("X-Workspace-Id") || "personal";
      const [courses, releases, drafts, treeNodes, trash] = await Promise.all([
        dependencies.readweave.listCourses(),
        listWorkspaceReleases(dependencies.readweave, workspaceId),
        dependencies.readweave.listDrafts(),
        dependencies.readweave.listTreeNodes(),
        dependencies.readweave.listTrash()
      ]);
      const formalCourses = formalWorkspaceCourses(courses, workspaceId);
      const courseIds = new Set(formalCourses.map((course) => course.id));
      const scopedNode = findTreeNode(buildCourseTree(
        formalCourses,
        releases,
        drafts.filter((draft) => draft.workspaceId === workspaceId && courseIds.has(draft.courseId)),
        treeNodes.filter((candidate) => !isRegressionAsset(candidate.id, candidate.title, candidate.materialId ?? "")),
        trash.filter((record) => record.workspaceId === workspaceId)
      ), request.params.id);
      if (!scopedNode || (scopedNode.kind !== "course" && scopedNode.kind !== "material")) return sendError(request, response, 404, "TREE_NODE_STALE", "没有找到这个材料入口，请重新载入课程树", false);
      const visibleNode = scopedNode;
      const releaseForMaterial = visibleNode.kind === "material" ? releases.find((release) => release.id === (visibleNode.currentReleaseId ?? visibleNode.releaseId)) : undefined;
      const versions = releases
        .filter((release) => visibleNode.kind === "course"
          ? release.courseId === visibleNode.id
          : release.courseId === releaseForMaterial?.courseId && release.moduleId === releaseForMaterial?.moduleId)
        .sort((left, right) => right.version - left.version || right.publishedAt.localeCompare(left.publishedAt));
      response.json(versions);
    } catch (error) { next(error); }
  });

  app.get("/api/v1/settings", async (_request, response, next) => {
    try { response.json(await dependencies.readweave.getWorkspaceSettings()); }
    catch (error) { next(error); }
  });

  app.patch("/api/v1/settings", async (request, response, next) => {
    try {
      const current = await dependencies.readweave.getWorkspaceSettings();
      const candidate = { ...current, ...request.body } as WorkspaceSettings;
      if (!['zh-CN', 'en'].includes(candidate.language) || !['light', 'dark', 'system'].includes(candidate.theme) || ![1, 1.1, 1.2, 1.3].includes(candidate.baseFontScale) || !['economy', 'balanced', 'quality'].includes(candidate.defaultQualityMode)) return sendError(request, response, 422, "SETTINGS_INVALID", "工作区设置中有无法识别的值", false);
      if (typeof candidate.learningAutoAdvance !== "boolean" || typeof candidate.showEnglishLabels !== "boolean") return sendError(request, response, 422, "SETTINGS_INVALID", "学习偏好设置必须是布尔值", false);
      response.json(await dependencies.readweave.saveWorkspaceSettings(candidate, writeContext(request, requireIdempotencyKey(request))));
    } catch (error) { next(error); }
  });

  app.get("/api/v1/model-providers", async (_request, response, next) => {
    try { response.json(await dependencies.readweave.listModelProviders()); }
    catch (error) { next(error); }
  });

  app.patch("/api/v1/model-providers/:id", async (request, response, next) => {
    try {
      const patch: { baseUrl?: string; enabled?: boolean } = {};
      if (request.body.baseUrl !== undefined) {
        if (typeof request.body.baseUrl !== "string") return sendError(request, response, 422, "MODEL_PROVIDER_BASE_URL_INVALID", "接口地址必须是文本", false);
        const baseUrl = request.body.baseUrl.trim();
        if (baseUrl && !isAllowedProviderBaseUrl(baseUrl)) return sendError(request, response, 422, "MODEL_PROVIDER_BASE_URL_INVALID", "接口地址必须使用 HTTPS，或只在本机使用 HTTP", false);
        patch.baseUrl = baseUrl;
      }
      if (request.body.enabled !== undefined) {
        if (typeof request.body.enabled !== "boolean") return sendError(request, response, 422, "MODEL_PROVIDER_ENABLED_INVALID", "供应商启用状态必须是布尔值", false);
        patch.enabled = request.body.enabled;
      }
      if (Object.keys(patch).length === 0) return sendError(request, response, 422, "MODEL_PROVIDER_PATCH_EMPTY", "没有提供要修改的供应商设置", false);
      response.json(await dependencies.readweave.updateModelProvider(request.params.id, patch, writeContext(request, requireIdempotencyKey(request))));
    } catch (error) { next(error); }
  });

  app.put("/api/v1/model-providers/:id/credential", async (request, response, next) => {
    try {
      const secret = String(request.body.secret || "").trim();
      if (!secret) return sendError(request, response, 422, "MODEL_PROVIDER_CREDENTIAL_REQUIRED", "请填写接口密钥", false);
      await credentialVault.set(`model-provider:${request.params.id}`, secret);
      const credential = { configured: true, maskedValue: `••••${secret.slice(-4)}`, updatedAt: new Date().toISOString() };
      const saved = await dependencies.readweave.saveModelProviderCredential(request.params.id, credential, writeContext(request, requireIdempotencyKey(request)));
      response.json(saved);
    } catch (error) { next(error); }
  });

  app.post(/^\/api\/v1\/model-providers\/[^/]+:test$/, async (request, response, next) => {
    try {
      const providerId = decodeURIComponent(request.path.slice("/api/v1/model-providers/".length, -":test".length));
      const provider = (await dependencies.readweave.listModelProviders()).find((item) => item.id === providerId);
      if (!provider) return sendError(request, response, 404, "MODEL_PROVIDER_NOT_FOUND", "没有找到这个模型供应商", false);
      const apiKey = await credentialVault.get(`model-provider:${providerId}`);
      const model = provider.models[0];
      const health = !provider.baseUrl || !model
        ? (await dependencies.readweave.testModelProvider(providerId)).health
        : await probeProviderConnection({ providerId, baseUrl: provider.baseUrl, apiKey: apiKey || "", model: model.id, protocol: model.protocol, supportsVision: model.supportsVision, billingMode: model.billingMode } satisfies ProviderConnection);
      response.json({ ...provider, health });
    }
    catch (error) { next(error); }
  });

  app.get("/api/v1/model-providers/models", async (_request, response, next) => {
    try { response.json((await dependencies.readweave.listModelProviders()).flatMap((provider) => provider.models.map((model) => ({ ...model, providerId: provider.id })))); }
    catch (error) { next(error); }
  });

  app.get("/api/v1/model-route-policy", async (_request, response, next) => {
    try { response.json(await dependencies.readweave.getModelRoutePolicy()); }
    catch (error) { next(error); }
  });

  app.put("/api/v1/model-route-policy", async (request, response, next) => {
    try {
      const policy = request.body as ModelRoutePolicy;
      if (!policy || !Array.isArray(policy.rules) || typeof policy.allowAialraEmergencyFallback !== "boolean") return sendError(request, response, 422, "MODEL_ROUTE_POLICY_INVALID", "模型路由规则结构无效", false);
      response.json(await dependencies.readweave.saveModelRoutePolicy(policy, writeContext(request, requireIdempotencyKey(request))));
    } catch (error) { next(error); }
  });

  app.get("/api/v1/sync/status", async (_request, response, next) => {
    try {
      response.json(await dependencies.readweave.getSyncStatus());
    } catch (error) { next(error); }
  });

  app.get("/api/v1/conflicts", async (_request, response, next) => {
    try {
      response.json(await dependencies.readweave.listConflicts());
    } catch (error) { next(error); }
  });

  app.post(/^\/api\/v1\/conflicts\/[^/]+:resolve$/, async (request, response, next) => {
    try {
      const conflictId = decodeURIComponent(request.path.slice("/api/v1/conflicts/".length, -":resolve".length));
      const idempotencyKey = requireIdempotencyKey(request);
      const resolution = String(request.body.resolution || "");
      if (!["local", "remote", "merged"].includes(resolution)) return sendError(request, response, 422, "RESOLUTION_INVALID", "冲突处理方式必须是 local、remote 或 merged", false);
      response.json(await dependencies.readweave.resolveConflict(
        conflictId,
        resolution as "local" | "remote" | "merged",
        asOptionalString(request.body.mergedContent),
        writeContext(request, idempotencyKey)
      ));
    } catch (error) { next(error); }
  });

  app.get("/api/v1/pages/:id/draft", async (request, response, next) => {
    try {
      const pageId = request.params.id;
      const workspaceId = request.header("X-Workspace-Id") || "personal";
      const source = findPageSource(await listWorkspaceReleases(dependencies.readweave, workspaceId), pageId);
      if (!source) return sendError(request, response, 404, "PAGE_NOT_FOUND", "没有找到这个课程页面", false);
      const saved = await dependencies.readweave.getDraftByPage(pageId);
      if (saved && saved.workspaceId === workspaceId && saved.courseId === source.release.courseId) return response.json(saved);
      response.json(createVirtualDraft(source.release, source.page, workspaceId));
    } catch (error) { next(error); }
  });

  app.get("/api/v1/pages/:id/lesson", async (request, response, next) => {
    try {
      const workspaceId = request.header("X-Workspace-Id") || "personal";
      const releases = await listWorkspaceReleases(dependencies.readweave, workspaceId);
      const source = findPageSource(releases, request.params.id);
      if (!source) return sendError(request, response, 404, "PAGE_NOT_FOUND", "没有找到这个课程页面", false);
      const candidateDraft = await dependencies.readweave.getDraftByPage(request.params.id);
      const draft = candidateDraft && candidateDraft.workspaceId === workspaceId && candidateDraft.courseId === source.release.courseId ? candidateDraft : undefined;
      response.json({
        releaseId: source.release.id,
        page: draft?.page ?? source.page,
        qaRecords: await dependencies.readweave.listQuestions(request.params.id)
      });
    } catch (error) { next(error); }
  });

  app.patch("/api/v1/pages/:id/draft", async (request, response, next) => {
    try {
      const idempotencyKey = requireIdempotencyKey(request);
      const pageId = request.params.id;
      const source = findPageSource(await listWorkspaceReleases(dependencies.readweave, request.header("X-Workspace-Id") || "personal"), pageId);
      if (!source) return sendError(request, response, 404, "PAGE_NOT_FOUND", "没有找到这个课程页面", false);
      const expectedRevision = Number(request.body.baseRevision);
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) return sendError(request, response, 422, "BASE_REVISION_INVALID", "保存草稿时必须提供有效的 baseRevision", false);
      const page = request.body.page;
      if (!page || page.id !== pageId || !Array.isArray(page.blocks)) return sendError(request, response, 422, "DRAFT_PAGE_INVALID", "草稿页面结构无效", false);
      const currentCandidate = await dependencies.readweave.getDraftByPage(pageId);
      const current = currentCandidate && currentCandidate.workspaceId === (request.header("X-Workspace-Id") || "personal") && currentCandidate.courseId === source.release.courseId ? currentCandidate : undefined;
      const changedBlockIds = Array.isArray(request.body.changedBlockIds) ? request.body.changedBlockIds.map(String) : page.blocks.map((block: { id: string }) => block.id);
      const draft: LessonDraft = {
        ...(current ?? createVirtualDraft(source.release, source.page, request.header("X-Workspace-Id") || "personal")),
        page,
        revision: expectedRevision + 1,
        status: "needs_review",
        changedBlockIds,
        contentHash: sha256Text(stableStringify(page)),
        updatedAt: new Date().toISOString()
      };
      response.json(await dependencies.readweave.saveDraft(draft, expectedRevision, writeContext(request, idempotencyKey)));
    } catch (error) { next(error); }
  });

  app.post(/^\/api\/v1\/pages\/[^/]+:validate$/, async (request, response, next) => {
    try {
      const pageId = decodeURIComponent(request.path.slice("/api/v1/pages/".length, -":validate".length));
      const workspaceId = request.header("X-Workspace-Id") || "personal";
      const source = findPageSource(await listWorkspaceReleases(dependencies.readweave, workspaceId), pageId);
      const saved = await dependencies.readweave.getDraftByPage(pageId);
      const draft = source && saved?.workspaceId === workspaceId && saved.courseId === source.release.courseId
        ? saved
        : source ? createVirtualDraft(source.release, source.page, workspaceId) : undefined;
      if (!draft) return sendError(request, response, 404, "PAGE_NOT_FOUND", "没有找到要检查的课程页面", false);
      const coverage = calculateCoverage(draft.page.coverageRequirements, draft.page.coverageClaims);
      const issues = validatePageForPublication(draft.page);
      const pseudocode = draft.page.atoms.filter((atom) => atom.kind === "pseudocode_line");
      response.json({
        pageId,
        draftId: draft.id,
        revision: draft.revision,
        publishable: issues.length === 0 && coverage.publishable,
        highRiskCoverage: coverage.highRiskCoverage,
        generalCoverage: coverage.generalCoverage,
        mathValid: issues.every((issue) => !issue.includes("MATH")),
        pseudocodeLines: pseudocode.length,
        explainedPseudocodeLines: pseudocode.filter((line) => line.semantic && line.preState && line.postState).length,
        issues,
        checkedAt: new Date().toISOString()
      });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/releases", async (request, response, next) => {
    try {
      response.json(await listWorkspaceReleases(dependencies.readweave, request.header("X-Workspace-Id") || "personal", asOptionalString(request.query.course_id)));
    } catch (error) { next(error); }
  });

  app.post("/api/v1/releases", async (request, response, next) => {
    try {
      const idempotencyKey = requireIdempotencyKey(request);
      const baseReleaseId = String(request.body.baseReleaseId || "");
      const base = await getWorkspaceRelease(dependencies.readweave, baseReleaseId, request.header("X-Workspace-Id") || "personal");
      if (!base) return sendError(request, response, 404, "BASE_RELEASE_NOT_FOUND", "没有找到用于发布的基础课程版本", false);
      const drafts = await dependencies.readweave.listDrafts();
      const pages = base.pages.map((page) => drafts.find((draft) => draft.pageId === page.id)?.page ?? page);
      const issues = pages.flatMap((page) => validatePageForPublication(page).map((issue) => `${page.id}:${issue}`));
      if (issues.length > 0) return sendError(request, response, 422, "PUBLISH_GATE_FAILED", "课程仍有未通过的质量问题", false, { issues });
      const allReleases = await listWorkspaceReleases(dependencies.readweave, request.header("X-Workspace-Id") || "personal", base.courseId);
      const version = Math.max(0, ...allReleases.filter((item) => item.moduleId === base.moduleId).map((item) => item.version)) + 1;
      const now = new Date().toISOString();
      const releaseId = String(request.body.releaseId || `${base.moduleId}-v${version}-${Date.now()}`);
      const baseManifest = await dependencies.readweave.getManifest(base.id);
      const manifest = {
        id: `${releaseId}:manifest`,
        schemaVersion: COURSE_API_VERSION,
        courseReleaseId: releaseId,
        sourceHashes: baseManifest?.sourceHashes ?? [],
        pageHashes: pages.map((page) => sha256Text(stableStringify(page))),
        explanationHashes: pages.flatMap((page) => page.blocks.map((block) => sha256Text(stableStringify(block)))),
        assessmentHashes: base.assessments.map((item) => sha256Text(stableStringify(item))),
        writingPolicySnapshotId: base.writingPolicySnapshotId,
        modelRoutes: [...new Set([base.modelRoute, "quality-gated-draft-v2"])],
        qualityHarnessVersion: "course-os-studio-v1",
        costInputs: baseManifest?.costInputs ?? [],
        createdAt: now
      };
      const release: CourseRelease = {
        ...base,
        id: releaseId,
        version,
        publishedAt: now,
        pageIds: pages.map((page) => page.id),
        pages,
        manifestHash: hashManifest(manifest),
        modelRoute: "quality-gated-draft-v2",
        qualityHarnessVersion: "course-os-studio-v1",
        lifecycle: "published"
      };
      response.status(201).json(await dependencies.readweave.publishRelease(release, manifest, writeContext(request, idempotencyKey)));
    } catch (error) { next(error); }
  });

  app.get("/api/v1/releases/:id", async (request, response, next) => {
    try {
      const release = await getWorkspaceRelease(dependencies.readweave, request.params.id, request.header("X-Workspace-Id") || "personal");
      if (!release) return sendError(request, response, 404, "RELEASE_NOT_FOUND", "没有找到这个课程发布版本", false);
      response.json(release);
    } catch (error) { next(error); }
  });

  app.get("/api/v1/releases/:id/manifest", async (request, response, next) => {
    try {
      const release = await getWorkspaceRelease(dependencies.readweave, request.params.id, request.header("X-Workspace-Id") || "personal");
      if (!release) return sendError(request, response, 404, "RELEASE_NOT_FOUND", "没有找到这个课程发布版本", false);
      const manifest = await dependencies.readweave.getManifest(request.params.id);
      if (!manifest) return sendError(request, response, 404, "MANIFEST_NOT_FOUND", "没有找到这个发布清单", false);
      response.json(manifest);
    } catch (error) { next(error); }
  });

  app.get("/api/v1/media/:sha256", async (request, response, next) => {
    try {
      const bytes = await dependencies.cas.get(request.params.sha256);
      const prefix = bytes.subarray(0, 256).toString("utf8").trimStart();
      response.setHeader("Content-Type", prefix.startsWith("<svg") ? "image/svg+xml" : "image/png");
      response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      response.send(bytes);
    } catch (error) { next(error); }
  });

  app.post("/api/v1/imports", upload.single("file"), async (request, response, next) => {
    try {
      if (!request.file) return sendError(request, response, 400, "FILE_REQUIRED", "请选择要导入的文件", false);
      const idempotencyKey = requireIdempotencyKey(request);
      const existing = (await dependencies.operations.read()).idempotency[idempotencyKey];
      if (existing) {
        const replay = (await dependencies.operations.read()).imports.find((item) => item.id === existing.objectId);
        if (replay) return response.status(200).json(replay);
      }
      const inspection = inspectUpload(request.file.originalname, request.file.mimetype, request.file.buffer);
      const cas = await dependencies.cas.put(request.file.buffer);
      const record = await dependencies.operations.mutate((state) => {
        const now = new Date().toISOString();
        const autoGenerate = String(request.body.autoGenerate ?? "true").toLowerCase() !== "false";
        const item = {
          id: randomUUID(),
          workspaceId: request.header("X-Workspace-Id") || "personal",
           courseId: asOptionalString(request.body.courseId),
           parentNodeId: asOptionalString(request.body.parentNodeId),
          originalName: request.file!.originalname,
          mediaType: inspection.detectedMediaType || request.file!.mimetype,
          kind: inspection.kind || "syllabus" as const,
          sizeBytes: request.file!.size,
          sha256: cas.sha256,
          casPath: cas.absolutePath,
          source: String(request.body.source || "user_upload"),
          license: String(request.body.license || "private_course_material"),
          qualityMode: normalizeQualityMode(request.body.qualityMode),
          language: String(request.body.language || "zh-CN"),
          autoGenerate,
          generationState: autoGenerate ? "queued" as const : "not_requested" as const,
          sensitivity: "private" as const,
          state: inspection.accepted ? "accepted" as const : "rejected" as const,
          issues: inspection.issues,
          createdAt: now
        };
        state.imports.push(item);
        state.idempotency[idempotencyKey] = { kind: "import", objectId: item.id };
        dependencies.operations.appendEvent(state, item.id, inspection.accepted ? "import.accepted" : "import.rejected", { sha256: item.sha256, issues: item.issues, deduplicated: cas.deduplicated });
        return item;
      });
      if (record.state === "accepted") queueMicrotask(() => processImport(record.id, dependencies).catch(() => undefined));
      response.status(inspection.accepted ? 201 : 422).json(record);
    } catch (error) { next(error); }
  });

  app.get("/api/v1/imports/:id", async (request, response, next) => {
    try {
      const snapshot = await dependencies.operations.read();
      const record = snapshot.imports.find((item) => item.id === request.params.id);
      if (!record) return sendError(request, response, 404, "IMPORT_NOT_FOUND", "没有找到这次材料导入", false);
      const job = snapshot.jobs.find((item) => item.id === record.generationJobId || item.sourceImportId === record.id);
      response.json(job ? { ...record, generationJobId: job.id, generationState: job.state } : record);
    } catch (error) { next(error); }
  });

  app.delete("/api/v1/imports/:id", async (request, response, next) => {
    try {
      const record = (await dependencies.operations.read()).imports.find((item) => item.id === request.params.id);
      if (!record) return response.status(204).end();
      if (!["failed", "rejected"].includes(record.state)) return sendError(request, response, 409, "IMPORT_DELETE_DENIED", "只能清理失败或被隔离的导入记录", false);
      const sourceReleaseId = record.materialVersionId || `material-version:${record.id}`;
      const sourceRelease = await dependencies.readweave.getRelease(sourceReleaseId);
      if (sourceRelease?.lifecycle === "draft_source") {
        await dependencies.readweave.removeDraftSource(sourceReleaseId, systemWriteContext(`cleanup-import:${record.id}`, record.workspaceId));
      }
      await dependencies.operations.mutate((state) => {
        state.imports = state.imports.filter((item) => item.id !== record.id);
        state.events = state.events.filter((event) => event.streamId !== record.id);
        for (const [key, value] of Object.entries(state.idempotency)) if (value.objectId === record.id) delete state.idempotency[key];
      });
      response.status(204).end();
    } catch (error) { next(error); }
  });

  app.get("/api/v1/imports/:id/events", streamEvents(dependencies.operations));

  app.post("/api/v1/generation-jobs", async (request, response, next) => {
    try {
      const idempotencyKey = requireIdempotencyKey(request);
      const snapshot = await dependencies.operations.read();
      const replay = snapshot.idempotency[idempotencyKey];
      if (replay) {
        const job = snapshot.jobs.find((item) => item.id === replay.objectId);
        if (job) return response.json(job);
      }
      const budgetUsd = Number(request.body.budgetUsd ?? 4);
      if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 8) return sendError(request, response, 422, "BUDGET_INVALID", "单次任务预算必须大于 0 且不超过 8 美元", false);
      const materialVersionId = String(request.body.materialVersionId || "").trim();
      if (!materialVersionId) return sendError(request, response, 422, "MATERIAL_VERSION_REQUIRED", "生成任务必须指定材料版本", false);
      const workspaceId = request.header("X-Workspace-Id") || "personal";
      const release = await getWorkspaceRelease(dependencies.readweave, materialVersionId, workspaceId);
      if (!release) return sendError(request, response, 404, "MATERIAL_VERSION_NOT_FOUND", "没有找到要生成的材料版本", false);
      const pageIds: string[] = Array.isArray(request.body.pageIds)
        ? Array.from(new Set<string>(request.body.pageIds.map((value: unknown) => String(value).trim()).filter((id: string) => Boolean(id))))
        : [];
      if (pageIds.length === 0) return sendError(request, response, 422, "PAGE_IDS_REQUIRED", "生成任务至少要包含 1 个页面", false);
      const unknownPageIds = pageIds.filter((pageId) => !release.pageIds.includes(pageId));
      if (unknownPageIds.length > 0) return sendError(request, response, 422, "PAGE_IDS_INVALID", "生成任务包含不属于材料版本的页面", false, { pageIds: unknownPageIds });
      const result = await persistGenerationJob({
        idempotencyKey,
        workspaceId,
        materialVersionId,
        pageIds,
        budgetUsd,
        qualityMode: request.body.qualityMode === "economy" || request.body.qualityMode === "balanced" || request.body.qualityMode === "quality" ? request.body.qualityMode : generationQualityMode(budgetUsd),
        language: String(request.body.language || "zh-CN"),
        writingPolicySnapshotId: release.writingPolicySnapshotId
      }, dependencies);
      if (result.created) startGenerationJob(result.job.id, dependencies);
      response.status(result.created ? 202 : 200).json(result.job);
    } catch (error) { next(error); }
  });

  app.get("/api/v1/generation-jobs/:id", async (request, response, next) => {
    try {
      const workspaceId = request.header("X-Workspace-Id") || "personal";
      const job = (await dependencies.operations.read()).jobs.find((item) => item.id === request.params.id && item.workspaceId === workspaceId);
      if (!job) return sendError(request, response, 404, "JOB_NOT_FOUND", "没有找到这个生成任务", false);
      response.json(job);
    } catch (error) { next(error); }
  });

  app.get("/api/v1/costs", async (request, response, next) => {
    try {
      const filters = {
        courseId: asOptionalString(request.query.courseId),
        materialVersionId: asOptionalString(request.query.materialVersionId),
        pageId: asOptionalString(request.query.pageId),
        jobId: asOptionalString(request.query.jobId)
      };
      const workspaceId = request.header("X-Workspace-Id") || "personal";
      const entries = (await dependencies.readweave.listCostEntries(filters)).filter((entry) => entry.workspaceId === workspaceId);
      response.json({ entries, rollups: buildCostRollups(entries) });
    } catch (error) { next(error); }
  });

  app.post(/^\/api\/v1\/generation-jobs\/[^/]+:cancel$/, async (request, response, next) => {
    try {
      const jobId = request.path.slice("/api/v1/generation-jobs/".length, -":cancel".length);
      const workspaceId = request.header("X-Workspace-Id") || "personal";
      const job = await dependencies.operations.mutate((state) => {
        const current = state.jobs.find((item) => item.id === jobId && item.workspaceId === workspaceId);
        if (!current) return undefined;
        if (["completed", "cancelled"].includes(current.state)) return current;
        current.cancelRequested = true;
        const cancelled = transitionJob(current, "cancelled");
        Object.assign(current, cancelled);
        dependencies.operations.appendEvent(state, current.id, "job.cancelled", { completedPageIds: current.completedPageIds });
        return current;
      });
      if (!job) return sendError(request, response, 404, "JOB_NOT_FOUND", "没有找到这个生成任务", false);
      response.json(job);
    } catch (error) { next(error); }
  });

  app.post(/^\/api\/v1\/generation-jobs\/[^/]+:retry$/, async (request, response, next) => {
    try {
      const jobId = request.path.slice("/api/v1/generation-jobs/".length, -":retry".length);
      const workspaceId = request.header("X-Workspace-Id") || "personal";
      const retried = await dependencies.operations.mutate((state) => {
        const job = state.jobs.find((item) => item.id === jobId && item.workspaceId === workspaceId);
        if (!job) return undefined;
        if (!["failed", "completed"].includes(job.state)) throw new Error("GENERATION_RETRY_STATE_INVALID");
        if (job.failedPageIds.length === 0) throw new Error("GENERATION_RETRY_HAS_NO_FAILED_PAGES");
        const retryPageIds = [...job.failedPageIds];
        Object.assign(job, transitionJob(job, "queued"), { pageIds: retryPageIds, completedPageIds: [], failedPageIds: [], cancelRequested: false });
        dependencies.operations.appendEvent(state, job.id, "job.retry.queued", { pageIds: retryPageIds, nextAttempt: job.attempt + 1 });
        return structuredClone(job);
      });
      if (!retried) return sendError(request, response, 404, "JOB_NOT_FOUND", "没有找到这个生成任务", false);
      if (process.env.COURSE_OS_EXTERNAL_WORKER !== "true") queueMicrotask(() => runLocalJob(retried.id, dependencies).catch(() => undefined));
      response.status(202).json(retried);
    } catch (error) { next(error); }
  });

  app.post("/api/internal/worker/jobs/:id/run", async (request, response, next) => {
    try {
      const expected = process.env.COURSE_OS_WORKER_TOKEN?.trim();
      if (!expected || request.header("X-Course-Worker-Token") !== expected) return sendError(request, response, 404, "WORKER_ENDPOINT_NOT_FOUND", "后台任务入口未启用", false);
      const job = (await dependencies.operations.read()).jobs.find((item) => item.id === request.params.id && item.workspaceId === (request.header("X-Workspace-Id") || "personal"));
      if (!job) return sendError(request, response, 404, "JOB_NOT_FOUND", "没有找到这个生成任务", false);
      if (job.state === "queued" && !job.cancelRequested) queueMicrotask(() => runLocalJob(job.id, dependencies).catch(() => undefined));
      response.status(202).json(job);
    } catch (error) { next(error); }
  });

  app.get("/api/v1/generation-jobs/:id/events", async (request, response, next) => {
    try {
      const workspaceId = request.header("X-Workspace-Id") || "personal";
      const job = (await dependencies.operations.read()).jobs.find((item) => item.id === request.params.id && item.workspaceId === workspaceId);
      if (!job) return sendError(request, response, 404, "JOB_NOT_FOUND", "没有找到这个生成任务", false);
      return streamEvents(dependencies.operations)(request, response);
    } catch (error) { next(error); }
  });

  app.post("/api/v1/sessions", async (request, response, next) => {
    try {
      const releaseId = String(request.body.courseReleaseId || "");
      const workspaceId = request.header("X-Workspace-Id") || "personal";
      const release = await getWorkspaceRelease(dependencies.readweave, releaseId, workspaceId);
      if (!release) return sendError(request, response, 404, "RELEASE_NOT_FOUND", "没有找到要学习的课程版本", false);
      const requestedId = asOptionalString(request.body.sessionId);
      const session = await dependencies.operations.mutate((state) => {
        const existing = requestedId ? state.sessions.find((item) => item.id === requestedId && item.courseReleaseId === releaseId && (item.workspaceId ?? workspaceId) === workspaceId) : undefined;
        if (existing) return existing;
        const created: LearningSession = { id: randomUUID(), workspaceId, courseReleaseId: releaseId, currentPageId: release.pageIds[0] ?? "", explanationScroll: 0, zoom: 1, panX: 0, panY: 0, updatedAt: new Date().toISOString() };
        state.sessions.push(created);
        return created;
      });
      response.status(requestedId ? 200 : 201).json(session);
    } catch (error) { next(error); }
  });

  app.patch("/api/v1/sessions/:id", async (request, response, next) => {
    try {
      const workspaceId = request.header("X-Workspace-Id") || "personal";
      const session = await dependencies.operations.mutate((state) => {
        const current = state.sessions.find((item) => item.id === request.params.id && (item.workspaceId ?? workspaceId) === workspaceId);
        if (!current) return undefined;
        const allowed = ["currentPageId", "currentAnchorId", "explanationScroll", "zoom", "panX", "panY"] as const;
        for (const key of allowed) if (request.body[key] !== undefined) Object.assign(current, { [key]: request.body[key] });
        current.updatedAt = new Date().toISOString();
        return current;
      });
      if (!session) return sendError(request, response, 404, "SESSION_NOT_FOUND", "没有找到这个学习会话", false);
      response.json(session);
    } catch (error) { next(error); }
  });

  app.post("/api/v1/sessions/:id/questions", async (request, response, next) => {
    try {
      const workspaceId = request.header("X-Workspace-Id") || "personal";
      const session = (await dependencies.operations.read()).sessions.find((item) => item.id === request.params.id && (item.workspaceId ?? workspaceId) === workspaceId);
      if (!session) return sendError(request, response, 404, "SESSION_NOT_FOUND", "没有找到这个学习会话", false);
      const release = await getWorkspaceRelease(dependencies.readweave, session.courseReleaseId, workspaceId);
      const page = release?.pages.find((item) => item.id === String(request.body.pageId || session.currentPageId));
      if (!release || !page) return sendError(request, response, 404, "PAGE_NOT_FOUND", "没有找到问题对应的课程页面", false);
      const hintLevel = clampHintLevel(Number(request.body.hintLevel || 1));
      const now = new Date().toISOString();
      const question: PageQuestion = {
        id: randomUUID(), sessionId: session.id, courseReleaseId: release.id, pageId: page.id,
        anchorIds: Array.isArray(request.body.anchorIds) ? request.body.anchorIds.map(String) : [page.anchors[0]?.id || ""],
        learnerAttempt: String(request.body.learnerAttempt || ""), question: String(request.body.question || ""), hintLevel,
        response: buildHint(page.blocks.find((block) => block.kind === "check")?.markdown || "", hintLevel),
        reviewPolicy: "include", status: "active", revision: 1, createdAt: now, updatedAt: now
      };
      const context = writeContext(request, requireIdempotencyKey(request));
      response.status(201).json(await dependencies.readweave.saveQuestion(question, context));
    } catch (error) { next(error); }
  });

  app.post(/^\/api\/v1\/pages\/[^/]+\/questions:select$/, async (request, response, next) => {
    try {
      const pageId = decodeURIComponent(request.path.slice("/api/v1/pages/".length, -"/questions:select".length));
      const sessionId = String(request.body.sessionId || "");
      const workspaceId = request.header("X-Workspace-Id") || "personal";
      const session = (await dependencies.operations.read()).sessions.find((item) => item.id === sessionId && (item.workspaceId ?? workspaceId) === workspaceId);
      if (!session) return sendError(request, response, 404, "SESSION_NOT_FOUND", "没有找到这个学习会话", false);
      const release = await getWorkspaceRelease(dependencies.readweave, session.courseReleaseId, workspaceId);
      const page = release?.pages.find((item) => item.id === pageId);
      if (!release || !page) return sendError(request, response, 404, "PAGE_NOT_FOUND", "没有找到题目对应的课程页面", false);
      const seed = String(request.body.seed || `${session.id}:${page.id}:${new Date().toISOString().slice(0, 10)}`);
      const count = Math.max(1, Math.min(4, Number(request.body.count || 2)));
      const bank = page.questionBank ?? legacyQuestionBank(release, page.id);
      const questions = selectQuestionBank(bank, seed, count);
      const selection: QuestionSelection = {
        id: randomUUID(), sessionId: session.id, courseReleaseId: release.id, pageId: page.id, seed,
        questionIds: questions.map((item) => item.id), createdAt: new Date().toISOString()
      };
      const saved = await dependencies.readweave.saveQuestionSelection(selection, writeContext(request, requireIdempotencyKey(request)));
      response.status(201).json({
        selection: saved,
        questions,
        available: bank.filter((item) => item.status === "approved").length,
        draftCount: bank.filter((item) => item.status === "draft").length
      });
    } catch (error) { next(error); }
  });

  app.post(/^\/api\/v1\/pages\/[^/]+\/questions:refill$/, async (request, response, next) => {
    try {
      const pageId = decodeURIComponent(request.path.slice("/api/v1/pages/".length, -"/questions:refill".length));
      const workspaceId = request.header("X-Workspace-Id") || "personal";
      const existingDraftCandidate = await dependencies.readweave.getDraftByPage(pageId);
      const releases = await listWorkspaceReleases(dependencies.readweave, workspaceId);
      const source = (await findPageSource(releases, pageId));
      const existingDraft = existingDraftCandidate && source && existingDraftCandidate.workspaceId === workspaceId && existingDraftCandidate.courseId === source.release.courseId
        ? existingDraftCandidate
        : undefined;
      const draft = existingDraft && existingDraft.workspaceId === workspaceId
        ? existingDraft
        : (source ? createVirtualDraft(source.release, source.page, workspaceId) : undefined);
      if (!draft) return sendError(request, response, 404, "DRAFT_NOT_FOUND", "没有找到可以补题的页面草稿", false);
      const existing = draft.page.questionBank ?? [];
      const approved = existing.filter((item) => item.status === "approved");
      const generatedDrafts = existing.filter((item) => item.status === "draft" && item.generatedBy === "deterministic-refill-v1");
      const missing = Math.max(0, 4 - approved.length - generatedDrafts.length);
      if (missing === 0) {
        return response.json({ pageId, added: [], available: approved.length, draftCount: existing.filter((item) => item.status === "draft").length, revision: draft.revision, draft });
      }
      const added = refillQuestionBank(draft.page, missing).map((item) => ({ ...item, status: "draft" as const }));
      const page = { ...draft.page, questionBank: [...existing, ...added] };
      const saved = await dependencies.readweave.saveDraft({ ...draft, page, changedBlockIds: [...draft.changedBlockIds] }, Number(request.body.baseRevision ?? draft.revision), writeContext(request, requireIdempotencyKey(request)));
      response.status(201).json({
        pageId,
        added,
        available: saved.page.questionBank?.filter((item) => item.status === "approved").length ?? 0,
        draftCount: saved.page.questionBank?.filter((item) => item.status === "draft").length ?? 0,
        revision: saved.revision,
        draft: saved
      });
    } catch (error) { next(error); }
  });

  app.post(/^\/api\/v1\/questions\/[^/]+:retract$/, async (request, response, next) => {
    try {
      const questionId = decodeURIComponent(request.path.slice("/api/v1/questions/".length, -":retract".length));
      const current = (await dependencies.readweave.listQuestions()).find((item) => item.id === questionId);
      if (!current) return sendError(request, response, 404, "QUESTION_NOT_FOUND", "没有找到这条问答记录", false);
      const workspaceId = request.header("X-Workspace-Id") || "personal";
      if (!(await getWorkspaceRelease(dependencies.readweave, current.courseReleaseId, workspaceId))) return sendError(request, response, 404, "QUESTION_NOT_FOUND", "没有找到属于当前工作区的问答记录", false);
      const saved = await dependencies.readweave.updateQuestion({ ...current, status: "retracted" }, Number(request.body.baseRevision ?? current.revision), writeContext(request, requireIdempotencyKey(request)));
      response.json(saved);
    } catch (error) { next(error); }
  });

  app.patch("/api/v1/questions/:id/review-policy", async (request, response, next) => {
    try {
      const policy = String(request.body.reviewPolicy || "");
      if (!['include', 'exclude'].includes(policy)) return sendError(request, response, 422, "REVIEW_POLICY_INVALID", "复习策略必须是 include 或 exclude", false);
      const current = (await dependencies.readweave.listQuestions()).find((item) => item.id === request.params.id);
      if (!current) return sendError(request, response, 404, "QUESTION_NOT_FOUND", "没有找到这条问答记录", false);
      const workspaceId = request.header("X-Workspace-Id") || "personal";
      if (!(await getWorkspaceRelease(dependencies.readweave, current.courseReleaseId, workspaceId))) return sendError(request, response, 404, "QUESTION_NOT_FOUND", "没有找到属于当前工作区的问答记录", false);
      const saved = await dependencies.readweave.updateQuestion({ ...current, reviewPolicy: policy as "include" | "exclude" }, Number(request.body.baseRevision ?? current.revision), writeContext(request, requireIdempotencyKey(request)));
      response.json(saved);
    } catch (error) { next(error); }
  });

  app.post("/api/v1/question-attempts", async (request, response, next) => {
    try {
      const workspaceId = request.header("X-Workspace-Id") || "personal";
      const release = await getWorkspaceRelease(dependencies.readweave, String(request.body.courseReleaseId || ""), workspaceId);
      const page = release?.pages.find((item) => item.id === request.body.pageId);
      const item = page?.questionBank?.find((candidate) => candidate.id === request.body.questionId);
      if (!release || !page || !item) return sendError(request, response, 404, "QUESTION_NOT_FOUND", "没有找到这道随机问题", false);
      const answer = String(request.body.answer || "").trim();
      const correct = normalizeAnswer(answer) === normalizeAnswer(item.expectedAnswer);
      const attempt: QuestionAttempt = {
        id: randomUUID(), selectionId: String(request.body.selectionId || ""), sessionId: String(request.body.sessionId || ""),
        courseReleaseId: release.id, pageId: page.id, questionId: item.id, objectiveId: item.objectiveId,
        answer, correct, usedHintLevel: Math.max(0, Math.min(6, Number(request.body.usedHintLevel || 0))),
        misconception: correct ? undefined : `答案没有满足当前学习目标，正确思路是：${item.explanation}`,
        attemptedAt: new Date().toISOString()
      };
      const context = writeContext(request, requireIdempotencyKey(request));
      const masteryAttempt: AssessmentAttempt = { id: attempt.id, itemId: item.id, objectiveId: item.objectiveId, answer, correct, usedHintLevel: attempt.usedHintLevel, misconception: attempt.misconception, attemptedAt: attempt.attemptedAt };
      const saved = await dependencies.readweave.saveQuestionAttemptTransaction(attempt, masteryAttempt, (previous) => applyAttempt(previous, masteryAttempt), context);
      response.status(201).json({ attempt: saved.attempt, mastery: saved.mastery, feedback: saved.attempt.correct ? item.explanation : saved.attempt.misconception });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/assessment-attempts", async (request, response, next) => {
    try {
      const workspaceId = request.header("X-Workspace-Id") || "personal";
      const release = await getWorkspaceRelease(dependencies.readweave, String(request.body.courseReleaseId || ""), workspaceId);
      const item = release?.assessments.find((candidate) => candidate.id === request.body.itemId);
      if (!release || !item) return sendError(request, response, 404, "ASSESSMENT_NOT_FOUND", "没有找到这道题", false);
      const answer = String(request.body.answer || "").trim();
      const correct = normalizeAnswer(answer) === normalizeAnswer(item.expectedAnswer);
      const previous = (await dependencies.readweave.listMastery()).find((record) => record.objectiveId === item.objectiveId);
      const attempt: AssessmentAttempt = {
        id: randomUUID(), itemId: item.id, objectiveId: item.objectiveId, answer, correct,
        usedHintLevel: Math.max(0, Math.min(6, Number(request.body.usedHintLevel || 0))),
        misconception: correct ? undefined : "答案没有满足当前学习目标，需要回到本页例子定位错误步骤",
        attemptedAt: new Date().toISOString()
      };
      const mastery = applyAttempt(previous, attempt);
      await dependencies.operations.mutate((state) => state.attempts.push(attempt));
      await dependencies.readweave.saveAttempt(attempt, mastery, writeContext(request, requireIdempotencyKey(request)));
      response.status(201).json({ attempt, mastery, feedback: correct ? "回答正确，请继续完成延迟或迁移题" : attempt.misconception });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/review-map", async (request, response, next) => {
    try { response.json(await buildReviewMap(dependencies.readweave, new Date(), request.header("X-Workspace-Id") || "personal")); }
    catch (error) { next(error); }
  });

  app.post("/api/v1/review-plans", async (request, response, next) => {
    try {
      const idempotencyKey = requireIdempotencyKey(request);
      const workspaceId = request.header("X-Workspace-Id") || "personal";
      const existingState = await dependencies.operations.read();
      const replay = existingState.idempotency[idempotencyKey];
      if (replay?.kind === "review_plan") {
        const existing = existingState.reviewPlans.find((item) => item.id === replay.objectId);
        if (!existing) throw new Error("REVIEW_PLAN_IDEMPOTENCY_CORRUPT");
        return response.status(200).json({ plan: existing });
      }
      const source = request.body.source === "due" || request.body.source === "manual" ? request.body.source as "due" | "manual" : undefined;
      if (!source) return sendError(request, response, 422, "REVIEW_PLAN_SOURCE_INVALID", "复习来源必须是到期复习或主动复习", false);
      const rawObjectiveIds: string[] = Array.isArray(request.body.objectiveIds) ? (request.body.objectiveIds as unknown[]).map((item): string => String(item)).filter((item): item is string => item.length > 0) : [];
      const objectiveIds: string[] = Array.from(new Set<string>(rawObjectiveIds));
      if (objectiveIds.length === 0) return sendError(request, response, 422, "REVIEW_PLAN_OBJECTIVES_REQUIRED", "请先选择至少一个学习目标", false);
      const map = await buildReviewMap(dependencies.readweave, new Date(), workspaceId);
      const selected = objectiveIds.map((id) => map.objectives.find((item) => item.objectiveId === id));
      if (selected.some((item) => !item)) return sendError(request, response, 422, "REVIEW_PLAN_OBJECTIVE_INVALID", "所选目标不属于当前正式发布版本", false);
      if (source === "due" && selected.some((item) => !item!.due)) return sendError(request, response, 422, "REVIEW_PLAN_DUE_OBJECTIVE_INVALID", "到期复习只能选择当前已经到期的目标", false);
      const budgetUsd = Number(request.body.budgetUsd ?? 4);
      if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 8) return sendError(request, response, 422, "REVIEW_PLAN_BUDGET_INVALID", "复习计划预算必须大于 0 且不超过 8 美元", false);
      const seed = String(request.body.seed || `${source}:${new Date().toISOString()}`);
      const planId = `review-plan:${sha256Text(`${workspaceId}:${idempotencyKey}`)}`;
      const now = new Date().toISOString();
      const placeholder: ReviewPlan = {
        id: planId,
        workspaceId,
        source,
        seed,
        objectiveIds,
        items: [],
        budgetUsd,
        cost: { estimatedMicrousd: 0, actualMicrousd: 0, cashCostMicrousd: 0, quotaConsumedMicrousd: 0, reusedQuestionCount: 0, generatedQuestionCount: 0 },
        status: "preparing",
        syncState: "connected",
        revision: 0,
        createdAt: now,
        updatedAt: now
      };
      const created = await dependencies.operations.mutate((state) => {
        const concurrent = state.idempotency[idempotencyKey];
        if (concurrent) {
          const existing = state.reviewPlans.find((item) => item.id === concurrent.objectId);
          if (!existing) throw new Error("REVIEW_PLAN_IDEMPOTENCY_CORRUPT");
          return structuredClone(existing);
        }
        state.reviewPlans.push(structuredClone(placeholder));
        state.idempotency[idempotencyKey] = { kind: "review_plan", objectId: planId };
        dependencies.operations.appendEvent(state, planId, "review.plan.created", { objectiveIds, source, seed });
        return structuredClone(placeholder);
      });
      if (created.status !== "preparing") return response.status(200).json({ plan: created });
      try {
        const prepared = await prepareReviewPlan(dependencies.readweave, map, objectiveIds, planId, budgetUsd, workspaceId, writeContext(request, `${idempotencyKey}:prepare`));
        const saved = await dependencies.readweave.saveReviewPlan({ ...placeholder, ...prepared }, writeContext(request, `${idempotencyKey}:save`));
        const savedReadBack = await dependencies.readweave.getReviewPlan(saved.id);
        if (!savedReadBack || savedReadBack.id !== saved.id) throw new Error("READWEAVE_REVIEW_PLAN_READBACK_FAILED");
        const readyCandidate: ReviewPlan = { ...savedReadBack, status: "ready", syncState: "connected", error: undefined, updatedAt: new Date().toISOString() };
        const ready = await dependencies.readweave.updateReviewPlan(readyCandidate, savedReadBack.revision, writeContext(request, `${idempotencyKey}:ready`));
        const verified = await dependencies.readweave.getReviewPlan(ready.id);
        if (!verified || verified.status !== "ready") throw new Error("READWEAVE_REVIEW_PLAN_READY_READBACK_FAILED");
        const stored = await dependencies.operations.mutate((state) => {
          const current = state.reviewPlans.find((item) => item.id === planId);
          if (!current) throw new Error("REVIEW_PLAN_NOT_FOUND");
          Object.assign(current, structuredClone(verified));
          dependencies.operations.appendEvent(state, planId, "review.plan.ready", { objectiveIds: verified.objectiveIds, cost: verified.cost });
          return structuredClone(current);
        });
        return response.status(201).json({ plan: stored });
      } catch (error) {
        const message = error instanceof Error ? error.message : "REVIEW_PLAN_PREPARE_FAILED";
        const syncPending = /READWEAVE|ETAPI|HTTP_5|network|fetch/i.test(message);
        const failed = await dependencies.operations.mutate((state) => {
          const current = state.reviewPlans.find((item) => item.id === planId);
          if (!current) throw new Error("REVIEW_PLAN_NOT_FOUND");
          current.status = syncPending ? "sync_pending" : "failed";
          current.syncState = syncPending ? "offline" : "connected";
          current.error = message.slice(0, 240);
          current.updatedAt = new Date().toISOString();
          dependencies.operations.appendEvent(state, planId, syncPending ? "review.plan.sync_pending" : "review.plan.failed", { message: current.error });
          return structuredClone(current);
        });
        return response.status(syncPending ? 202 : 422).json({ plan: failed, error: message });
      }
    } catch (error) { next(error); }
  });

  app.get("/api/v1/review-plans/:id", async (request, response, next) => {
    try {
      const remote = await dependencies.readweave.getReviewPlan(request.params.id).catch(() => undefined);
      const local = (await dependencies.operations.read()).reviewPlans.find((item) => item.id === request.params.id);
      const plan = remote ?? local;
      if (!plan) return sendError(request, response, 404, "REVIEW_PLAN_NOT_FOUND", "没有找到这个复习计划", false);
      if (plan.workspaceId !== (request.header("X-Workspace-Id") || "personal")) return sendError(request, response, 404, "REVIEW_PLAN_NOT_FOUND", "没有找到这个复习计划", false);
      response.json({ plan });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/review-plans/:id/events", async (request, response, next) => {
    try {
      const workspaceId = request.header("X-Workspace-Id") || "personal";
      const plan = (await dependencies.operations.read()).reviewPlans.find((item) => item.id === request.params.id && item.workspaceId === workspaceId);
      if (!plan) return sendError(request, response, 404, "REVIEW_PLAN_NOT_FOUND", "没有找到这个复习计划", false);
      return streamEvents(dependencies.operations)(request, response);
    } catch (error) { next(error); }
  });

  app.post(/^\/api\/v1\/review-plans\/[^/]+:retry$/, async (request, response, next) => {
    try {
      const idempotencyKey = requireIdempotencyKey(request);
      const planId = decodeURIComponent(request.path.slice("/api/v1/review-plans/".length, -":retry".length));
      const before = await dependencies.operations.read();
      const replay = before.idempotency[idempotencyKey];
      if (replay?.kind === "review_plan" && replay.objectId === planId) {
        const existing = before.reviewPlans.find((item) => item.id === planId);
        if (existing) return response.status(200).json({ plan: existing });
      }
      const local = before.reviewPlans.find((item) => item.id === planId);
      const remote = await dependencies.readweave.getReviewPlan(planId).catch(() => undefined);
      const current = remote ?? local;
      if (!current) return sendError(request, response, 404, "REVIEW_PLAN_NOT_FOUND", "没有找到这个复习计划", false);
      if (current.workspaceId !== (request.header("X-Workspace-Id") || "personal")) return sendError(request, response, 404, "REVIEW_PLAN_NOT_FOUND", "没有找到这个复习计划", false);
      if (current.status !== "failed" && current.status !== "sync_pending") return sendError(request, response, 409, "REVIEW_PLAN_RETRY_INVALID", "只有失败或等待同步的计划可以重试", false);
      const map = await buildReviewMap(dependencies.readweave, new Date(), request.header("X-Workspace-Id") || "personal");
      const prepared = await prepareReviewPlan(dependencies.readweave, map, current.objectiveIds, current.id, current.budgetUsd, current.workspaceId, writeContext(request, `${idempotencyKey}:prepare`));
      const candidate: ReviewPlan = { ...current, ...prepared, status: "ready", syncState: "connected", error: undefined, updatedAt: new Date().toISOString() };
      const saved = remote
        ? await dependencies.readweave.updateReviewPlan(candidate, remote.revision, writeContext(request, `${idempotencyKey}:update`))
        : await dependencies.readweave.saveReviewPlan({ ...candidate, revision: 0 }, writeContext(request, `${idempotencyKey}:save`));
      const verified = await dependencies.readweave.getReviewPlan(saved.id);
      if (!verified || verified.status !== "ready") throw new Error("READWEAVE_REVIEW_PLAN_READY_READBACK_FAILED");
      const stored = await dependencies.operations.mutate((state) => {
        const item = state.reviewPlans.find((plan) => plan.id === current.id);
        if (item) Object.assign(item, structuredClone(verified));
        state.idempotency[idempotencyKey] = { kind: "review_plan", objectId: current.id };
        dependencies.operations.appendEvent(state, current.id, "review.plan.ready", { retry: true });
        return structuredClone(item ?? verified);
      });
      response.json({ plan: stored });
    } catch (error) { next(error); }
  });

  app.post(/^\/api\/v1\/review-plans\/[^/]+:cancel$/, async (request, response, next) => {
    try {
      const idempotencyKey = requireIdempotencyKey(request);
      const planId = decodeURIComponent(request.path.slice("/api/v1/review-plans/".length, -":cancel".length));
      const before = await dependencies.operations.read();
      const replay = before.idempotency[idempotencyKey];
      if (replay?.kind === "review_plan" && replay.objectId === planId) {
        const existing = before.reviewPlans.find((item) => item.id === planId);
        if (existing) return response.status(200).json({ plan: existing });
      }
      const local = before.reviewPlans.find((item) => item.id === planId);
      const remote = await dependencies.readweave.getReviewPlan(planId).catch(() => undefined);
      const current = remote ?? local;
      if (!current) return sendError(request, response, 404, "REVIEW_PLAN_NOT_FOUND", "没有找到这个复习计划", false);
      if (current.workspaceId !== (request.header("X-Workspace-Id") || "personal")) return sendError(request, response, 404, "REVIEW_PLAN_NOT_FOUND", "没有找到这个复习计划", false);
      if (current.status === "started") return sendError(request, response, 409, "REVIEW_PLAN_ALREADY_STARTED", "已经开始的复习计划不能取消", false);
      const cancelled = await dependencies.readweave.updateReviewPlan({ ...current, status: "cancelled", updatedAt: new Date().toISOString() }, current.revision, writeContext(request, idempotencyKey));
      const stored = await dependencies.operations.mutate((state) => {
        const item = state.reviewPlans.find((plan) => plan.id === current.id);
        if (item) Object.assign(item, structuredClone(cancelled));
        state.idempotency[idempotencyKey] = { kind: "review_plan", objectId: current.id };
        dependencies.operations.appendEvent(state, current.id, "review.plan.cancelled", {});
        return structuredClone(item ?? cancelled);
      });
      response.json({ plan: stored });
    } catch (error) { next(error); }
  });

  app.post(/^\/api\/v1\/review-plans\/[^/]+:start$/, async (request, response, next) => {
    try {
      const idempotencyKey = requireIdempotencyKey(request);
      const before = await dependencies.operations.read();
      const replay = before.idempotency[idempotencyKey];
      if (replay?.kind === "review_session") {
        const existing = before.reviewSessions.find((item) => item.id === replay.objectId);
        if (!existing) throw new Error("REVIEW_SESSION_IDEMPOTENCY_CORRUPT");
        const map = await buildReviewMap(dependencies.readweave, new Date(), request.header("X-Workspace-Id") || "personal");
        const objective = map.objectives.find((item) => item.objectiveId === existing.currentObjectiveId);
        return response.status(200).json({ session: existing, objective, question: objective ? await reviewQuestionFor(dependencies.readweave, existing, objective) : undefined });
      }
      const planId = decodeURIComponent(request.path.slice("/api/v1/review-plans/".length, -":start".length));
      const local = before.reviewPlans.find((item) => item.id === planId);
      const remote = await dependencies.readweave.getReviewPlan(planId).catch(() => undefined);
      const plan = remote ?? local;
      if (!plan) return sendError(request, response, 404, "REVIEW_PLAN_NOT_FOUND", "没有找到这个复习计划", false);
      if (plan.workspaceId !== (request.header("X-Workspace-Id") || "personal")) return sendError(request, response, 404, "REVIEW_PLAN_NOT_FOUND", "没有找到这个复习计划", false);
      if (plan.status !== "ready") return sendError(request, response, 409, "REVIEW_PLAN_NOT_READY", plan.status === "sync_pending" ? "复习内容尚未同步到 ReadWeave，请先重试保存" : "复习内容还没有准备完成", true);
      const startedRemote = await dependencies.readweave.updateReviewPlan({ ...plan, status: "started", syncState: "connected", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, plan.revision, writeContext(request, `${idempotencyKey}:plan`));
      const verified = await dependencies.readweave.getReviewPlan(startedRemote.id);
      if (!verified || verified.status !== "started") throw new Error("READWEAVE_REVIEW_PLAN_START_READBACK_FAILED");
      const map = await buildReviewMap(dependencies.readweave, new Date(), request.header("X-Workspace-Id") || "personal");
      const session = await dependencies.operations.mutate((state) => {
        const currentReplay = state.idempotency[idempotencyKey];
        if (currentReplay?.kind === "review_session") {
          const existing = state.reviewSessions.find((item) => item.id === currentReplay.objectId);
          if (existing) return structuredClone(existing);
        }
        const now = new Date().toISOString();
        const created: ReviewSession = {
          id: randomUUID(),
          workspaceId: plan.workspaceId,
          source: plan.source,
          seed: plan.seed,
          objectiveIds: [...plan.objectiveIds],
          reviewPlanId: plan.id,
          questionIdsByObjective: Object.fromEntries(plan.items.map((item) => [item.objectiveId, [...item.questionIds]])),
          currentIndex: 0,
          status: "active",
          currentObjectiveId: plan.objectiveIds[0],
          createdAt: now,
          updatedAt: now
        };
        state.reviewSessions.push(created);
        const storedPlan = state.reviewPlans.find((item) => item.id === plan.id);
        if (storedPlan) Object.assign(storedPlan, structuredClone(verified));
        state.idempotency[idempotencyKey] = { kind: "review_session", objectId: created.id };
        dependencies.operations.appendEvent(state, created.id, "review.started", { source: created.source, objectiveIds: created.objectiveIds, reviewPlanId: plan.id });
        return structuredClone(created);
      });
      const objective = map.objectives.find((item) => item.objectiveId === session.currentObjectiveId);
      response.status(201).json({ session, objective, question: objective ? await reviewQuestionFor(dependencies.readweave, session, objective) : undefined });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/review-sessions/current", async (request, response, next) => {
    try {
      const state = await dependencies.operations.read();
       const workspaceId = request.header("X-Workspace-Id") || "personal";
       const session = [...state.reviewSessions].reverse().find((item) => item.status === "active" && item.workspaceId === workspaceId);
      if (!session) return response.json({ session: null });
      const map = await buildReviewMap(dependencies.readweave, new Date(), request.header("X-Workspace-Id") || "personal");
      const objective = map.objectives.find((item) => item.objectiveId === session.currentObjectiveId);
      response.json({ session, objective, question: objective ? await reviewQuestionFor(dependencies.readweave, session, objective) : undefined });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/review-queue", async (request, response, next) => {
    try {
      const map = await buildReviewMap(dependencies.readweave, new Date(), request.header("X-Workspace-Id") || "personal");
      const mastery = await dependencies.readweave.listMastery();
      const dueIds = new Set(map.objectives.filter((item) => item.due).map((item) => item.objectiveId));
      response.json(mastery.filter((record) => dueIds.has(record.objectiveId)).sort((a, b) => (a.nextReviewAt || "").localeCompare(b.nextReviewAt || "")));
    } catch (error) { next(error); }
  });

  app.post("/api/v1/review-sessions", async (request, response, next) => {
    try {
      const map = await buildReviewMap(dependencies.readweave, new Date(), request.header("X-Workspace-Id") || "personal");
      const source = request.body.source === "manual" ? "manual" : "due";
      const requestedIds = Array.isArray(request.body.objectiveIds) ? request.body.objectiveIds.map(String).filter(Boolean) : [];
      const requested = requestedIds.length ? map.objectives.filter((item) => requestedIds.includes(item.objectiveId)) : [];
      const candidates = requested.length
        ? requested
        : source === "due"
          ? map.objectives.filter((item) => item.due)
          : map.objectives.filter((item) => item.state !== "mastered");
      if (candidates.length === 0) return sendError(request, response, 422, "REVIEW_NO_OBJECTIVES", source === "due" ? "当前没有到期复习目标，请从掌握地图开始主动复习" : "当前没有可以开始的复习目标", false);
      const seed = String(request.body.seed || `${source}:${new Date().toISOString()}`);
      const requestedCount = Number(request.body.count || candidates.length);
      const count = Math.max(1, Math.min(candidates.length, Number.isFinite(requestedCount) ? Math.trunc(requestedCount) : candidates.length));
      const objectiveIds = seededOrder(candidates.map((item) => item.objectiveId), seed).slice(0, count);
      const now = new Date().toISOString();
      const idempotencyKey = requireIdempotencyKey(request);
      const session = await dependencies.operations.mutate((state) => {
        const replay = state.idempotency[idempotencyKey];
        if (replay) {
          const existing = state.reviewSessions.find((item) => item.id === replay.objectId);
          if (!existing) throw new Error("REVIEW_SESSION_IDEMPOTENCY_CORRUPT");
          return existing;
        }
        const created: ReviewSession = {
          id: randomUUID(),
          workspaceId: request.header("X-Workspace-Id") || "personal",
          source,
          seed,
          objectiveIds,
          currentIndex: 0,
          status: "active",
          currentObjectiveId: objectiveIds[0],
          createdAt: now,
          updatedAt: now
        };
        state.reviewSessions.push(created);
        state.idempotency[idempotencyKey] = { kind: "review_session", objectId: created.id };
        dependencies.operations.appendEvent(state, created.id, "review.started", { source, objectiveIds });
        return created;
      });
      const objective = map.objectives.find((item) => item.objectiveId === session.currentObjectiveId);
      response.status(201).json({ session, objective, question: objective ? await reviewQuestionFor(dependencies.readweave, session, objective) : undefined });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/review-sessions/:id", async (request, response, next) => {
    try {
       const workspaceId = request.header("X-Workspace-Id") || "personal";
       const session = (await dependencies.operations.read()).reviewSessions.find((item) => item.id === request.params.id && item.workspaceId === workspaceId);
      if (!session) return sendError(request, response, 404, "REVIEW_SESSION_NOT_FOUND", "没有找到这个复习会话", false);
      const map = await buildReviewMap(dependencies.readweave, new Date(), request.header("X-Workspace-Id") || "personal");
      const objective = map.objectives.find((item) => item.objectiveId === session.currentObjectiveId);
      response.json({ session, objective, question: objective ? await reviewQuestionFor(dependencies.readweave, session, objective) : undefined });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/review-sessions/:id/attempts", async (request, response, next) => {
    try {
      const idempotencyKey = requireIdempotencyKey(request);
      const operational = await dependencies.operations.read();
       const session = operational.reviewSessions.find((item) => item.id === request.params.id && item.workspaceId === (request.header("X-Workspace-Id") || "personal"));
      if (!session) return sendError(request, response, 404, "REVIEW_SESSION_NOT_FOUND", "没有找到这个复习会话", false);
      const replay = operational.idempotency[idempotencyKey];
      if (replay?.kind === "review_attempt") {
        const savedAttempt = (await dependencies.readweave.listQuestionAttempts()).find((item) => item.id === replay.objectId);
        if (!savedAttempt) throw new Error("REVIEW_ATTEMPT_IDEMPOTENCY_CORRUPT");
        const mastery = (await dependencies.readweave.listMastery()).find((item) => item.objectiveId === savedAttempt.objectiveId);
        if (!mastery) throw new Error("REVIEW_MASTERY_IDEMPOTENCY_CORRUPT");
        const feedback = savedAttempt.correct ? "这次回答已经保存" : savedAttempt.misconception || "这次回答已经保存，请回到课程页重新定位错误步骤";
        return response.status(200).json({ attempt: savedAttempt, mastery, feedback, nextObjectiveId: session.currentObjectiveId, session: structuredClone(session) });
      }
      if (session.status !== "active" || !session.currentObjectiveId) return sendError(request, response, 409, "REVIEW_SESSION_NOT_ACTIVE", "这个复习会话已经结束", false);
      const map = await buildReviewMap(dependencies.readweave, new Date(), request.header("X-Workspace-Id") || "personal");
      const objective = map.objectives.find((item) => item.objectiveId === session.currentObjectiveId);
      const release = objective ? await dependencies.readweave.getRelease(objective.releaseId) : undefined;
      const page = release?.pages.find((item) => item.id === objective?.pageId);
      if (!objective || !release || !page) return sendError(request, response, 404, "REVIEW_OBJECTIVE_NOT_FOUND", "没有找到当前复习目标对应的课程页面", false);
      const requestedQuestionId = asOptionalString(request.body.questionId);
      const draft = await dependencies.readweave.getDraftByPage(page.id);
      const bank = uniqueQuestionBank(page.questionBank ?? [], draft?.page.questionBank ?? [], legacyQuestionBank(release, page.id)).filter((item) => item.status === "approved" && item.objectiveId === objective.objectiveId);
      const plannedQuestionId = session.questionIdsByObjective?.[objective.objectiveId]?.[0];
      const item = (requestedQuestionId ? bank.find((candidate) => candidate.id === requestedQuestionId) : undefined)
        ?? (plannedQuestionId ? bank.find((candidate) => candidate.id === plannedQuestionId) : undefined)
        ?? bank[0];
      if (!item) return sendError(request, response, 422, "REVIEW_QUESTION_NOT_READY", "当前目标还没有通过检查的复习题，请先回到制作模式补齐题库", false);
      const answer = String(request.body.answer || "").trim();
      const usedHintLevel = Math.max(0, Math.min(6, Number(request.body.usedHintLevel || 0)));
      const correct = normalizeAnswer(answer) === normalizeAnswer(item.expectedAnswer);
      const attemptedAt = new Date().toISOString();
      const attempt: QuestionAttempt = {
        id: randomUUID(),
        selectionId: `review-selection:${session.id}:${objective.objectiveId}`,
        sessionId: session.id,
        courseReleaseId: release.id,
        pageId: page.id,
        questionId: item.id,
        objectiveId: item.objectiveId,
        answer,
        correct,
        usedHintLevel,
        misconception: correct ? undefined : `答案没有满足当前学习目标，正确思路是：${item.explanation}`,
        attemptedAt
      };
      const context = writeContext(request, idempotencyKey);
      const selection: QuestionSelection = {
        id: attempt.selectionId,
        sessionId: session.id,
        courseReleaseId: release.id,
        pageId: page.id,
        seed: session.seed,
        questionIds: [item.id],
        createdAt: attemptedAt
      };
      await dependencies.readweave.saveQuestionSelection(selection, { ...context, idempotencyKey: `${idempotencyKey}:selection` });
      const savedAttempt = await dependencies.readweave.saveQuestionAttempt(attempt, { ...context, idempotencyKey: `${idempotencyKey}:question` });
      const previous = (await dependencies.readweave.listMastery()).find((record) => record.objectiveId === item.objectiveId);
      const masteryAttempt: AssessmentAttempt = { id: attempt.id, itemId: item.id, objectiveId: item.objectiveId, answer, correct, usedHintLevel, misconception: attempt.misconception, attemptedAt };
      const mastery = applyAttempt(previous, masteryAttempt);
      await dependencies.readweave.saveAttempt(masteryAttempt, mastery, { ...context, idempotencyKey: `${idempotencyKey}:mastery` });
      const updated = await dependencies.operations.mutate((state) => {
         const current = state.reviewSessions.find((candidate) => candidate.id === session.id && candidate.workspaceId === session.workspaceId);
        if (!current) throw new Error("REVIEW_SESSION_NOT_FOUND");
        const nextIndex = Math.min(current.objectiveIds.length, current.currentIndex + 1);
        const nextObjectiveId = current.objectiveIds[nextIndex];
        current.currentIndex = nextIndex;
        current.currentObjectiveId = nextObjectiveId;
        current.status = nextObjectiveId ? "active" : "completed";
        current.updatedAt = new Date().toISOString();
        if (!nextObjectiveId) current.completedAt = current.updatedAt;
        state.idempotency[idempotencyKey] = { kind: "review_attempt", objectId: attempt.id };
        dependencies.operations.appendEvent(state, current.id, nextObjectiveId ? "review.objective.completed" : "review.completed", { objectiveId: objective.objectiveId, correct, usedHintLevel });
        return structuredClone(current);
      });
      const result: ReviewAttemptResult = { attempt: savedAttempt, mastery, feedback: correct ? item.explanation : attempt.misconception || "请回到本页讲解重新定位错误步骤", nextObjectiveId: updated.currentObjectiveId };
      const nextObjective = updated.currentObjectiveId ? map.objectives.find((item) => item.objectiveId === updated.currentObjectiveId) : undefined;
      response.status(201).json({ ...result, session: updated, question: nextObjective ? await reviewQuestionFor(dependencies.readweave, updated, nextObjective) : undefined });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/review-sessions/:id/skip", async (request, response, next) => {
    try {
      const idempotencyKey = requireIdempotencyKey(request);
      const updated = await dependencies.operations.mutate((state) => {
         const current = state.reviewSessions.find((candidate) => candidate.id === request.params.id && candidate.workspaceId === (request.header("X-Workspace-Id") || "personal"));
        if (!current) throw new Error("REVIEW_SESSION_NOT_FOUND");
        const replay = state.idempotency[idempotencyKey];
        if (replay?.kind === "review_skip" && replay.objectId === current.id) return structuredClone(current);
        if (current.status !== "active") return structuredClone(current);
        const nextIndex = Math.min(current.objectiveIds.length, current.currentIndex + 1);
        current.currentIndex = nextIndex;
        current.currentObjectiveId = current.objectiveIds[nextIndex];
        current.status = current.currentObjectiveId ? "active" : "completed";
        current.updatedAt = new Date().toISOString();
        if (!current.currentObjectiveId) current.completedAt = current.updatedAt;
        state.idempotency[idempotencyKey] = { kind: "review_skip", objectId: current.id };
        dependencies.operations.appendEvent(state, current.id, "review.skipped", { nextObjectiveId: current.currentObjectiveId });
        return structuredClone(current);
      });
      const map = await buildReviewMap(dependencies.readweave, new Date(), request.header("X-Workspace-Id") || "personal");
      const objective = map.objectives.find((item) => item.objectiveId === updated.currentObjectiveId);
      response.json({ session: updated, objective, question: objective ? await reviewQuestionFor(dependencies.readweave, updated, objective) : undefined });
    } catch (error) { next(error); }
  });

  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    const raw = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    const mapped = mapApiError(raw);
    const details = raw.includes("REVISION_CONFLICT") ? { conflictId: raw.slice(raw.indexOf(":") + 1) } : undefined;
    sendError(request, response, mapped.status, mapped.code, mapped.message, mapped.retryable, details);
  });
  return app;
}

function mapApiError(raw: string): { status: number; code: string; message: string; retryable: boolean } {
  if (raw.includes("IDEMPOTENCY_KEY_REQUIRED")) return { status: 400, code: "IDEMPOTENCY_KEY_REQUIRED", message: "这项操作缺少唯一请求编号，请重新提交", retryable: false };
  if (raw.includes("FILE_TOO_LARGE")) return { status: 413, code: "FILE_TOO_LARGE", message: "文件超过允许大小，请压缩文件后再导入", retryable: false };
  if (raw.includes("REVISION_CONFLICT")) return { status: 409, code: "TREE_REVISION_CONFLICT", message: "这个项目已经被其他操作更新，请重新载入后再试", retryable: false };
  if (raw.includes("TREE_NODE_NOT_EDITABLE")) return { status: 409, code: "TREE_NODE_NOT_EDITABLE", message: "这个项目是只读版本，请从材料入口建立草稿", retryable: false };
  if (raw.includes("TREE_NODE_STALE") || raw.includes("TREE_NODE_NOT_FOUND")) return { status: 409, code: "TREE_NODE_STALE", message: "这个项目已经不在当前课程树中，请重新载入后再试", retryable: false };
  if (raw.includes("TREE_TARGET_NOT_FOUND") || raw.includes("TREE_PARENT_NOT_FOUND")) return { status: 422, code: "TREE_TARGET_NOT_FOUND", message: "目标位置不存在，请重新选择课程或材料", retryable: false };
  if (raw.includes("TREE_PARENT_CYCLE")) return { status: 422, code: "TREE_PARENT_CYCLE", message: "不能把项目移动到自己或自己的下级项目中", retryable: false };
  if (raw.startsWith("READWEAVE_ETAPI_") || raw.startsWith("READWEAVE_HTTP_") || raw.includes("READWEAVE_UNAVAILABLE")) return { status: 503, code: "READWEAVE_UNAVAILABLE", message: "ReadWeave 暂时不可访问，这项操作尚未保存，请稍后重试", retryable: true };
  if (raw.includes("NOT_FOUND")) return { status: 404, code: "RESOURCE_NOT_FOUND", message: "没有找到请求的课程内容，请重新载入后再试", retryable: false };
  if (raw.includes("PERMANENT_DELETE_UNSUPPORTED")) return { status: 409, code: "PERMANENT_DELETE_UNSUPPORTED", message: "当前 ReadWeave 不支持安全永久删除，这条记录会继续保留在回收站", retryable: false };
  return { status: 500, code: "INTERNAL_ERROR", message: "系统处理失败，请根据请求编号重试或排查", retryable: true };
}

function buildCourseTree(courses: CourseProject[], releases: CourseRelease[], drafts: LessonDraft[], metadataNodes: CourseTreeNode[] = [], _trashRecords: TrashRecord[] = []): CourseTreeNode[] {
  const formalCourses = courses.filter((course) => !isRegressionAsset(course.id, course.title) && course.status !== "archived");
  const formalReleases = releases.filter((release) => !isRegressionAsset(release.id, `${release.courseTitle} ${release.moduleTitle}`));
  const persistedMaterials = new Map(metadataNodes
    .filter((node) => node.kind === "material" && !node.archived && !isRegressionAsset(node.id, node.title, node.materialId ?? ""))
    .flatMap((node) => [[node.materialId || node.id, node], [node.id, node]]));
  const persistedCourses = new Map(metadataNodes
    .filter((node) => node.kind === "course" && !node.archived && !isRegressionAsset(node.id, node.title))
    .map((node) => [node.id, node]));
  const groups = new Map<string, CourseRelease[]>();
  for (const release of formalReleases) {
    const key = `${release.courseId}\u0000${release.moduleId}`;
    groups.set(key, [...(groups.get(key) ?? []), release]);
  }
  const materialRows: CourseTreeNode[] = [...groups.entries()].map(([key, moduleReleases]): CourseTreeNode => {
    const sorted = [...moduleReleases].sort((left, right) => right.version - left.version || right.publishedAt.localeCompare(left.publishedAt));
    const latestPublished = sorted.find((release) => release.lifecycle !== "draft_source");
    const current = latestPublished ?? sorted[0];
    const separator = key.indexOf("\u0000");
    const sourceCourseId = key.slice(0, separator);
    const moduleId = key.slice(separator + 1);
    const materialId = `material:${sourceCourseId}:${moduleId}`;
    const persisted = persistedMaterials.get(materialId);
    const parentId = persisted
      ? (persisted.parentId && formalCourses.some((candidate) => candidate.id === persisted.parentId) ? persisted.parentId : undefined)
      : sourceCourseId;
    const draftCount = drafts.filter((draft) => draft.courseId === sourceCourseId && draft.moduleId === moduleId).length;
    return {
      id: materialId,
      kind: "material" as const,
      title: persisted?.title || current?.moduleTitle || "未命名材料",
      subtitle: `${current?.pages.length ?? 0} 页 · ${current?.lifecycle === "draft_source" ? "待审核" : draftCount ? `${draftCount} 页有草稿` : "已就绪"}`,
      parentId,
      releaseId: current?.id,
      currentReleaseId: latestPublished?.id ?? current?.id,
      materialId,
      pageCount: current?.pages.length ?? 0,
      status: persisted?.archived ? "draft" as const : current?.lifecycle === "draft_source" ? "draft" as const : current?.pages.every((page) => page.quality.publishable) ? "published" as const : "needs_review" as const,
      revision: persisted?.revision ?? current?.version ?? 0,
      sortOrder: persisted?.sortOrder,
      archived: false,
      visibility: "library" as const,
      readweaveNoteId: persisted?.readweaveNoteId,
      capabilities: treeCapabilities("material"),
      children: []
    };
  });
  const generatedMaterialIds = new Set(materialRows.map((material) => material.id));
  for (const persisted of metadataNodes.filter((node) => node.kind === "material" && !node.archived && !isRegressionAsset(node.id, node.title, node.materialId ?? ""))) {
    if (generatedMaterialIds.has(persisted.id) || (persisted.materialId && generatedMaterialIds.has(persisted.materialId))) continue;
    const parentId = persisted.parentId && formalCourses.some((course) => course.id === persisted.parentId) ? persisted.parentId : undefined;
    materialRows.push({
      ...persisted,
      id: persisted.id,
      kind: "material",
      title: persisted.title,
      subtitle: persisted.subtitle ?? "材料尚未关联当前发布版本",
      parentId,
      pageCount: persisted.pageCount ?? 0,
      visibility: "library",
      capabilities: treeCapabilities("material"),
      children: []
    });
  }
  const courseNodes = formalCourses.map((course) => {
    const courseMetadata = persistedCourses.get(course.id);
    const materials = materialRows
      .filter((material) => material.parentId === course.id)
      .sort((left, right) => (left.sortOrder ?? Number.MAX_SAFE_INTEGER) - (right.sortOrder ?? Number.MAX_SAFE_INTEGER) || left.title.localeCompare(right.title, "zh-CN"));
    return {
      id: course.id,
      kind: "course" as const,
      title: course.title,
      subtitle: course.description || `${materials.length} 份材料`,
      status: "published" as const,
      revision: courseMetadata?.revision ?? course.revision ?? 0,
      sortOrder: courseMetadata?.sortOrder ?? course.sortOrder,
      archived: false,
      visibility: "library" as const,
      readweaveNoteId: course.readweaveNoteId ?? courseMetadata?.readweaveNoteId,
      capabilities: treeCapabilities("course"),
      children: materials
    } satisfies CourseTreeNode;
  }).sort((left, right) => (left.sortOrder ?? Number.MAX_SAFE_INTEGER) - (right.sortOrder ?? Number.MAX_SAFE_INTEGER) || left.title.localeCompare(right.title, "zh-CN"));
  const rootMaterials = materialRows
    .filter((material) => !material.parentId)
    .sort((left, right) => (left.sortOrder ?? Number.MAX_SAFE_INTEGER) - (right.sortOrder ?? Number.MAX_SAFE_INTEGER) || left.title.localeCompare(right.title, "zh-CN"));
  return [...courseNodes, ...rootMaterials];
}

function buildTrashNode(records: TrashRecord[], workspaceId: string): CourseTreeNode {
  const available = records.filter((item) => item.workspaceId === workspaceId && item.restoreAvailable).length;
  return {
    id: `workspace:${workspaceId}:trash`,
    kind: "trash",
    title: "回收站",
    subtitle: available ? `${available} 项可恢复` : "暂时为空",
    status: available ? "draft" : "published",
    visibility: "library",
    capabilities: ["restore"],
    children: []
  };
}

async function buildTreeNodeProperties(readweave: ReadWeaveCourseApi, nodeId: string, workspaceId = "personal"): Promise<TreeNodeProperties | undefined> {
  const [courses, releases, drafts, treeNodes, trash] = await Promise.all([
    readweave.listCourses(),
    listWorkspaceReleases(readweave, workspaceId),
    readweave.listDrafts(),
    readweave.listTreeNodes(),
    readweave.listTrash()
  ]);
  const formalCourses = formalWorkspaceCourses(courses, workspaceId);
  const courseIds = new Set(formalCourses.map((course) => course.id));
  const scopedDrafts = drafts.filter((draft) => draft.workspaceId === workspaceId && courseIds.has(draft.courseId));
  const scopedNodes = treeNodes.filter((node) => !isRegressionAsset(node.id, node.title, node.materialId ?? "") && (node.kind === "course"
    ? courseIds.has(node.id)
    : node.kind === "material"
      ? (node.parentId ? courseIds.has(node.parentId) : node.materialId?.split(":")[1] ? courseIds.has(node.materialId.split(":")[1]!) : false)
      : false));
  const scopedTrash = trash.filter((record) => record.workspaceId === workspaceId);
  const node = findTreeNode(buildCourseTree(formalCourses, releases, scopedDrafts, scopedNodes, scopedTrash), nodeId);
  if (!node) {
    const pageSource = releases.flatMap((release) => release.pages.filter((page) => page.id === nodeId).map((page) => ({ release, page })))[0];
    if (!pageSource) return undefined;
    const draft = scopedDrafts.find((item) => item.pageId === nodeId);
    return {
      nodeId,
      kind: "page",
      title: pageSource.page.title,
      subtitle: `第 ${pageSource.page.pageNumber} 页 · ${draft ? "有草稿" : "正式来源"}`,
      revision: draft?.revision ?? 0,
      syncState: "connected",
      pageCount: 1,
      sourceReleaseId: pageSource.release.id,
      updatedAt: new Date().toISOString()
    };
  }
  return {
    nodeId: node.id,
    kind: node.kind,
    title: node.title,
    subtitle: node.subtitle,
    revision: node.revision ?? 0,
    sortOrder: node.sortOrder,
    readweaveNoteId: node.readweaveNoteId,
    readweaveUrl: node.readweaveNoteId ? (await readweave.getDeepLink(node.readweaveNoteId))?.url : undefined,
    syncState: "connected",
    pageCount: node.pageCount ?? (node.kind === "release"
      ? releases.find((release) => release.id === node.releaseId)?.pages.length
      : node.kind === "section" ? node.children.length || undefined : undefined),
    sourceReleaseId: node.releaseId,
    updatedAt: new Date().toISOString()
  };
}

async function readWeaveNoteBelongsToWorkspace(readweave: ReadWeaveCourseApi, noteId: string, workspaceId: string): Promise<boolean> {
  const [courses, releases, drafts, questions, treeNodes] = await Promise.all([
    readweave.listCourses(),
    listWorkspaceReleases(readweave, workspaceId),
    readweave.listDrafts(),
    readweave.listQuestions(),
    readweave.listTreeNodes()
  ]);
  const formalCourses = formalWorkspaceCourses(courses, workspaceId);
  const courseIds = new Set(formalCourses.map((course) => course.id));
  const releaseIds = new Set(releases.map((release) => release.id));
  if (formalCourses.some((course) => course.readweaveNoteId === noteId)) return true;
  if (treeNodes.some((node) => node.readweaveNoteId === noteId && (node.kind === "course"
    ? courseIds.has(node.id)
    : node.kind === "material"
      ? (node.parentId ? courseIds.has(node.parentId) : node.materialId?.split(":")[1] ? courseIds.has(node.materialId.split(":")[1]!) : false)
      : false))) return true;
  if (drafts.some((draft) => draft.workspaceId === workspaceId && courseIds.has(draft.courseId) && draft.readweaveNoteId === noteId)) return true;
  return questions.some((question) => releaseIds.has(question.courseReleaseId) && question.readweaveNoteId === noteId);
}

function isLikelyLegacyTreeNodeId(nodeId: string): boolean {
  return nodeId.startsWith("module-") || nodeId.startsWith("release-node:") || nodeId.startsWith("section:") || /^page[:/]/.test(nodeId);
}

function findTreeNode(nodes: CourseTreeNode[], nodeId: string): CourseTreeNode | undefined {
  for (const node of nodes) {
    if (node.id === nodeId) return node;
    const child = findTreeNode(node.children, nodeId);
    if (child) return child;
  }
  return undefined;
}

async function buildReviewMap(readweave: ReadWeaveCourseApi, now = new Date(), workspaceId = "personal"): Promise<ReviewMap> {
  const [courses, releases, mastery, questionAttempts, assessmentAttempts] = await Promise.all([
    readweave.listCourses(),
    readweave.listReleases(),
    readweave.listMastery(),
    readweave.listQuestionAttempts(),
    readweave.listAssessmentAttempts()
  ]);
  const formalCourseIds = new Set(courses.filter((course) => course.workspaceId === workspaceId && course.status !== "archived" && !isRegressionAsset(course.id, course.title)).map((course) => course.id));
  const currentByModule = new Map<string, CourseRelease>();
  for (const release of releases) {
    if (!formalCourseIds.has(release.courseId) || release.lifecycle === "draft_source" || isRegressionAsset(release.id, `${release.courseTitle} ${release.moduleTitle}`)) continue;
    const key = `${release.courseId}:${release.moduleId}`;
    const current = currentByModule.get(key);
    if (!current || release.version > current.version || (release.version === current.version && release.publishedAt > current.publishedAt)) currentByModule.set(key, release);
  }
  const currentReleases = [...currentByModule.values()].sort((left, right) => left.courseTitle.localeCompare(right.courseTitle, "zh-CN") || left.moduleTitle.localeCompare(right.moduleTitle, "zh-CN") || left.version - right.version);
  const masteryByObjective = new Map(mastery.map((item) => [item.objectiveId, item]));
  const attemptByObjective = new Map<string, Array<{ attemptedAt: string; usedHintLevel: number; misconception?: string }>>();
  for (const attempt of [...questionAttempts, ...assessmentAttempts]) {
    const current = attemptByObjective.get(attempt.objectiveId) ?? [];
    current.push(attempt);
    attemptByObjective.set(attempt.objectiveId, current);
  }
  const objectives: ReviewObjective[] = [];
  const pageIds = new Set<string>();
  for (const release of currentReleases) for (const page of release.pages) {
    pageIds.add(page.id);
    const section = page.lessonSections?.find((item) => item.kind === "learning_objectives");
    const fallback = page.blocks.find((item) => item.kind === "objective");
    const questionObjectiveId = page.questionBank?.find((item) => item.objectiveId)?.objectiveId ?? release.assessments?.find((item) => item.objectiveId)?.objectiveId;
    const objectiveId = questionObjectiveId ?? section?.id ?? fallback?.id ?? `${page.id}:objective`;
    const objectiveText = section?.items?.map((item) => item.text.trim()).filter(Boolean).join("；") || fallback?.markdown.trim() || `理解第 ${page.pageNumber} 页的核心内容`;
    const record = masteryByObjective.get(objectiveId);
    const attempts = (attemptByObjective.get(objectiveId) ?? []).sort((left, right) => left.attemptedAt.localeCompare(right.attemptedAt));
    const last = attempts.at(-1);
    const nextReviewAt = record?.nextReviewAt;
    const due = record?.state === "needs_review" || Boolean(nextReviewAt && new Date(nextReviewAt).getTime() <= now.getTime());
    objectives.push({
      objectiveId,
      objectiveText,
      courseId: release.courseId,
      courseTitle: release.courseTitle,
      moduleId: release.moduleId,
      moduleTitle: release.moduleTitle,
      releaseId: release.id,
      pageId: page.id,
      pageNumber: page.pageNumber,
      pageTitle: page.title,
      state: record?.state ?? "unseen",
      unaidedCorrect: record?.unaidedCorrect ?? false,
      delayedOrTransferCorrect: record?.delayedOrTransferCorrect ?? false,
      nextReviewAt,
      intervalStep: record?.intervalStep ?? 0,
      due,
      attemptCount: attempts.length,
      hintDependencyCount: attempts.filter((attempt) => attempt.usedHintLevel > 0).length,
      lastMisconception: last?.misconception,
      lastAttemptAt: last?.attemptedAt
    });
  }
  const summary = objectives.reduce((result, objective) => {
    result.total += 1;
    if (objective.due) result.due += 1;
    if (objective.state === "needs_review") result.needsReview += 1;
    else result[objective.state] += 1;
    return result;
  }, { total: 0, due: 0, unseen: 0, introduced: 0, practicing: 0, mastered: 0, needsReview: 0 } as ReviewMap["summary"]);
  return { generatedAt: now.toISOString(), releaseCount: currentReleases.length, pageCount: pageIds.size, objectives, summary };
}

async function prepareReviewPlan(readweave: ReadWeaveCourseApi, map: ReviewMap, objectiveIds: string[], planId: string, budgetUsd: number, workspaceId: string, context: IdempotentWriteContext): Promise<Pick<ReviewPlan, "items" | "cost" | "budgetUsd">> {
  const items: ReviewPlanItem[] = [];
  let reusedQuestionCount = 0;
  let generatedQuestionCount = 0;
  for (const [index, objectiveId] of objectiveIds.entries()) {
    const objective = map.objectives.find((item) => item.objectiveId === objectiveId);
    if (!objective) {
      items.push({ objectiveId, releaseId: "", pageId: "", questionIds: [], reusedQuestionIds: [], generatedQuestionIds: [], status: "failed", error: "目标不属于当前正式版本" });
      continue;
    }
    const release = await getWorkspaceRelease(readweave, objective.releaseId, workspaceId);
    const page = release?.pages.find((item) => item.id === objective.pageId);
    if (!release || !page) {
      items.push({ objectiveId, releaseId: objective.releaseId, pageId: objective.pageId, questionIds: [], reusedQuestionIds: [], generatedQuestionIds: [], status: "failed", error: "目标对应的课程页面不存在" });
      continue;
    }
    const candidateDraft = await readweave.getDraftByPage(page.id);
    const draft = candidateDraft?.workspaceId === workspaceId && candidateDraft.courseId === release.courseId ? candidateDraft : undefined;
    const bank = uniqueQuestionBank(page.questionBank ?? [], draft?.page.questionBank ?? [], legacyQuestionBank(release, page.id));
    const wantedKind = index % 2 === 0 ? "comprehension" : "multiple_choice";
    const objectiveBank = bank.filter((item) => item.objectiveId === objectiveId && item.status === "approved");
    let selected = objectiveBank.find((item) => item.kind === wantedKind)
      ?? objectiveBank[0];
    const reusedQuestionIds: string[] = [];
    const generatedQuestionIds: string[] = [];
    if (selected) {
      reusedQuestionIds.push(selected.id);
      reusedQuestionCount += 1;
    } else {
      const generated = refillQuestionBank(page, 4).find((item) => item.objectiveId === objectiveId && item.kind === wantedKind) ?? refillQuestionBank(page, 1)[0];
      if (!generated) {
        items.push({ objectiveId, releaseId: release.id, pageId: page.id, questionIds: [], reusedQuestionIds: [], generatedQuestionIds: [], status: "failed", error: "当前目标没有可准备的复习题" });
        continue;
      }
      selected = {
        ...generated,
        id: `${page.id}:review-plan:${planId}:question:${index + 1}`,
        status: "approved",
        generatedBy: "deterministic-review-plan-v1"
      };
      const existingId = bank.find((item) => item.id === selected!.id);
      if (!existingId) {
        const draftSource = draft && draft.workspaceId === workspaceId ? draft : createVirtualDraft(release, page, workspaceId);
        const draftQuestions = draftSource.page.questionBank ?? [];
        const savedDraft = await readweave.saveDraft({
          ...draftSource,
          status: draftSource.status === "clean" ? "editing" : draftSource.status,
          page: { ...draftSource.page, questionBank: [...draftQuestions, selected] },
          changedBlockIds: [...draftSource.changedBlockIds]
        }, draftSource.revision, { ...context, idempotencyKey: `${context.idempotencyKey}:draft:${page.id}` });
        selected = savedDraft.page.questionBank?.find((item) => item.id === selected!.id) ?? selected;
      }
      generatedQuestionIds.push(selected.id);
      generatedQuestionCount += 1;
    }
    items.push({ objectiveId, releaseId: release.id, pageId: page.id, questionIds: [selected.id], reusedQuestionIds, generatedQuestionIds, status: "ready" });
  }
  const failed = items.filter((item) => item.status === "failed");
  if (failed.length > 0) throw new Error(`REVIEW_PLAN_ITEMS_FAILED:${failed.map((item) => item.objectiveId).join(",")}`);
  return {
    budgetUsd,
    items,
    cost: {
      estimatedMicrousd: 0,
      actualMicrousd: 0,
      cashCostMicrousd: 0,
      quotaConsumedMicrousd: 0,
      reusedQuestionCount,
      generatedQuestionCount
    }
  };
}

function uniqueQuestionBank(...banks: QuestionBankItem[][]): QuestionBankItem[] {
  const seen = new Set<string>();
  return banks.flat().filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

async function reviewQuestionFor(readweave: ReadWeaveCourseApi, session: ReviewSession, objective: ReviewObjective): Promise<QuestionBankItem | undefined> {
  const release = await getWorkspaceRelease(readweave, objective.releaseId, session.workspaceId);
  const page = release?.pages.find((item) => item.id === objective.pageId);
  if (!release || !page) return undefined;
  const candidateDraft = await readweave.getDraftByPage(page.id);
  const draft = candidateDraft?.workspaceId === session.workspaceId ? candidateDraft : undefined;
  const bank = uniqueQuestionBank(page.questionBank ?? [], draft?.page.questionBank ?? [], legacyQuestionBank(release, page.id));
  const questionId = session.questionIdsByObjective?.[objective.objectiveId]?.[0];
  return bank.find((item) => item.status === "approved" && item.id === questionId)
    ?? bank.find((item) => item.status === "approved" && item.objectiveId === objective.objectiveId);
}

function treeCapabilities(kind: CourseTreeNodeKind): CourseTreeNode["capabilities"] {
  if (kind === "workspace") return ["create_course", "create", "properties"];
  if (kind === "course") return ["import_material", "rename", "duplicate", "move", "reorder", "trash", "open_readweave", "history", "properties"];
  if (kind === "module") return ["import_material", "rename", "duplicate", "move", "reorder", "trash", "open_studio", "open_readweave", "history", "properties"];
  if (kind === "material") return ["rename", "duplicate", "move", "reorder", "trash", "open_studio", "open_readweave", "history", "properties"];
  if (kind === "page") return ["open_studio", "open_readweave", "properties"];
  if (kind === "release") return ["open_readweave", "history", "properties"];
  if (kind === "section") return ["history", "properties"];
  if (kind === "trash") return ["restore"];
  return ["properties"];
}

function isRegressionAsset(...values: string[]): boolean {
  // `test-course` is a valid fixture name used by the contract and route tests
  // and must not be treated as a production-data marker.  Regression assets
  // use an explicit marker in their stable ID or title instead.
  return /synthetic|golden|regression|legacy/i.test(values.join(" "));
}

function findPageSource(releases: CourseRelease[], pageId: string) {
  for (const release of [...releases].sort((a, b) => b.version - a.version)) {
    const page = release.pages.find((item) => item.id === pageId);
    if (page) return { release, page };
  }
  return undefined;
}

function formalWorkspaceCourses(courses: CourseProject[], workspaceId: string): CourseProject[] {
  return courses.filter((course) => course.workspaceId === workspaceId && course.status !== "archived" && !isRegressionAsset(course.id, course.title));
}

async function listWorkspaceReleases(readweave: ReadWeaveCourseApi, workspaceId: string, courseId?: string): Promise<CourseRelease[]> {
  const courses = formalWorkspaceCourses(await readweave.listCourses(), workspaceId);
  const courseIds = new Set(courses.map((course) => course.id));
  const releases = await readweave.listReleases(courseId);
  return releases.filter((release) => courseIds.has(release.courseId) && !isRegressionAsset(release.id, `${release.courseTitle} ${release.moduleTitle}`));
}

async function getWorkspaceRelease(readweave: ReadWeaveCourseApi, releaseId: string, workspaceId: string): Promise<CourseRelease | undefined> {
  const release = await readweave.getRelease(releaseId);
  if (!release) return undefined;
  return (await listWorkspaceReleases(readweave, workspaceId, release.courseId)).some((candidate) => candidate.id === release.id) ? release : undefined;
}

async function resolveWorkspaceTreeNode(readweave: ReadWeaveCourseApi, nodeId: string, workspaceId: string): Promise<CourseTreeNode | undefined> {
  const courses = formalWorkspaceCourses(await readweave.listCourses(), workspaceId);
  const courseIds = new Set(courses.map((course) => course.id));
  const [releases, drafts, metadataNodes, trashRecords] = await Promise.all([
    listWorkspaceReleases(readweave, workspaceId),
    readweave.listDrafts(),
    readweave.listTreeNodes(),
    readweave.listTrash()
  ]);
  const tree = buildCourseTree(
    courses,
    releases,
    drafts.filter((draft) => draft.workspaceId === workspaceId && courseIds.has(draft.courseId)),
    metadataNodes.filter((node) => !isRegressionAsset(node.id, node.title, node.materialId ?? "") && (node.kind === "course"
      ? courseIds.has(node.id)
      : node.kind === "material"
        ? (node.parentId ? courseIds.has(node.parentId) : node.materialId?.split(":")[1] ? courseIds.has(node.materialId.split(":")[1]!) : false)
        : false)),
    trashRecords.filter((record) => record.workspaceId === workspaceId)
  );
  const root: CourseTreeNode[] = [...tree, buildTrashNode(trashRecords.filter((record) => record.workspaceId === workspaceId), workspaceId)];
  return findTreeNode(root, nodeId);
}

async function assertWorkspaceTreeNode(readweave: ReadWeaveCourseApi, nodeId: string, workspaceId: string): Promise<CourseTreeNode> {
  if (isLikelyLegacyTreeNodeId(nodeId)) throw new Error("TREE_NODE_STALE");
  const node = await resolveWorkspaceTreeNode(readweave, nodeId, workspaceId);
  if (!node) throw new Error("TREE_NODE_STALE");
  if (node.kind !== "course" && node.kind !== "material") throw new Error("TREE_NODE_NOT_EDITABLE");
  return node;
}

function createVirtualDraft(release: CourseRelease, page: CourseRelease["pages"][number], workspaceId = "personal"): LessonDraft {
  return {
    id: `draft:${page.id}`,
    workspaceId,
    courseId: release.courseId,
    moduleId: release.moduleId,
    sourceReleaseId: release.id,
    pageId: page.id,
    revision: 0,
    status: "clean",
    page: structuredClone(page),
    changedBlockIds: [],
    contentHash: sha256Text(stableStringify(page)),
    updatedAt: release.publishedAt
  };
}

function streamEvents(store: OperationalStore) {
  return async (request: Request, response: Response) => {
    const streamId = String(request.params.id || "");
    const after = Number(request.query.after || 0);
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    const send = (event: { id: number; type: string; payload: unknown }) => response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
    for (const event of (await store.read()).events.filter((item) => item.streamId === streamId && item.id > after)) send(event);
    const listener = (event: { id: number; type: string; payload: unknown }) => send(event);
    store.bus.on(streamId, listener);
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    request.on("close", () => { clearInterval(heartbeat); store.bus.off(streamId, listener); });
  };
}

async function resolveRuntimeModelRouter(dependencies: AppDependencies): Promise<ModelRouterClient | undefined> {
  const environmentFallback = dependencies.modelRouter;
  const vault = dependencies.credentialVault;
  if (!vault) return environmentFallback;
  try {
    const providers = await dependencies.readweave.listModelProviders();
    const configuredProviderIds = new Set(
      (await Promise.all(providers.filter((provider) => provider.enabled).map(async (provider) => {
        return (await vault.has(`model-provider:${provider.id}`)) ? provider.id : undefined;
      }))).filter((providerId): providerId is string => Boolean(providerId))
    );
    if (!configuredProviderIds.size) return environmentFallback;
    return providerRouterFromSettings({
      load: async () => ({
        providers: await dependencies.readweave.listModelProviders(),
        policy: await dependencies.readweave.getModelRoutePolicy(),
        credential: async (providerId) => configuredProviderIds.has(providerId) ? vault.get(`model-provider:${providerId}`) : undefined
      })
    });
  } catch {
    return environmentFallback;
  }
}

interface PersistGenerationJobInput {
  idempotencyKey: string;
  workspaceId: string;
  materialVersionId: string;
  pageIds: string[];
  budgetUsd: number;
  sourceImportId?: string;
  qualityMode: "economy" | "balanced" | "quality";
  language: string;
  writingPolicySnapshotId: string;
}

async function persistGenerationJob(input: PersistGenerationJobInput, dependencies: AppDependencies): Promise<{ job: GenerationJob; created: boolean }> {
  return dependencies.operations.mutate((state) => {
    const replay = state.idempotency[input.idempotencyKey];
    if (replay) {
      const existing = state.jobs.find((item) => item.id === replay.objectId);
      if (existing) return { job: structuredClone(existing), created: false };
    }
    const now = new Date().toISOString();
    const job: GenerationJob = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      materialVersionId: input.materialVersionId,
      sourceImportId: input.sourceImportId,
      qualityMode: input.qualityMode,
      language: input.language,
      writingPolicySnapshotId: input.writingPolicySnapshotId,
      state: "queued",
      budgetUsd: input.budgetUsd,
      spentUsd: 0,
      pageIds: [...input.pageIds],
      completedPageIds: [],
      failedPageIds: [],
      attempt: 0,
      cancelRequested: false,
      createdAt: now,
      updatedAt: now
    };
    state.jobs.push(job);
    state.idempotency[input.idempotencyKey] = { kind: "job", objectId: job.id };
    dependencies.operations.appendEvent(state, job.id, "job.queued", { pages: job.pageIds.length, budgetUsd: job.budgetUsd, sourceImportId: job.sourceImportId, writingPolicySnapshotId: job.writingPolicySnapshotId });
    return { job: structuredClone(job), created: true };
  });
}

function startGenerationJob(jobId: string, dependencies: AppDependencies): void {
  if (process.env.COURSE_OS_EXTERNAL_WORKER !== "true") queueMicrotask(() => runLocalJob(jobId, dependencies).catch(() => undefined));
}

async function runLocalJob(jobId: string, dependencies: AppDependencies): Promise<void> {
  await dependencies.operations.mutate((state) => {
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job || job.state !== "queued" || job.cancelRequested) return;
    Object.assign(job, transitionJob(job, "running"), { attempt: job.attempt + 1 });
    dependencies.operations.appendEvent(state, job.id, "job.running", { attempt: job.attempt });
  });
  const initial = (await dependencies.operations.read()).jobs.find((item) => item.id === jobId);
  if (!initial || initial.state !== "running") return;
  const release = await dependencies.readweave.getRelease(initial.materialVersionId);
  if (!release) {
    await failGenerationJob(jobId, "MATERIAL_VERSION_NOT_FOUND", dependencies);
    return;
  }
  if (initial.writingPolicySnapshotId && initial.writingPolicySnapshotId !== release.writingPolicySnapshotId) {
    await failGenerationJob(jobId, "WRITING_POLICY_SNAPSHOT_CHANGED", dependencies);
    return;
  }
  const runtimeModelRouter = await resolveRuntimeModelRouter(dependencies);
  for (const pageId of initial.pageIds) {
    const currentJob = (await dependencies.operations.read()).jobs.find((item) => item.id === jobId);
    if (!currentJob || currentJob.cancelRequested || currentJob.state !== "running") return;
    if (currentJob.spentUsd >= currentJob.budgetUsd) {
      await failGenerationJob(jobId, "JOB_BUDGET_EXHAUSTED", dependencies);
      return;
    }
    const page = release.pages.find((item) => item.id === pageId);
    if (!page) {
      await markGenerationPageFailed(jobId, pageId, "PAGE_NOT_FOUND", dependencies);
      continue;
    }
    try {
      await appendGenerationStageEvent(jobId, page.id, "extract", "started", dependencies);
      const sourceText = [
        `## 页面原子\n${JSON.stringify(page.atoms)}`,
        `## 覆盖要求\n${JSON.stringify(page.coverageRequirements)}`,
        ...page.blocks.map((block) => `## ${block.title}\n${block.markdown}`)
      ].join("\n\n");
      const sourceImageDataUrl = await originalPageDataUrl(page, dependencies);
      await appendGenerationStageEvent(jobId, page.id, "extract", "completed", dependencies, { sourceImage: Boolean(sourceImageDataUrl), sourceCharacters: sourceText.length });
      await appendGenerationStageEvent(jobId, page.id, "atomize", "started", dependencies);
      await appendGenerationStageEvent(jobId, page.id, "atomize", "completed", dependencies, { atomCount: page.atoms.length, anchorCount: page.anchors.length, requirementCount: page.coverageRequirements.length });
      await appendGenerationStageEvent(jobId, page.id, "teach", "started", dependencies);
      const generation = runtimeModelRouter
        ? await runtimeModelRouter.generateTeachingPackage({ pageTitle: page.title, pageNumber: page.pageNumber, sourceText, sourceImageDataUrl, writingPolicySnapshotId: currentJob.writingPolicySnapshotId || release.writingPolicySnapshotId, language: currentJob.language || "zh-CN", qualityMode: currentJob.qualityMode || generationQualityMode(currentJob.budgetUsd), idempotencyKey: `course-os:${jobId}:${page.id}:teach:v3`, stage: "teach" })
        : deterministicTeachingPackage(page);
      await appendGenerationStageEvent(jobId, page.id, "teach", "completed", dependencies, { provider: generation.provider, model: generation.model, inputTokens: generation.usage.inputTokens, outputTokens: generation.usage.outputTokens });
      await appendGenerationStageEvent(jobId, page.id, "review", "started", dependencies);
      const generatedPage = applyTeachingPackage(page, generation.content, Boolean(runtimeModelRouter), sourceImageDataUrl ? "multimodal" : "text_only");
      const coverage = calculateCoverage(generatedPage.coverageRequirements, generatedPage.coverageClaims);
      const issues = validatePageForPublication(generatedPage);
      generatedPage.quality = {
        highRiskCoverage: coverage.highRiskCoverage,
        generalCoverage: coverage.generalCoverage,
        mathValid: issues.every((issue) => !issue.includes("MATH")),
        publishable: coverage.publishable && issues.length === 0 && Boolean(runtimeModelRouter),
        issues: runtimeModelRouter ? issues : [...issues, "MODEL_REVIEW_REQUIRED"]
      };
      await appendGenerationStageEvent(jobId, page.id, "review", "completed", dependencies, { issueCount: generatedPage.quality.issues.length, publishable: generatedPage.quality.publishable });
      await appendGenerationStageEvent(jobId, page.id, "repair", generatedPage.quality.issues.length ? "skipped" : "completed", dependencies, { reason: generatedPage.quality.issues.length ? "需要人工审核或局部修复" : "没有发现需要修复的质量问题" });
      const existing = await dependencies.readweave.getDraftByPage(page.id);
      const now = new Date().toISOString();
      const contentHash = sha256Text(stableStringify(generatedPage));
      const draft: LessonDraft = {
        id: existing?.id ?? `draft:${page.id}`,
        workspaceId: currentJob.workspaceId,
        courseId: release.courseId,
        moduleId: release.moduleId,
        sourceReleaseId: release.id,
        pageId: page.id,
        revision: existing?.revision ?? 0,
        status: generatedPage.quality.publishable ? "ready" : "needs_review",
        page: generatedPage,
        changedBlockIds: generatedPage.blocks.map((block) => block.id),
        contentHash,
        readweaveNoteId: existing?.readweaveNoteId,
        updatedAt: now
      };
      const saved = await dependencies.readweave.saveDraft(draft, existing?.revision ?? 0, systemWriteContext(`generation:${jobId}:attempt:${currentJob.attempt}:${page.id}:draft`, currentJob.workspaceId));
      const readBack = await dependencies.readweave.getDraftByPage(page.id);
      if (!readBack || readBack.contentHash !== saved.contentHash) throw new Error("READWEAVE_DRAFT_READBACK_MISMATCH");
      const cost = generationCostEntry(jobId, currentJob, release, page.id, generation, generatedPage.quality.publishable);
      await dependencies.readweave.appendCostEntry(cost, systemWriteContext(`generation:${jobId}:attempt:${currentJob.attempt}:${page.id}:cost`, currentJob.workspaceId));
      await dependencies.operations.mutate((state) => {
        const job = state.jobs.find((item) => item.id === jobId);
        if (!job || job.state !== "running") return;
        applyActualCost(job, cost, state, dependencies);
        if (!job.completedPageIds.includes(page.id)) job.completedPageIds.push(page.id);
        dependencies.operations.appendEvent(state, job.id, "generation.page.completed", { pageId: page.id, draftRevision: saved.revision, contentHash, actualMicrousd: cost.actualMicrousd, publishable: generatedPage.quality.publishable });
        if (job.spentUsd > job.budgetUsd || (job.spentUsd >= job.budgetUsd && job.completedPageIds.length + job.failedPageIds.length < job.pageIds.length)) {
          Object.assign(job, transitionJob(job, "failed"));
          dependencies.operations.appendEvent(state, job.id, "job.failed", { issue: "JOB_BUDGET_EXHAUSTED", spentUsd: job.spentUsd, budgetUsd: job.budgetUsd });
          return;
        }
        if (job.completedPageIds.length + job.failedPageIds.length >= job.pageIds.length) finalizeGenerationJob(job, state, dependencies);
      });
    } catch (error) {
      if (error instanceof ModelRouterGenerationError) {
        const failedCost = failedGenerationCostEntry(jobId, currentJob, release, page.id, error);
        await dependencies.readweave.appendCostEntry(failedCost, systemWriteContext(`generation:${jobId}:attempt:${currentJob.attempt}:${page.id}:cost`, currentJob.workspaceId));
        await dependencies.operations.mutate((state) => {
          const job = state.jobs.find((item) => item.id === jobId);
          if (!job || job.state !== "running") return;
          applyActualCost(job, failedCost, state, dependencies);
          if (!job.failedPageIds.includes(pageId)) job.failedPageIds.push(pageId);
          dependencies.operations.appendEvent(state, job.id, "generation.page.cost_recorded", { pageId, status: "failed", actualMicrousd: failedCost.actualMicrousd });
          if (job.spentUsd > job.budgetUsd) {
            Object.assign(job, transitionJob(job, "failed"));
            dependencies.operations.appendEvent(state, job.id, "job.failed", { issue: "JOB_BUDGET_EXHAUSTED", spentUsd: job.spentUsd, budgetUsd: job.budgetUsd });
          }
        });
      }
      await markGenerationPageFailed(jobId, pageId, safeGenerationIssue(error), dependencies);
    }
  }
  await dependencies.operations.mutate((state) => {
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job || job.state !== "running" || job.cancelRequested) return;
    Object.assign(job, transitionJob(job, "pending_sync"));
    dependencies.operations.appendEvent(state, job.id, "job.pending_sync", { completedPageIds: job.completedPageIds, failedPageIds: job.failedPageIds });
    if (job.completedPageIds.length === 0 && job.failedPageIds.length > 0) {
      Object.assign(job, transitionJob(job, "failed"));
      dependencies.operations.appendEvent(state, job.id, "job.failed", { failedPageIds: job.failedPageIds });
    } else {
      Object.assign(job, transitionJob(job, "completed"));
      dependencies.operations.appendEvent(state, job.id, "job.completed", { completedPageIds: job.completedPageIds, failedPageIds: job.failedPageIds, spentUsd: job.spentUsd });
    }
  });
}

async function appendGenerationStageEvent(jobId: string, pageId: string, stage: GenerationCostEntry["stage"], status: "started" | "completed" | "skipped", dependencies: AppDependencies, details: Record<string, unknown> = {}): Promise<void> {
  await dependencies.operations.mutate((state) => {
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job) return;
    dependencies.operations.appendEvent(state, job.id, `generation.stage.${status}`, { pageId, stage, ...details });
  });
}

async function failGenerationJob(jobId: string, issue: string, dependencies: AppDependencies): Promise<void> {
  await dependencies.operations.mutate((state) => {
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job || job.state !== "running") return;
    Object.assign(job, transitionJob(job, "failed"));
    dependencies.operations.appendEvent(state, job.id, "job.failed", { issue });
  });
}

async function markGenerationPageFailed(jobId: string, pageId: string, issue: string, dependencies: AppDependencies): Promise<void> {
  await dependencies.operations.mutate((state) => {
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job || job.state !== "running") return;
    if (!job.failedPageIds.includes(pageId)) job.failedPageIds.push(pageId);
    dependencies.operations.appendEvent(state, job.id, "generation.page.failed", { pageId, issue });
    if (job.completedPageIds.length + job.failedPageIds.length >= job.pageIds.length) finalizeGenerationJob(job, state, dependencies);
  });
}

function finalizeGenerationJob(job: GenerationJob, state: OperationalState, dependencies: AppDependencies): void {
  if (job.state !== "running") return;
  Object.assign(job, transitionJob(job, "pending_sync"));
  dependencies.operations.appendEvent(state, job.id, "job.pending_sync", { completedPageIds: job.completedPageIds, failedPageIds: job.failedPageIds });
  if (job.completedPageIds.length === 0 && job.failedPageIds.length > 0) {
    Object.assign(job, transitionJob(job, "failed"));
    dependencies.operations.appendEvent(state, job.id, "job.failed", { failedPageIds: job.failedPageIds });
  } else {
    Object.assign(job, transitionJob(job, "completed"));
    dependencies.operations.appendEvent(state, job.id, "job.completed", { completedPageIds: job.completedPageIds, failedPageIds: job.failedPageIds, spentUsd: job.spentUsd });
  }
}

function generationQualityMode(budgetUsd: number): "economy" | "balanced" | "quality" {
  return budgetUsd >= 7 ? "quality" : budgetUsd <= 2 ? "economy" : "balanced";
}

function deterministicTeachingPackage(page: CourseRelease["pages"][number]): TeachingGenerationResult {
  const full = page.lessonSections?.find((item) => item.kind === "full_explanation")?.markdown
    || page.blocks.filter((item) => ["core", "example", "deep_dive", "check"].includes(item.kind)).map((item) => item.markdown).join("\n\n");
  const objective = page.lessonSections?.find((item) => item.kind === "learning_objectives")?.items?.map((item) => item.text)
    || [page.blocks.find((item) => item.kind === "objective")?.markdown || `能够解释${page.title}的主要对象和关系`];
  const prior = page.lessonSections?.find((item) => item.kind === "prior_knowledge")?.items?.map((item) => item.text)
    || [page.blocks.find((item) => item.kind === "prerequisite")?.markdown || `先知道${page.title}中主要术语的含义`];
  const misconceptions = page.lessonSections?.find((item) => item.kind === "misconceptions")?.items?.map((item) => item.text)
    || [page.blocks.find((item) => item.kind === "misconception")?.markdown || `不要把${page.title}的标题当成完整结论`];
  const existing = page.questionBank ?? refillQuestionBank(page, 4);
  const questions = existing.slice(0, 4).map((item) => ({ kind: item.kind, prompt: item.prompt, options: item.options, expectedAnswer: item.expectedAnswer, explanation: item.explanation }));
  const coverageEvidence = page.coverageRequirements.map((requirement) => ({ atomId: requirement.atomId, coveredFields: [...requirement.requiredFields], explanation: `本地回退只保留来源字段 ${requirement.requiredFields.join("、")}，仍需模型或人工核验` }));
  const content: TeachingPackage = { learningObjectives: objective, mainContentMarkdown: page.blocks.find((item) => item.kind === "core")?.markdown || full, priorKnowledge: prior, fullExplanationMarkdown: full, misconceptions, coverageEvidence, questions };
  return { content, provider: "aialra-model-router", model: "deterministic-local-fallback", usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, apiEquivalentUsd: 0, durationMs: 0 } };
}

function applyTeachingPackage(page: CourseRelease["pages"][number], content: TeachingPackage, modelBacked: boolean, inputMode: "multimodal" | "text_only" = "text_only"): CourseRelease["pages"][number] {
  const normalizedContent = normalizeTeachingPackageMath(content);
  const anchorIds = page.anchors.map((item) => item.id);
  const atomIds = page.atoms.map((item) => item.id);
  const sentenceItems = (prefix: string, values: string[]) => values.map((text, index) => ({ id: `${page.id}:${prefix}:${index + 1}`, text: oneSentence(text), sourceAnchorIds: anchorIds }));
  const evidenceMarkdown = normalizedContent.coverageEvidence.length > 0 ? `\n\n### 页面元素核对\n\n${normalizedContent.coverageEvidence.map((item) => `- \`${item.atomId}\`：${item.explanation}`).join("\n")}` : "";
  const fullExplanationMarkdown = `${normalizedContent.fullExplanationMarkdown}${evidenceMarkdown}`;
  const lessonSections: LessonSection[] = [
    { id: `${page.id}:section:objective`, kind: "learning_objectives", title: "学习目标", items: sentenceItems("objective", normalizedContent.learningObjectives), sourceAnchorIds: anchorIds, atomIds },
    { id: `${page.id}:section:main`, kind: "main_content", title: "主要内容", markdown: normalizedContent.mainContentMarkdown, sourceAnchorIds: anchorIds, atomIds },
    { id: `${page.id}:section:prior`, kind: "prior_knowledge", title: "先验知识列表", items: sentenceItems("prior", normalizedContent.priorKnowledge), sourceAnchorIds: anchorIds, atomIds },
    { id: `${page.id}:section:full`, kind: "full_explanation", title: "完整讲解", markdown: fullExplanationMarkdown, sourceAnchorIds: anchorIds, atomIds },
    { id: `${page.id}:section:misconceptions`, kind: "misconceptions", title: "易错点列表", items: sentenceItems("misconception", normalizedContent.misconceptions), sourceAnchorIds: anchorIds, atomIds }
  ];
  const objectiveId = lessonSections[0]!.id;
  const questionBank: QuestionBankItem[] = normalizedContent.questions.map((item, index) => ({ id: `${page.id}:question:${item.kind}:${index + 1}`, pageId: page.id, objectiveId, kind: item.kind, prompt: item.prompt, options: item.options, expectedAnswer: item.expectedAnswer, explanation: item.explanation, sourceAnchorIds: anchorIds, status: modelBacked ? "approved" : "draft", version: 1, generatedBy: modelBacked ? `aialra-model-router-${inputMode}-v3` : "deterministic-local-fallback-v1" }));
  const blocks = page.blocks.map((block) => block.kind === "objective" ? { ...block, markdown: normalizedContent.learningObjectives.join("\n") } : block.kind === "prerequisite" ? { ...block, markdown: normalizedContent.priorKnowledge.join("\n") } : block.kind === "core" ? { ...block, markdown: normalizedContent.mainContentMarkdown } : block.kind === "deep_dive" ? { ...block, markdown: fullExplanationMarkdown } : block.kind === "misconception" ? { ...block, markdown: normalizedContent.misconceptions.join("\n") } : block);
  const explanationBlockId = blocks.find((item) => item.kind === "deep_dive")?.id || blocks.find((item) => item.kind === "core")!.id;
  const coverageClaims = page.coverageRequirements.map((requirement) => {
    const evidence = normalizedContent.coverageEvidence.find((item) => item.atomId === requirement.atomId);
    const coveredFields = evidence?.coveredFields.filter((field) => requirement.requiredFields.includes(field)) ?? [];
    const status = coveredFields.length === 0 ? "missing" as const : requirement.requiredFields.every((field) => coveredFields.includes(field)) ? "covered" as const : "partial" as const;
    return { requirementId: requirement.id, explanationBlockId, coveredFields, status };
  });
  return { ...page, blocks, lessonSections, questionBank, coverageClaims, quality: { ...page.quality, issues: [], publishable: false } };
}

function normalizeTeachingPackageMath(content: TeachingPackage): TeachingPackage {
  const normalize = normalizeGeneratedMathPunctuation;
  return {
    ...content,
    learningObjectives: content.learningObjectives.map(normalize),
    mainContentMarkdown: normalize(content.mainContentMarkdown),
    priorKnowledge: content.priorKnowledge.map(normalize),
    fullExplanationMarkdown: normalize(content.fullExplanationMarkdown),
    misconceptions: content.misconceptions.map(normalize),
    coverageEvidence: content.coverageEvidence.map((item) => ({ ...item, explanation: normalize(item.explanation) })),
    questions: content.questions.map((item) => ({ ...item, prompt: normalize(item.prompt), options: item.options?.map(normalize), expectedAnswer: normalize(item.expectedAnswer), explanation: normalize(item.explanation) }))
  };
}

export function normalizeGeneratedMathPunctuation(value: string): string {
  const repairedEscapes = normalizeLegacyMathDelimiters(value)
    .replace(/\u000crac/g, "\\frac")
    .replace(/\\text\{\s*μm\s*\}/g, "\\,\\mu\\mathrm{m}");
  const displaysNormalized = repairedEscapes.replace(/\$\$([\s\S]*?)\$\$/g, (match, source: string) => normalizeMathSpan(match, source, "$$"));
  return displaysNormalized.replace(/(?<!\$)\$([^$\r\n]+)\$(?!\$)/g, (match, source: string) => normalizeMathSpan(match, source, "$"));
}

function normalizeMathSpan(match: string, source: string, delimiter: "$" | "$$"): string {
  const trailingMatch = source.match(/([、，；。！？]+)\s*$/);
  const trailing = trailingMatch?.[1] ?? "";
  const candidate = trailing ? source.slice(0, trailingMatch!.index).trimEnd() : source;
  if (candidate && validateTex(candidate).valid) return `${delimiter}${candidate}${delimiter}${trailing}`;

  if (delimiter === "$" && /[、，；]/.test(candidate)) {
    const parts = candidate.split(/([、，；])/);
    const expressions = parts.filter((part) => part && !/[、，；]/.test(part)).map((part) => part.trim());
    if (expressions.length >= 2 && expressions.every((part) => part && validateTex(part).valid)) {
      return `${parts.map((part) => /[、，；]/.test(part) ? part : part.trim() ? `$${part.trim()}$` : "").join("")}${trailing}`;
    }
  }

  if (/[\u3400-\u9fff]/.test(candidate)) {
    const hasMathSyntax = /[A-Za-z0-9\\_=+\-^{}]/.test(candidate);
    if (!hasMathSyntax) return `${candidate}${trailing}`;
    const wrapped = candidate.replace(/[\u3400-\u9fff]+/g, (text) => `\\text{${text}}`);
    if (validateTex(wrapped).valid) return `${delimiter}${wrapped}${delimiter}${trailing}`;
  }

  return trailing ? `${delimiter}${candidate}${delimiter}${trailing}` : match;
}

function oneSentence(value: string): string {
  return value.replace(/^[-*]\s*/, "").replace(/[\r\n]+/g, " ").trim();
}

async function originalPageDataUrl(page: CourseRelease["pages"][number], dependencies: AppDependencies): Promise<string | undefined> {
  const match = /^\/api\/v1\/media\/([a-f0-9]{64})$/.exec(page.imageUrl);
  if (!match) return undefined;
  const bytes = await dependencies.cas.get(match[1]!);
  return buildModelImageDataUrl(bytes);
}

function generationCostEntry(jobId: string, job: GenerationJob, release: CourseRelease, pageId: string, generation: TeachingGenerationResult, qualityPassed: boolean): GenerationCostEntry {
  return makeGenerationCostEntry(jobId, job, release, pageId, generation.provider, generation.model, generation.usage, "succeeded", qualityPassed);
}

function failedGenerationCostEntry(jobId: string, job: GenerationJob, release: CourseRelease, pageId: string, error: ModelRouterGenerationError): GenerationCostEntry {
  return makeGenerationCostEntry(jobId, job, release, pageId, error.provider, error.model, error.usage, "failed", false);
}

function makeGenerationCostEntry(jobId: string, job: GenerationJob, release: CourseRelease, pageId: string, provider: string, model: string, usage: TeachingGenerationResult["usage"], status: "succeeded" | "failed", qualityPassed: boolean): GenerationCostEntry {
  const snapshot = priceSnapshotFor(provider, model) ?? unavailablePriceSnapshot(provider, model);
  const snapshotEstimate = estimateMicrousd(snapshot, usage.inputTokens, usage.cachedInputTokens, usage.outputTokens);
  const reported = typeof usage.apiEquivalentUsd === "number" && Number.isFinite(usage.apiEquivalentUsd) ? Math.max(0, Math.round(usage.apiEquivalentUsd * 1_000_000)) : undefined;
  const estimatedMicrousd = snapshotEstimate ?? reported ?? 0;
  const actualMicrousd = reported ?? estimatedMicrousd;
  const billingMode = billingModeForProvider(provider);
  const actualBilling = billingBreakdown(provider, billingMode, actualMicrousd);
  const estimatedBilling = billingBreakdown(provider, billingMode, estimatedMicrousd);
  return {
    id: `cost:${jobId}:attempt:${job.attempt}:${pageId}:teach`,
    workspaceId: job.workspaceId,
    courseId: release.courseId,
    materialVersionId: release.id,
    pageId,
    objectId: `draft:${pageId}`,
    jobId,
    stage: "teach",
    provider,
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    unitPriceSnapshot: snapshot,
    estimatedMicrousd,
    actualMicrousd,
    durationMs: usage.durationMs,
    retries: Math.max(0, job.attempt - 1),
    status,
    qualityPassed,
    billingMode,
    cashCostMicrousd: actualBilling.cashCostMicrousd,
    quotaConsumedMicrousd: actualBilling.quotaConsumedMicrousd,
    estimatedCashCostMicrousd: estimatedBilling.cashCostMicrousd,
    estimatedQuotaConsumedMicrousd: estimatedBilling.quotaConsumedMicrousd,
    costBasis: reported !== undefined ? "provider_reported" : snapshotEstimate !== undefined && snapshot.source !== "价格未配置" ? "price_snapshot" : "not_available",
    createdAt: new Date().toISOString()
  };
}

function unavailablePriceSnapshot(provider: string, model: string) {
  const capturedAt = new Date().toISOString();
  return {
    id: `price:unavailable:${provider}:${model}:${capturedAt}`,
    provider,
    model,
    currency: "USD" as const,
    capturedAt,
    source: "价格未配置",
    inputMicrousdPerMillion: 0,
    outputMicrousdPerMillion: 0,
    cachedInputMicrousdPerMillion: 0
  };
}

function applyActualCost(job: GenerationJob, cost: GenerationCostEntry, state: OperationalState, dependencies: AppDependencies): void {
  job.spentUsd = Math.round((job.spentUsd + cost.actualMicrousd / 1_000_000) * 1_000_000) / 1_000_000;
  job.updatedAt = new Date().toISOString();
  dependencies.operations.appendEvent(state, job.id, "generation.cost.recorded", { costEntryId: cost.id, status: cost.status, actualMicrousd: cost.actualMicrousd, spentUsd: job.spentUsd });
}

function safeGenerationIssue(error: unknown): string {
  if (error instanceof ModelRouterGenerationError) return error.code.slice(0, 240);
  const message = error instanceof Error ? error.message : "GENERATION_UNKNOWN_FAILURE";
  return /^[A-Z0-9_:-]+$/i.test(message) ? message.slice(0, 240) : "GENERATION_INTERNAL_FAILURE";
}

function isAllowedProviderBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

export async function resumeIncompleteImports(dependencies: AppDependencies): Promise<void> {
  const pending = (await dependencies.operations.read()).imports.filter((item) => ["accepted", "processing", "syncing"].includes(item.state));
  await Promise.allSettled(pending.map((item) => processImport(item.id, dependencies)));
}

export async function resumeIncompleteJobs(dependencies: AppDependencies): Promise<void> {
  const pending = (await dependencies.operations.read()).jobs.filter((item) => ["queued", "running"].includes(item.state) && !item.cancelRequested);
  for (const job of pending) {
    if (job.state === "running") {
      await dependencies.operations.mutate((state) => {
        const current = state.jobs.find((item) => item.id === job.id);
        if (!current || current.state !== "running" || current.cancelRequested) return;
        Object.assign(current, transitionJob(current, "queued"));
        dependencies.operations.appendEvent(state, current.id, "job.recovered", { previousState: "running", attempt: current.attempt });
      });
    }
    if (process.env.COURSE_OS_EXTERNAL_WORKER !== "true") queueMicrotask(() => runLocalJob(job.id, dependencies).catch(() => undefined));
  }
}

async function processImport(importId: string, dependencies: AppDependencies): Promise<void> {
  let running = activeImports.get(dependencies.operations);
  if (!running) {
    running = new Set();
    activeImports.set(dependencies.operations, running);
  }
  if (running.has(importId)) return;
  running.add(importId);
  const outputDir = join(dependencies.dataDir, "conversions", importId);
  try {
    const record = await dependencies.operations.mutate((state) => {
      const item = state.imports.find((candidate) => candidate.id === importId);
      if (!item || item.state === "ready" || item.state === "rejected") return undefined;
      item.state = "processing";
      dependencies.operations.appendEvent(state, importId, "conversion.started", { kind: item.kind, originalName: item.originalName });
      return structuredClone(item);
    });
    if (!record) return;
    const conversion = await dependencies.conversion.enqueueAndWait({
      id: importId,
      sourcePath: record.casPath,
      originalName: record.originalName,
      kind: record.kind,
      outputDir,
      createdAt: record.createdAt
    });
    if (conversion.state !== "completed") throw new Error(conversion.issues[0] || "CONVERSION_FAILED");
    const convertedPages: Array<{ page: CourseRelease["pages"][number]; bytes: Buffer; sha256: string; mediaType: "image/png" | "image/svg+xml" }> = [];
    for (const converted of conversion.pages) {
      const bytes = await readFile(converted.imagePath);
      const stored = await dependencies.cas.put(bytes);
      const page = createImportedPage(record.sha256, converted.pageNumber, converted.title, converted.text, stored.sha256);
      convertedPages.push({ page, bytes, sha256: stored.sha256, mediaType: converted.imageMediaType });
      await dependencies.operations.mutate((state) => {
        dependencies.operations.appendEvent(state, importId, "conversion.page.completed", { pageId: page.id, pageNumber: page.pageNumber, title: page.title, imageSha256: stored.sha256 });
      });
    }
    const treeNodes = await dependencies.readweave.listTreeNodes();
    const parentNode = record.parentNodeId ? treeNodes.find((node) => node.id === record.parentNodeId) : undefined;
    const parentCourseId = resolveParentCourseId(parentNode, treeNodes, record.courseId);
    const course = await ensureImportCourse(parentCourseId, record.originalName, record.sha256, dependencies);
    const materialVersionId = `material-version:${record.id}`;
    const moduleId = parentNode?.kind === "module" ? parentNode.id : `material:${record.id}`;
    const createdAt = new Date().toISOString();
    const writingPolicy = await currentWritingPolicy();
    if (writingPolicy.validator.status !== "passed") throw new Error("WRITING_POLICY_VALIDATION_FAILED");
    const sourceRelease: CourseRelease = {
      id: materialVersionId,
      courseId: course.id,
      courseTitle: course.title,
      moduleId,
      moduleTitle: fileTitle(record.originalName),
      version: 0,
      publishedAt: createdAt,
      pageIds: convertedPages.map((item) => item.page.id),
      pages: convertedPages.map((item) => item.page),
      assessments: [],
      manifestHash: record.sha256,
      writingPolicySnapshotId: writingPolicy.policySnapshotId,
      modelRoute: "deterministic-offline-import-v1",
      qualityHarnessVersion: "source-draft-gate-v1",
      costUsd: 0,
      lifecycle: "draft_source"
    };
    await dependencies.operations.mutate((state) => {
      const item = state.imports.find((candidate) => candidate.id === importId);
      if (item) item.state = "syncing";
      dependencies.operations.appendEvent(state, importId, "readweave.sync.started", { materialVersionId, pages: convertedPages.length });
    });
    await dependencies.readweave.registerDraftSource(sourceRelease, systemWriteContext(`import:${importId}:source`, record.workspaceId));
    const savedDrafts: LessonDraft[] = [];
    for (const converted of convertedPages) {
      const draft: LessonDraft = {
        id: `draft:${converted.page.id}`,
        workspaceId: record.workspaceId,
        courseId: course.id,
        moduleId,
        sourceReleaseId: materialVersionId,
        pageId: converted.page.id,
        revision: 0,
        status: "needs_review",
        page: converted.page,
        changedBlockIds: converted.page.blocks.map((block) => block.id),
        contentHash: sha256Text(stableStringify(converted.page)),
        updatedAt: createdAt
      };
      const saved = await dependencies.readweave.saveDraft(
        draft,
        0,
        systemWriteContext(`import:${importId}:draft:${converted.page.pageNumber}`, record.workspaceId),
        {
          sha256: converted.sha256,
          fileName: `page-${String(converted.page.pageNumber).padStart(3, "0")}.${converted.mediaType === "image/png" ? "png" : "svg"}`,
          mediaType: converted.mediaType,
          bytes: converted.bytes
        }
      );
      savedDrafts.push(saved);
      await dependencies.operations.mutate((state) => {
        dependencies.operations.appendEvent(state, importId, "readweave.page.synced", { pageId: saved.pageId, draftId: saved.id, revision: saved.revision });
      });
    }
    const generation = record.autoGenerate === true ? await persistGenerationJob({
      idempotencyKey: `import:${importId}:generation`,
      workspaceId: record.workspaceId,
      materialVersionId,
      pageIds: convertedPages.map((entry) => entry.page.id),
      budgetUsd: generationBudget(record.qualityMode),
      sourceImportId: importId,
      qualityMode: record.qualityMode || "balanced",
      language: record.language || "zh-CN",
      writingPolicySnapshotId: writingPolicy.policySnapshotId
    }, dependencies) : undefined;
    await dependencies.operations.mutate((state) => {
      const item = state.imports.find((candidate) => candidate.id === importId);
      if (!item) return;
      item.courseId = course.id;
      item.materialVersionId = materialVersionId;
      item.pageIds = convertedPages.map((entry) => entry.page.id);
      item.draftIds = savedDrafts.map((draft) => draft.id);
      item.convertedAt = conversion.completedAt;
      item.state = "ready";
      item.generationJobId = generation?.job.id;
      item.generationState = generation?.job.state || "not_requested";
      dependencies.operations.appendEvent(state, importId, "import.ready", { courseId: course.id, materialVersionId, pageIds: item.pageIds, draftIds: item.draftIds, generationJobId: item.generationJobId, autoGenerate: item.autoGenerate });
    });
    if (generation?.created) startGenerationJob(generation.job.id, dependencies);
  } catch (error) {
    const issue = safeImportIssue(error);
    await dependencies.operations.mutate((state) => {
      const item = state.imports.find((candidate) => candidate.id === importId);
      if (!item || item.state === "ready") return;
      item.state = "failed";
      if (!item.issues.includes(issue)) item.issues.push(issue);
      dependencies.operations.appendEvent(state, importId, "import.failed", { issue });
    });
  } finally {
    running.delete(importId);
    await removeConversionOutput(outputDir).catch(() => undefined);
  }
}

function generationBudget(mode: ImportRecord["qualityMode"]): number {
  return mode === "quality" ? 8 : mode === "economy" ? 2 : 4;
}

function resolveParentCourseId(parentNode: CourseTreeNode | undefined, nodes: CourseTreeNode[], fallback: string | undefined): string | undefined {
  if (!parentNode) return fallback;
  if (parentNode.kind === "course") return parentNode.id;
  let parentId = parentNode.parentId;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const legacy = parentId.match(/^material:([^:]+):current$/);
    if (legacy?.[1]) return legacy[1];
    const parent = nodes.find((node) => node.id === parentId);
    if (!parent) break;
    if (parent.kind === "course") return parent.id;
    parentId = parent.parentId;
  }
  return fallback;
}

async function ensureImportCourse(courseId: string | undefined, originalName: string, sourceHash: string, dependencies: AppDependencies): Promise<CourseProject> {
  const courses = await dependencies.readweave.listCourses();
  if (courseId) {
    const existing = courses.find((item) => item.id === courseId);
    if (!existing) throw new Error("IMPORT_COURSE_NOT_FOUND");
    return existing;
  }
  const id = `course-import-${sourceHash.slice(0, 12)}`;
  const existing = courses.find((item) => item.id === id);
  if (existing) return existing;
  const now = new Date().toISOString();
  return dependencies.readweave.createCourse({
    id,
    workspaceId: "personal",
    title: `${fileTitle(originalName)} 课程`,
    description: "由离线导入流程建立，名称和课程结构可继续编辑",
    status: "active",
    createdAt: now,
    updatedAt: now
  }, systemWriteContext(`import-course:${id}`, "personal"));
}

function createImportedPage(sourceHash: string, pageNumber: number, title: string, extractedText: string, imageHash: string): CourseRelease["pages"][number] {
  const pageId = `page:${sourceHash}:${pageNumber}`;
  const pageAnchorId = `${pageId}:source-page`;
  const textAnchorId = `${pageId}:source-text`;
  const atomId = `${pageId}:image-region`;
  const coreId = `${pageId}:core`;
  const text = extractedText.slice(0, 40_000);
  return {
    id: pageId,
    pageNumber,
    title,
    imageUrl: `/api/v1/media/${imageHash}`,
    anchors: [
      { id: pageAnchorId, pageId, kind: "page", label: `第 ${pageNumber} 页原始画面` },
      { id: textAnchorId, pageId, kind: "text", label: `第 ${pageNumber} 页离线提取文本`, text }
    ],
    atoms: [{ kind: "image_region", id: atomId, label: "整页来源画面", observation: "页面图片和文本已经离线提取，仍需完成逐元素识别与教授级讲解" }],
    blocks: [
      { id: `${pageId}:objective`, title: "本页目标", kind: "objective", markdown: "待确认：先根据原始页面确定学生学完后应能完成的具体任务", sourceAnchorIds: [pageAnchorId, textAnchorId], atomIds: [atomId] },
      { id: `${pageId}:prerequisite`, title: "需要先知道什么", kind: "prerequisite", markdown: "待确认：补齐理解本页所需的定义、符号和前置步骤", sourceAnchorIds: [pageAnchorId, textAnchorId], atomIds: [atomId] },
      { id: coreId, title: "来源文字与讲解草稿", kind: "core", markdown: `${text || "这一页没有提取到可读文字，需要结合原图人工检查"}\n\n> 当前只完成来源拆解，还没有冒充教授级讲解；请继续生成或人工编写后再发布`, sourceAnchorIds: [pageAnchorId, textAnchorId], atomIds: [atomId] },
      { id: `${pageId}:detail`, title: "逐元素详解", kind: "deep_dive", markdown: "待生成：逐公式、逐变量、逐行代码、逐图表元素或逐图片区域解释", sourceAnchorIds: [pageAnchorId, textAnchorId], atomIds: [atomId] },
      { id: `${pageId}:example`, title: "完整例子", kind: "example", markdown: "待生成：给出一个从输入到结论都能复算的完整例子", sourceAnchorIds: [pageAnchorId, textAnchorId], atomIds: [atomId] },
      { id: `${pageId}:misconception`, title: "容易错在哪里", kind: "misconception", markdown: "待生成：指出最容易混淆的概念，并解释为什么会错", sourceAnchorIds: [pageAnchorId, textAnchorId], atomIds: [atomId] },
      { id: `${pageId}:check`, title: "理解检查", kind: "check", markdown: "待生成：设计一道不能只靠照抄原文回答的主动检查", sourceAnchorIds: [pageAnchorId, textAnchorId], atomIds: [atomId] },
      { id: `${pageId}:qa`, title: "课堂问答", kind: "qa", markdown: "待生成：补充学生最可能追问的问题和分层提示", sourceAnchorIds: [pageAnchorId, textAnchorId], atomIds: [atomId] }
    ],
    coverageRequirements: [{ id: `${pageId}:requirement:${atomId}`, atomId, requiredFields: ["label", "observation", "inference"], risk: "general" }],
    coverageClaims: [{ requirementId: `${pageId}:requirement:${atomId}`, explanationBlockId: coreId, coveredFields: ["label", "observation"], status: "partial" }],
    quality: { highRiskCoverage: 1, generalCoverage: 2 / 3, mathValid: true, publishable: false, issues: ["TEACHING_GENERATION_REQUIRED", "ELEMENT_ANALYSIS_REQUIRED"] }
  };
}

interface WritingPolicyManifestFile {
  path: string;
  sourcePath: string;
  sha256: string;
}

interface WritingPolicyManifestFileState {
  schemaVersion: string;
  policySnapshotId: string;
  status: "candidate" | "approved";
  sourceCommit: string;
  summary: string;
  files: WritingPolicyManifestFile[];
  aggregateSha256: string;
}

async function currentWritingPolicy(): Promise<WritingPolicyCurrent> {
  const manifest = JSON.parse(await readFile(join(process.cwd(), "config", "writing-policy-manifest.json"), "utf8")) as WritingPolicyManifestFileState;
  const issues: string[] = [];
  const aggregate = sha256Text(stableStringify(manifest.files.map(({ path, sha256 }) => ({ path, sha256 }))));
  if (aggregate !== manifest.aggregateSha256 || manifest.policySnapshotId !== `writing-policy:${aggregate.slice(0, 16)}`) issues.push("WRITING_POLICY_MANIFEST_HASH_MISMATCH");
  if (manifest.files.some((file) => !file.path || !/^[a-f0-9]{64}$/.test(file.sha256) || file.sourcePath.includes("..") || /^[A-Za-z]:|^[\\/]/.test(file.sourcePath))) issues.push("WRITING_POLICY_FILE_ENTRY_INVALID");

  const configuredSkillRoot = process.env.HUMAN_READABLE_SKILL_DIR || process.env.HUMAN_WRITING_SKILL_DIR;
  if (configuredSkillRoot) {
    for (const file of manifest.files) {
      try {
        const actual = createHash("sha256").update(await readFile(join(configuredSkillRoot, file.sourcePath))).digest("hex");
        if (actual !== file.sha256) issues.push(`WRITING_POLICY_SOURCE_HASH_MISMATCH:${file.path}`);
      } catch {
        issues.push(`WRITING_POLICY_SOURCE_FILE_MISSING:${file.path}`);
      }
    }
  }

  return {
    schemaVersion: manifest.schemaVersion,
    policySnapshotId: manifest.policySnapshotId,
    sourceCommit: manifest.sourceCommit,
    status: manifest.status,
    summary: manifest.summary,
    taskContract: "GENERATE + TEACHING",
    promptTemplate: professorInstructions("zh-CN"),
    files: manifest.files.map(({ path, sha256 }) => ({ path, sha256 })),
    aggregateSha256: manifest.aggregateSha256,
    validator: { status: issues.length ? "failed" : "passed", sourceVerification: configuredSkillRoot ? "source_and_manifest" : "manifest_only", issues }
  };
}

function systemWriteContext(idempotencyKey: string, workspaceId: string): IdempotentWriteContext {
  return { idempotencyKey, actor: "course-os-importer", workspaceId, schemaVersion: COURSE_API_VERSION, requestId: randomUUID() };
}

function fileTitle(name: string): string {
  return name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "未命名材料";
}

function safeImportIssue(error: unknown): string {
  const message = error instanceof Error ? error.message : "IMPORT_UNKNOWN_FAILURE";
  if (message.startsWith("READWEAVE_ETAPI_")) return "READWEAVE_DRAFT_SYNC_FAILED";
  return /^[A-Z0-9_:-]+$/.test(message) ? message.slice(0, 240) : "IMPORT_INTERNAL_FAILURE";
}

function requireIdempotencyKey(request: Request): string {
  const value = request.header("Idempotency-Key");
  if (!value) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
  return value;
}

function writeContext(request: Request, idempotencyKey: string): IdempotentWriteContext {
  return { idempotencyKey, actor: request.header("X-Actor") || "personal-user", workspaceId: request.header("X-Workspace-Id") || "personal", schemaVersion: COURSE_API_VERSION, requestId: responseRequestId(request) };
}

function responseRequestId(request: Request): string {
  return request.header("X-Request-Id") || randomUUID();
}

function sendError(request: Request, response: Response, status: number, code: string, message: string, retryable: boolean, details?: unknown) {
  const body: ApiError = { error: { code, message, requestId: response.getHeader("X-Request-Id")?.toString() || responseRequestId(request), retryable, details } };
  return response.status(status).json(body);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function normalizeQualityMode(value: unknown): "economy" | "balanced" | "quality" {
  return value === "economy" || value === "quality" ? value : "balanced";
}

function clampHintLevel(value: number): 1 | 2 | 3 | 4 | 5 | 6 {
  return Math.max(1, Math.min(6, Number.isFinite(value) ? Math.trunc(value) : 1)) as 1 | 2 | 3 | 4 | 5 | 6;
}

function buildHint(check: string, level: number): string {
  const labels = ["先指出你卡住的具体步骤", "回忆本页最关键的定义", "把问题拆成输入、规则和输出", "参考本页完整例子的同类步骤", "先完成一个更小的局部例子", "完整答案应依据本页讲解，阅读后请用自己的话重新解释"];
  return `${labels[level - 1]}\n\n理解检查：${check}`;
}

function normalizeAnswer(value: string): string {
  return value.toLowerCase().replace(/[\s，。,.；;：:]/g, "");
}

function selectQuestionBank(bank: QuestionBankItem[], seed: string, count: number): QuestionBankItem[] {
  const approved = bank.filter((item) => item.status === "approved");
  const score = (item: QuestionBankItem) => sha256Text(`${seed}:${item.id}`);
  const comprehension = approved.filter((item) => item.kind === "comprehension").sort((a, b) => score(a).localeCompare(score(b)));
  const choice = approved.filter((item) => item.kind === "multiple_choice").sort((a, b) => score(a).localeCompare(score(b)));
  const selected: QuestionBankItem[] = [];
  while (selected.length < count && (comprehension.length || choice.length)) {
    const source = selected.length % 2 === 0 ? comprehension : choice;
    const fallback = source.length ? source : selected.length % 2 === 0 ? choice : comprehension;
    const item = fallback.shift();
    if (item) selected.push(item);
  }
  return selected;
}

function seededOrder(values: string[], seed: string): string[] {
  return [...values].sort((left, right) => sha256Text(`${seed}:${left}`).localeCompare(sha256Text(`${seed}:${right}`)));
}

function legacyQuestionBank(release: CourseRelease, pageId: string): QuestionBankItem[] {
  const item = release.assessments.find((candidate) => candidate.pageId === pageId);
  if (!item) return [];
  return [{ id: item.id, pageId, objectiveId: item.objectiveId, kind: "comprehension", prompt: item.prompt, expectedAnswer: item.expectedAnswer, explanation: item.expectedAnswer, sourceAnchorIds: [], status: "approved", version: 1, generatedBy: "legacy-assessment-adapter" }];
}

function refillQuestionBank(page: CourseRelease["pages"][number], count: number): QuestionBankItem[] {
  const objectiveId = page.lessonSections?.find((item) => item.kind === "learning_objectives")?.id ?? `${page.id}:objective`;
  const anchorIds = page.anchors.map((item) => item.id);
  const full = page.lessonSections?.find((item) => item.kind === "full_explanation")?.markdown ?? page.blocks.find((item) => item.kind === "core")?.markdown ?? page.title;
  return Array.from({ length: count }, (_, index): QuestionBankItem => {
    const kind = index % 2 === 0 ? "comprehension" : "multiple_choice";
    const expectedAnswer = full.split(/\r?\n/).find((line) => line.trim().length > 12)?.trim() || page.title;
    return {
      id: `${page.id}:question:refill:${Date.now()}:${index + 1}`,
      pageId: page.id,
      objectiveId,
      kind,
      prompt: kind === "comprehension" ? `请解释${page.title}中的核心关系` : `关于${page.title}，哪一项最符合本页讲解`,
      options: kind === "multiple_choice" ? [expectedAnswer, "只需要记忆标题", "不需要检查输入条件", "所有场景都得到相同结论"] : undefined,
      expectedAnswer,
      explanation: expectedAnswer,
      sourceAnchorIds: anchorIds,
      status: "approved",
      version: 1,
      generatedBy: "deterministic-refill-v1"
    };
  });
}

function buildCostRollups(entries: GenerationCostEntry[]): CostRollup[] {
  const scopes = new Map<string, { scope: CostRollup["scope"]; scopeId: string; entries: GenerationCostEntry[] }>();
  const add = (scope: CostRollup["scope"], scopeId: string, entry: GenerationCostEntry) => {
    const key = `${scope}:${scopeId}`;
    const group = scopes.get(key) ?? { scope, scopeId, entries: [] };
    group.entries.push(entry);
    scopes.set(key, group);
  };
  for (const entry of entries) {
    add("workspace", entry.workspaceId, entry);
    add("course", entry.courseId, entry);
    add("material", entry.materialVersionId, entry);
    add("job", entry.jobId, entry);
    if (entry.pageId) add("page", entry.pageId, entry);
  }
  return [...scopes.values()].map((group) => ({
    scope: group.scope,
    scopeId: group.scopeId,
    actualMicrousd: group.entries.reduce((sum, item) => sum + item.actualMicrousd, 0),
    estimatedMicrousd: group.entries.reduce((sum, item) => sum + item.estimatedMicrousd, 0),
    cashCostMicrousd: group.entries.reduce((sum, item) => sum + (item.cashCostMicrousd ?? 0), 0),
    quotaConsumedMicrousd: group.entries.reduce((sum, item) => sum + (item.quotaConsumedMicrousd ?? 0), 0),
    estimatedCashCostMicrousd: group.entries.reduce((sum, item) => sum + (item.estimatedCashCostMicrousd ?? item.cashCostMicrousd ?? 0), 0),
    estimatedQuotaConsumedMicrousd: group.entries.reduce((sum, item) => sum + (item.estimatedQuotaConsumedMicrousd ?? item.quotaConsumedMicrousd ?? 0), 0),
    callCount: group.entries.length,
    byStage: groupedCost(group.entries, (item) => item.stage).map(([stage, value]) => ({ stage: stage as GenerationCostEntry["stage"], actualMicrousd: value.cost, calls: value.calls })),
    byModel: groupedCost(group.entries, (item) => item.model).map(([model, value]) => ({ model, actualMicrousd: value.cost, calls: value.calls }))
  }));
}

function groupedCost(entries: GenerationCostEntry[], keyOf: (entry: GenerationCostEntry) => string): Array<[string, { cost: number; calls: number }]> {
  const groups = new Map<string, { cost: number; calls: number }>();
  for (const entry of entries) {
    const key = keyOf(entry);
    const current = groups.get(key) ?? { cost: 0, calls: 0 };
    current.cost += entry.actualMicrousd;
    current.calls += 1;
    groups.set(key, current);
  }
  return [...groups.entries()];
}

export function createDefaultDependencies(dataDir: string, readweave: ReadWeaveCourseApi, modelRouter: ModelRouterClient | undefined = modelRouterFromEnvironment()): AppDependencies {
  const conversion = process.env.COURSE_OS_CONVERSION_QUEUE_MODE === "file"
    ? new FileConversionQueueClient({ queueRoot: join(dataDir, "conversion-queue") })
    : { enqueueAndWait: (request: ConversionRequest) => convertMaterial(request) };
  const operations = process.env.DATABASE_URL
    ? new PostgresOperationalStore({ connectionString: process.env.DATABASE_URL })
    : new OperationalStore(join(dataDir, "operations.json"));
  return { dataDir, operations, readweave, cas: new ContentAddressedStore(join(dataDir, "cas")), conversion, modelRouter };
}
