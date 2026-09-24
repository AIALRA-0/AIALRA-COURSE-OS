import type { Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { EtapiReadWeaveCourseApi, FileReadWeaveCourseApi, HttpReadWeaveCourseApi } from "@course-os/readweave-adapter";
import { createApp, createDefaultDependencies, resumeIncompleteImports, resumeIncompleteJobs } from "./app.js";
import { registerSelfRetellingRoutes } from "./self-retelling-routes.js";
import { EtapiSettingsRuntime, registerEtapiSettingsRoutes } from "./etapi-settings-routes.js";
import { SecretVault } from "./secret-vault.js";

// Stable database-scoped key pair reserved for the Course OS API writer singleton.
const apiWriterLockClass = 0x434f5552;
const apiWriterLockId = 0x434f5301;

export interface ApiWriterLock {
  release(): Promise<void>;
}

/** Hold a dedicated PostgreSQL session advisory lock for the lifetime of the API process. */
export async function acquireApiWriterLock(
  connectionString: string,
  onConnectionLost: (error: Error) => void
): Promise<ApiWriterLock> {
  const client = new pg.Client({ connectionString });
  let acquired = false;
  let releasing = false;
  let lost = false;
  let connectionFailure: Error | undefined;
  let releasePromise: Promise<void> | undefined;
  const notifyLost = (error: Error) => {
    if (releasing || lost) return;
    if (!acquired) {
      connectionFailure ??= error;
      return;
    }
    lost = true;
    onConnectionLost(error);
  };
  const handleClientError = (error: Error) => notifyLost(error);
  const handleClientEnd = () => notifyLost(new Error("PostgreSQL writer-lock session ended unexpectedly"));
  client.on("error", handleClientError);
  client.on("end", handleClientEnd);

  try {
    await client.connect();
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS locked",
      [apiWriterLockClass, apiWriterLockId]
    );
    if (connectionFailure) {
      throw new Error(`API_WRITER_LOCK_SESSION_LOST_DURING_ACQUISITION: ${connectionFailure.message}`);
    }
    if (!result.rows[0]?.locked) {
      throw new Error("API_WRITER_LOCK_HELD: another API process already holds the PostgreSQL writer lock");
    }
    acquired = true;
  } catch (error) {
    acquired = false;
    client.removeListener("error", handleClientError);
    client.removeListener("end", handleClientEnd);
    await client.end().catch(() => undefined);
    throw error;
  }

  return {
    release(): Promise<void> {
      if (releasePromise) return releasePromise;
      releasing = true;
      releasePromise = (async () => {
        client.removeListener("error", handleClientError);
        client.removeListener("end", handleClientEnd);
        try {
          const result = await client.query<{ unlocked: boolean }>(
            "SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked",
            [apiWriterLockClass, apiWriterLockId]
          );
          if (!result.rows[0]?.unlocked) throw new Error("API_WRITER_LOCK_RELEASE_FAILED: PostgreSQL session did not hold the writer lock");
        } finally {
          await client.end();
        }
      })();
      return releasePromise;
    }
  };
}

/** Local and test modes do not acquire the production single-writer lock. */
export async function acquireProductionApiWriterLock(
  nodeEnv: string | undefined,
  connectionString: string | undefined,
  onConnectionLost: (error: Error) => void
): Promise<ApiWriterLock | undefined> {
  if (nodeEnv !== "production") return undefined;
  if (!connectionString?.trim()) {
    throw new Error("API_WRITER_LOCK_REQUIRES_DATABASE_URL: production API startup requires DATABASE_URL");
  }
  return acquireApiWriterLock(connectionString, onConnectionLost);
}

