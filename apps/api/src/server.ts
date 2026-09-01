import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { EtapiReadWeaveCourseApi, FileReadWeaveCourseApi, HttpReadWeaveCourseApi } from "@course-os/readweave-adapter";
import { createApp, createDefaultDependencies, resumeIncompleteImports, resumeIncompleteJobs } from "./app.js";
import { HttpModelRouterClient, providerRouterFromEnvironment } from "./model-router.js";

const host = process.env.COURSE_OS_HOST || "127.0.0.1";
const port = Number(process.env.COURSE_OS_PORT || 4100);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dataDir = resolve(process.env.COURSE_OS_DATA_DIR || resolve(projectRoot, "var"));
const loadSecretFile = async (filePath: string | undefined): Promise<string> => {
  if (!filePath) return "";
  try { return (await readFile(filePath, "utf8")).trim(); }
  catch { return ""; }
};
if (!process.env.COURSE_OS_SETTINGS_KEY) process.env.COURSE_OS_SETTINGS_KEY = await loadSecretFile(process.env.COURSE_OS_SETTINGS_KEY_FILE);
if (!process.env.COURSE_OS_WORKER_TOKEN) process.env.COURSE_OS_WORKER_TOKEN = await loadSecretFile(process.env.COURSE_OS_WORKER_TOKEN_FILE);
const token = process.env.READWEAVE_API_TOKEN_FILE
  ? (await readFile(process.env.READWEAVE_API_TOKEN_FILE, "utf8")).trim()
  : process.env.READWEAVE_API_TOKEN || "";
const readweave = process.env.READWEAVE_MODE === "etapi"
  ? new EtapiReadWeaveCourseApi({
      baseUrl: process.env.READWEAVE_BASE_URL || "http://127.0.0.1:37840",
      token,
      parentNoteId: process.env.READWEAVE_ROOT_NOTE_ID || "root",
      publicUrl: process.env.READWEAVE_PUBLIC_URL,
      workspaceId: process.env.COURSE_OS_WORKSPACE_ID || "personal",
      seedStatePath: resolve(dataDir, "readweave-course-store.json")
    })
  : process.env.READWEAVE_MODE === "http"
    ? new HttpReadWeaveCourseApi(process.env.READWEAVE_BASE_URL || "http://127.0.0.1:37840/api/course/v1", token, fetch, process.env.READWEAVE_PUBLIC_URL)
    : new FileReadWeaveCourseApi(resolve(dataDir, "readweave-course-store.json"), process.env.READWEAVE_PUBLIC_URL);
if (!process.env.OPENCODE_GO_API_KEY) process.env.OPENCODE_GO_API_KEY = await loadSecretFile(process.env.OPENCODE_GO_API_KEY_FILE);
if (!process.env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = await loadSecretFile(process.env.DEEPSEEK_API_KEY_FILE);
const configuredProviderRouter = providerRouterFromEnvironment();
const modelRouterToken = process.env.MODEL_ROUTER_API_KEY || await loadSecretFile(process.env.MODEL_ROUTER_API_KEY_FILE);
const emergencyRouter = process.env.COURSE_OS_ALLOW_AIALRA_EMERGENCY === "true" && process.env.MODEL_ROUTER_URL && modelRouterToken
  ? new HttpModelRouterClient(process.env.MODEL_ROUTER_URL, modelRouterToken)
  : undefined;
const modelRouter = configuredProviderRouter ?? emergencyRouter;

const dependencies = createDefaultDependencies(dataDir, readweave, modelRouter);
if ("whenReady" in dependencies.operations && typeof dependencies.operations.whenReady === "function") {
  await dependencies.operations.whenReady();
}
const app = createApp(dependencies);
app.listen(port, host, () => {
  process.stdout.write(`Course OS API ready at http://${host}:${port}\n`);
  void resumeIncompleteImports(dependencies);
  void resumeIncompleteJobs(dependencies);
});

const shutdown = async () => {
  if ("close" in dependencies.operations && typeof dependencies.operations.close === "function") await dependencies.operations.close();
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void shutdown().finally(() => process.exit(0)); });
