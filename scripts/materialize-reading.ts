import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { EtapiReadWeaveCourseApi, FileReadWeaveCourseApi, HttpReadWeaveCourseApi } from "@course-os/readweave-adapter";
import { buildReadingTree } from "../apps/api/src/app.js";
import { EtapiSettingsRuntime } from "../apps/api/src/etapi-settings-routes.js";
import { ReadingRuntime } from "../apps/api/src/reading-runtime.js";
import { SecretVault } from "../apps/api/src/secret-vault.js";

// Operator-only controlled confirmation of existing authority data, never a startup job.
const dataDir = resolve(process.env.COURSE_OS_DATA_DIR || "var");
const workspaceId = process.env.COURSE_OS_WORKSPACE_ID || "personal";
const secretFile = async (path?: string) => path ? (await readFile(path, "utf8")).trim() : "";
if (!process.env.COURSE_OS_SETTINGS_KEY) process.env.COURSE_OS_SETTINGS_KEY = await secretFile(process.env.COURSE_OS_SETTINGS_KEY_FILE);
const token = process.env.READWEAVE_API_TOKEN_FILE
  ? await secretFile(process.env.READWEAVE_API_TOKEN_FILE) : process.env.READWEAVE_API_TOKEN || "";
const config = process.env.READWEAVE_MODE === "etapi" ? {
  baseUrl: process.env.READWEAVE_BASE_URL || "http://127.0.0.1:37840", token,
  parentNoteId: process.env.READWEAVE_ROOT_NOTE_ID || "root", publicUrl: process.env.READWEAVE_PUBLIC_URL,
  workspaceId, seedStatePath: join(dataDir, "readweave-course-store.json")
} : undefined;
const fallback = () => process.env.READWEAVE_MODE === "http"
  ? new HttpReadWeaveCourseApi(process.env.READWEAVE_BASE_URL || "http://127.0.0.1:37840/api/course/v1", token, fetch, process.env.READWEAVE_PUBLIC_URL)
  : new FileReadWeaveCourseApi(join(dataDir, "readweave-course-store.json"), process.env.READWEAVE_PUBLIC_URL);
const settings = new EtapiSettingsRuntime({ dataDir, workspaceId, vault: new SecretVault(join(dataDir, "settings-secrets.json")),
  initialConfig: config, initialAdapter: config ? new EtapiReadWeaveCourseApi(config) : fallback(), fallbackAdapter: fallback });
const authority = await settings.initialize();
const identity = settings.readingIdentity();
const runtime = new ReadingRuntime(join(dataDir, "confirmed-reading", identity), authority, workspaceId, identity, buildReadingTree);
await runtime.initialize();
const startedAt = Date.now();
try {
  await runtime.materialize(180_000);
  const status = runtime.status();
  if (!status.ready) throw new Error("READING_NOT_READY_AFTER_CONFIRMATION");
  process.stdout.write(JSON.stringify({ ...status, elapsedMs: Date.now() - startedAt }) + "\n");
} finally { runtime.close(); }
