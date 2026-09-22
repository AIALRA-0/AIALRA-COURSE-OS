import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Express, Request, Response } from "express";
import { COURSE_API_VERSION } from "@course-os/contracts";
import { EtapiReadWeaveCourseApi, type EtapiReadWeaveConfig, type ReadWeaveCourseApi } from "@course-os/readweave-adapter";
import { writeJsonAtomic } from "@course-os/storage";
import type { AppDependencies } from "./app.js";
import { SecretVault } from "./secret-vault.js";

const settingsFileName = "readweave-etapi-settings.json";
const secretNamePrefix = "readweave-etapi:";
const settingsIdempotencyPrefix = "settings:readweave-etapi:";

export interface EtapiSettingsInput {
  baseUrl: string;
  parentNoteId: string;
  publicUrl?: string;
}

interface StoredEtapiSettings extends EtapiSettingsInput {
  schemaVersion: 1;
  enabled: boolean;
  workspaceId: string;
  secretRef?: string;
}

export interface EtapiSettingsSnapshot {
  enabled: boolean;
  baseUrl: string;
  parentNoteId: string;
  publicUrl: string;
  credential: { configured: boolean; maskedValue?: string };
}

interface WriteContext {
  workspaceId: string;
  idempotencyKey: string;
}

export class EtapiSettingsRuntime {
  private adapter: ReadWeaveCourseApi;
  private current?: EtapiSettingsInput;
  private currentToken?: string;
  private secretRef?: string;
  private enabled = false;
  private applyAdapter?: (adapter: ReadWeaveCourseApi) => void;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly settingsPath: string;

  constructor(private readonly options: {
    dataDir: string;
    workspaceId: string;
    vault: SecretVault;
    initialAdapter: ReadWeaveCourseApi;
    initialConfig?: EtapiReadWeaveConfig;
    fallbackAdapter: () => ReadWeaveCourseApi;
    createAdapter?: (config: EtapiReadWeaveConfig) => EtapiReadWeaveCourseApi;
  }) {
    this.settingsPath = join(options.dataDir, settingsFileName);
    this.adapter = options.initialAdapter;
    if (options.initialConfig) {
      this.current = publicConfig(options.initialConfig);
      this.currentToken = options.initialConfig.token;
      this.enabled = Boolean(options.initialConfig.token);
    }
  }

  async initialize(): Promise<ReadWeaveCourseApi> {
    let stored: StoredEtapiSettings;
    try {
      stored = JSON.parse(await readFile(this.settingsPath, "utf8")) as StoredEtapiSettings;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.adapter;
      throw new Error("READWEAVE_SETTINGS_LOAD_FAILED");
    }
    if (!isStoredSettings(stored)) throw new Error("READWEAVE_SETTINGS_INVALID");
    if (!stored.enabled) {
      this.adapter = this.options.fallbackAdapter();
      this.current = stored.baseUrl && stored.parentNoteId ? pickInput(stored) : undefined;
      this.secretRef = stored.secretRef;
      this.currentToken = stored.secretRef ? await this.options.vault.get(stored.secretRef) : undefined;
      this.enabled = false;
      return this.adapter;
    }
    const token = stored.secretRef ? await this.options.vault.get(stored.secretRef) : undefined;
    if (!token) throw new Error("READWEAVE_SETTINGS_SECRET_MISSING");
    this.current = pickInput(stored);
    this.currentToken = token;
    this.secretRef = stored.secretRef;
    this.enabled = true;
    this.adapter = this.createAdapter({ ...this.current, token, workspaceId: stored.workspaceId });
    return this.adapter;
  }

  bind(applyAdapter: (adapter: ReadWeaveCourseApi) => void): void {
    this.applyAdapter = applyAdapter;
    applyAdapter(this.adapter);
  }

  snapshot(): EtapiSettingsSnapshot {
    return {
      enabled: this.enabled,
      baseUrl: this.current?.baseUrl ?? "",
      parentNoteId: this.current?.parentNoteId ?? "",
      publicUrl: this.current?.publicUrl ?? "",
      credential: this.currentToken ? { configured: true, maskedValue: "••••" } : { configured: false }
    };
  }