export async function startApiServer(): Promise<void> {
  let writerLock: ApiWriterLock | undefined;
  let closeOperations: (() => Promise<void>) | undefined;
  let server: Server | undefined;
  try {
    writerLock = await acquireProductionApiWriterLock(process.env.NODE_ENV, process.env.DATABASE_URL, error => {
      process.stderr.write(`Course OS API writer lock connection lost; terminating to preserve single-writer safety: ${error.message}\n`);
      process.exit(1);
    });

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
    const fallbackReadweave = () => process.env.READWEAVE_MODE === "http"
      ? new HttpReadWeaveCourseApi(process.env.READWEAVE_BASE_URL || "http://127.0.0.1:37840/api/course/v1", token, fetch, process.env.READWEAVE_PUBLIC_URL)
      : process.env.READWEAVE_MODE === "etapi"
        ? new EtapiReadWeaveCourseApi({
            baseUrl: process.env.READWEAVE_BASE_URL || "http://127.0.0.1:37840",
            token: "",
            parentNoteId: process.env.READWEAVE_ROOT_NOTE_ID || "root",
            publicUrl: process.env.READWEAVE_PUBLIC_URL,
            workspaceId: process.env.COURSE_OS_WORKSPACE_ID || "personal",
            seedStatePath: resolve(dataDir, "readweave-course-store.json")
          })
      : new FileReadWeaveCourseApi(resolve(dataDir, "readweave-course-store.json"), process.env.READWEAVE_PUBLIC_URL);
    const initialEtapiConfig = process.env.READWEAVE_MODE === "etapi"
      ? {
          baseUrl: process.env.READWEAVE_BASE_URL || "http://127.0.0.1:37840",
          token,
          parentNoteId: process.env.READWEAVE_ROOT_NOTE_ID || "root",
          publicUrl: process.env.READWEAVE_PUBLIC_URL,
          workspaceId: process.env.COURSE_OS_WORKSPACE_ID || "personal",
          seedStatePath: resolve(dataDir, "readweave-course-store.json")
        }
      : undefined;
    const initialReadweave = initialEtapiConfig ? new EtapiReadWeaveCourseApi(initialEtapiConfig) : fallbackReadweave();
    const credentialVault = new SecretVault(join(dataDir, "settings-secrets.json"));
    const etapiSettings = new EtapiSettingsRuntime({
      dataDir,
      workspaceId: process.env.COURSE_OS_WORKSPACE_ID || "personal",
      vault: credentialVault,
      initialAdapter: initialReadweave,
      initialConfig: initialEtapiConfig,
      fallbackAdapter: fallbackReadweave
    });
    const readweave = await etapiSettings.initialize();
    // Generation always uses the saved provider routes and the same teaching path.
    const dependencies = createDefaultDependencies(dataDir, readweave);
    if ("close" in dependencies.operations && typeof dependencies.operations.close === "function") {
      const operations = dependencies.operations as typeof dependencies.operations & { close: () => Promise<void> };
      closeOperations = () => operations.close();
    }
    dependencies.credentialVault = credentialVault;
    etapiSettings.bind(adapter => { dependencies.readweave = adapter; });
    if ("whenReady" in dependencies.operations && typeof dependencies.operations.whenReady === "function") {
      await dependencies.operations.whenReady();
    }
    const app = createApp(dependencies);
    registerSelfRetellingRoutes(app, dependencies);
    registerEtapiSettingsRoutes(app, dependencies, etapiSettings);
    server = await new Promise<Server>((resolveServer, rejectServer) => {
      const listeningServer = app.listen(port, host);
      const handleListening = () => {
        listeningServer.removeListener("error", handleError);
        resolveServer(listeningServer);
      };
      const handleError = (error: Error) => {
        listeningServer.removeListener("listening", handleListening);
        rejectServer(error);
      };
      listeningServer.once("listening", handleListening);
      listeningServer.once("error", handleError);
    });
    process.stdout.write(`Course OS API ready at http://${host}:${port}\n`);
    void resumeIncompleteImports(dependencies);
    void resumeIncompleteJobs(dependencies);

    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (): Promise<void> => {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        let shutdownError: unknown;
        try {
          await closeHttpServer(server!);
        } catch (error) {
          shutdownError = error;
        }
        try {
          await closeOperations?.();
        } catch (error) {
          shutdownError ??= error;
        }
        try {
          await writerLock?.release();
        } catch (error) {
          shutdownError ??= error;
        }
        if (shutdownError) throw shutdownError;
      })();
      return shutdownPromise;
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        void shutdown().then(
          () => process.exit(0),
          error => {
            process.stderr.write(`Course OS API shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exit(1);
          }
        );
      });
    }
  } catch (error) {
    if (server?.listening) await closeHttpServer(server).catch(() => undefined);
    await closeOperations?.().catch(() => undefined);
    await writerLock?.release().catch(() => undefined);
    throw error;
  }
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close(error => error ? rejectClose(error) : resolveClose());
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await startApiServer();
  } catch (error) {
    process.stderr.write(`Course OS API startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