  async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    let result!: T;
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => { result = await operation(); });
    await this.writeChain;
    return result;
  }

  async configure(input: EtapiSettingsInput, suppliedToken: string | undefined, enabled: boolean): Promise<EtapiSettingsSnapshot> {
    const token = suppliedToken?.trim() || this.currentToken;
    if (!token) throw new Error("READWEAVE_TOKEN_REQUIRED");
    const config = { ...input, token, workspaceId: this.options.workspaceId };
    const candidate = this.createAdapter(config);
    await candidate.verifyConnection();

    const nextSecretRef = `${secretNamePrefix}${randomUUID()}`;
    await this.options.vault.set(nextSecretRef, token);
    const stored: StoredEtapiSettings = {
      schemaVersion: 1,
      enabled,
      ...input,
      workspaceId: this.options.workspaceId,
      secretRef: nextSecretRef
    };
    try {
      await writeJsonAtomic(this.settingsPath, stored);
    } catch {
      await this.options.vault.delete(nextSecretRef).catch(() => undefined);
      throw new Error("READWEAVE_SETTINGS_SAVE_FAILED");
    }

    const oldSecretRef = this.secretRef;
    this.secretRef = nextSecretRef;
    this.currentToken = token;
    this.current = input;
    this.enabled = enabled;
    this.adapter = enabled ? candidate : this.options.fallbackAdapter();
    this.applyAdapter?.(this.adapter);
    if (oldSecretRef && oldSecretRef !== nextSecretRef) await this.options.vault.delete(oldSecretRef).catch(() => undefined);
    return this.snapshot();
  }

  async disable(): Promise<EtapiSettingsSnapshot> {
    const stored: StoredEtapiSettings = {
      schemaVersion: 1,
      enabled: false,
      baseUrl: "",
      parentNoteId: "",
      workspaceId: this.options.workspaceId
    };
    try {
      await writeJsonAtomic(this.settingsPath, stored);
    } catch {
      throw new Error("READWEAVE_SETTINGS_SAVE_FAILED");
    }
    const oldSecretRef = this.secretRef;
    const fallback = this.options.fallbackAdapter();
    this.secretRef = undefined;
    this.currentToken = undefined;
    this.current = undefined;
    this.enabled = false;
    this.adapter = fallback;
    this.applyAdapter?.(fallback);
    if (oldSecretRef) await this.options.vault.delete(oldSecretRef).catch(() => undefined);
    return this.snapshot();
  }

  private createAdapter(config: EtapiReadWeaveConfig): EtapiReadWeaveCourseApi {
    return this.options.createAdapter?.(config) ?? new EtapiReadWeaveCourseApi(config);
  }
}

export function registerEtapiSettingsRoutes(app: Express, dependencies: AppDependencies, runtime: EtapiSettingsRuntime): void {
  const paths = ["/api/v1/readweave/etapi-settings", "/api/v1/settings/readweave-etapi"];
  for (const path of paths) app.get(path, (_request, response) => response.json(runtime.snapshot()));

  const put = async (request: Request, response: Response) => {
    const context = writeContext(request, response);
    if (!context) return;
    await runtime.withWriteLock(async () => {
      const enabled = request.body?.enabled !== false;
      if (await replayWrite(dependencies, context, "readweave_etapi_settings", enabled ? "enabled" : "disabled", response, runtime)) return;
      const input = validateInput(request.body);
      if (!input) return problem(response, 422, "READWEAVE_SETTINGS_INVALID", "请检查 ReadWeave ETAPI 地址和根笔记设置");
      const token = typeof request.body.token === "string" ? request.body.token : undefined;
      try {
        const result = await runtime.configure(input, token, enabled);
        await recordWrite(dependencies, context, "readweave_etapi_settings", enabled ? "enabled" : "disabled");
        response.json(result);
      } catch (error) {
        const code = error instanceof Error ? error.message : "READWEAVE_SETTINGS_APPLY_FAILED";
        if (code === "READWEAVE_TOKEN_REQUIRED") return problem(response, 422, code, "请提供 ReadWeave ETAPI token");
        return problem(response, code === "READWEAVE_SETTINGS_SAVE_FAILED" ? 503 : 422,
          code.startsWith("READWEAVE_ETAPI_") ? "READWEAVE_CONNECTION_FAILED" : code,
          code.startsWith("READWEAVE_ETAPI_") ? "无法连接 ReadWeave，请检查地址、权限和根笔记" : "设置未应用，请检查配置后重试");
      }
    });
  };
  for (const path of paths) app.put(path, put);

  const remove = async (request: Request, response: Response) => {
    const context = writeContext(request, response);
    if (!context) return;
    await runtime.withWriteLock(async () => {
      if (await replayWrite(dependencies, context, "readweave_etapi_settings", "disabled", response, runtime)) return;
      try {
        const result = await runtime.disable();
        await recordWrite(dependencies, context, "readweave_etapi_settings", "disabled");
        response.json(result);
      } catch {
        problem(response, 503, "READWEAVE_SETTINGS_SAVE_FAILED", "设置未能保存，请重试");
      }
    });
  };
  for (const path of paths) app.delete(path, remove);
}

function publicConfig(config: EtapiReadWeaveConfig): EtapiSettingsInput {
  return { baseUrl: config.baseUrl, parentNoteId: config.parentNoteId, ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}) };
}

function pickInput(stored: StoredEtapiSettings): EtapiSettingsInput {
  return { baseUrl: stored.baseUrl, parentNoteId: stored.parentNoteId, ...(stored.publicUrl ? { publicUrl: stored.publicUrl } : {}) };
}

function isStoredSettings(value: StoredEtapiSettings): boolean {
  return Boolean(value && value.schemaVersion === 1 && typeof value.enabled === "boolean"
    && typeof value.workspaceId === "string"
    && (value.enabled
      ? typeof value.baseUrl === "string" && typeof value.parentNoteId === "string" && typeof value.secretRef === "string"
      : true));
}

function validateInput(body: unknown): EtapiSettingsInput | undefined {
  if (!body || typeof body !== "object") return undefined;
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.baseUrl !== "string" || typeof candidate.parentNoteId !== "string") return undefined;
  const baseUrl = normalizeHttpUrl(candidate.baseUrl);
  const parentNoteId = candidate.parentNoteId.trim();
  if (!baseUrl || !/^[A-Za-z0-9:._-]{1,256}$/u.test(parentNoteId)) return undefined;
  let publicUrl: string | undefined;
  if (candidate.publicUrl !== undefined && candidate.publicUrl !== "") {
    if (typeof candidate.publicUrl !== "string") return undefined;
    publicUrl = normalizeHttpUrl(candidate.publicUrl);
    if (!publicUrl) return undefined;
  }
  return { baseUrl, parentNoteId, ...(publicUrl ? { publicUrl } : {}) };
}

function normalizeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    return url.toString().replace(/\/$/u, "");
  } catch { return undefined; }
}

function writeContext(request: Request, response: Response): WriteContext | undefined {
  const workspaceId = request.header("X-Workspace-Id") || "personal";
  const idempotencyKey = request.header("Idempotency-Key")?.trim();
  if (!idempotencyKey || !request.header("X-Actor") || !request.header("X-Request-Id")
    || request.header("X-Schema-Version") !== COURSE_API_VERSION) {
    problem(response, 400, "WRITE_HEADERS_REQUIRED", "保存缺少必要请求信息，请刷新后重试");
    return undefined;
  }
  return { workspaceId, idempotencyKey };
}

async function replayWrite(dependencies: AppDependencies, context: WriteContext, kind: string, objectId: string, response: Response, runtime: EtapiSettingsRuntime): Promise<boolean> {
  const key = `${settingsIdempotencyPrefix}${context.workspaceId}:${context.idempotencyKey}`;
  const replay = (await dependencies.operations.read()).idempotency[key];
  if (!replay) return false;
  if (replay.kind !== kind || replay.objectId !== objectId) {
    problem(response, 409, "IDEMPOTENCY_CONFLICT", "本次提交编号已被其他操作使用");
    return true;
  }
  response.json({ ...runtime.snapshot(), replayed: true });
  return true;
}

async function recordWrite(dependencies: AppDependencies, context: WriteContext, kind: string, objectId: string): Promise<void> {
  const key = `${settingsIdempotencyPrefix}${context.workspaceId}:${context.idempotencyKey}`;
  await dependencies.operations.urgentMutate(state => {
    const existing = state.idempotency[key];
    if (existing && (existing.kind !== kind || existing.objectId !== objectId)) throw new Error("IDEMPOTENCY_CONFLICT");
    state.idempotency[key] = { kind, objectId };
  });
}

function problem(response: Response, status: number, code: string, message: string): Response {
  return response.status(status).json({ error: { code, message, retryable: status >= 500 } });
}
