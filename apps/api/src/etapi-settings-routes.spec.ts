import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { AppDependencies } from "./app.js";
import { EtapiSettingsRuntime, registerEtapiSettingsRoutes } from "./etapi-settings-routes.js";
import { SecretVault } from "./secret-vault.js";
import { EtapiReadWeaveCourseApi } from "@course-os/readweave-adapter";

async function harness(fetchImpl: typeof fetch = async () => new Response("{}", { status: 200 })) {
  const dataDir = await mkdtemp(join(tmpdir(), "course-os-etapi-settings-"));
  const vault = new SecretVault(join(dataDir, "settings-secrets.json"), "test-settings-key");
  const state = { idempotency: {} as Record<string, { kind: string; objectId: string }> };
  const dependencies = {
    operations: {
      read: async () => state,
      urgentMutate: async <T>(change: (current: typeof state) => T) => change(state)
    }
  } as unknown as AppDependencies;
  const fallback = { name: "fallback" } as unknown as AppDependencies["readweave"];
  const runtime = new EtapiSettingsRuntime({
    dataDir,
    workspaceId: "personal",
    vault,
    initialAdapter: fallback,
    fallbackAdapter: () => fallback,
    createAdapter: config => new EtapiReadWeaveCourseApi({ ...config, fetchImpl })
  });
  await runtime.initialize();
  let activeAdapter = fallback;
  runtime.bind(adapter => { activeAdapter = adapter; });
  const app = express();
  app.use(express.json());
  registerEtapiSettingsRoutes(app, dependencies, runtime);
  return { app, dataDir, dependencies, runtime, state, vault, activeAdapter: () => activeAdapter };
}

function headers(key: string) {
  return {
    "X-Workspace-Id": "personal",
    "X-Actor": "settings-test",
    "X-Request-Id": `request-${key}`,
    "X-Schema-Version": "2.4.0",
    "Idempotency-Key": key
  };
}

describe("ReadWeave ETAPI settings routes", () => {
  it("validates before applying, masks secrets, persists across restart, and disables on DELETE", async () => {
    const seenAuthorization: string[] = [];
    const { app, dataDir, runtime, vault, activeAdapter } = await harness(async (_input, init) => {
      seenAuthorization.push(new Headers(init?.headers).get("Authorization") || "");
      return new Response("{}", { status: 200 });
    });
    const config = { baseUrl: "https://readweave.example", parentNoteId: "root-note", token: "do-not-return-this" };

    const path = "/api/v1/readweave/etapi-settings";
    const saved = await request(app).put(path).set(headers("set-1")).send({ ...config, publicUrl: "https://notes.example" }).expect(200);
    expect(saved.body).toMatchObject({ enabled: true, baseUrl: config.baseUrl, parentNoteId: config.parentNoteId, publicUrl: "https://notes.example", credential: { configured: true, maskedValue: "••••" } });
    expect(JSON.stringify(saved.body)).not.toContain(config.token);
    expect(JSON.stringify(await request(app).get(path).expect(200).then(response => response.body))).not.toContain(config.token);
    expect(seenAuthorization).toEqual([config.token]);
    expect(activeAdapter()).not.toBeUndefined();

    const failedFetch = async () => new Response("unauthorized", { status: 401 });
    const failedRuntime = new EtapiSettingsRuntime({
      dataDir,
      workspaceId: "personal",
      vault,
      initialAdapter: activeAdapter(),
      fallbackAdapter: () => activeAdapter() as AppDependencies["readweave"],
      createAdapter: candidate => new EtapiReadWeaveCourseApi({ ...candidate, fetchImpl: failedFetch })
    });
    await failedRuntime.initialize();
    const failedApp = express();
    failedApp.use(express.json());
    registerEtapiSettingsRoutes(failedApp, { operations: { read: async () => ({ idempotency: {} }), urgentMutate: async () => undefined } } as unknown as AppDependencies, failedRuntime);
    await request(failedApp).put(path).set(headers("failed-update")).send({ ...config, baseUrl: "https://invalid.example" }).expect(422);
    expect(failedRuntime.snapshot()).toMatchObject({ enabled: true, baseUrl: config.baseUrl, parentNoteId: config.parentNoteId });

    // A fresh runtime reading the same directory recovers the committed settings.
    const restartedRuntime = new EtapiSettingsRuntime({
      dataDir,
      workspaceId: "personal",
      vault,
      initialAdapter: activeAdapter(),
      fallbackAdapter: () => activeAdapter()
    });
    await restartedRuntime.initialize();
    expect(restartedRuntime.snapshot()).toMatchObject({ enabled: true, baseUrl: config.baseUrl, credential: { configured: true } });

    const oldSecretRef = await readStoredSecretReference(dataDir);
    await request(app).delete(path).set(headers("delete-1")).expect(200).expect(response => {
      expect(response.body).toMatchObject({ enabled: false, credential: { configured: false } });
      expect(JSON.stringify(response.body)).not.toContain(config.token);
    });
    expect(await vault.has(oldSecretRef)).toBe(false);
    const afterDelete = new EtapiSettingsRuntime({ dataDir, workspaceId: "personal", vault, initialAdapter: activeAdapter(), fallbackAdapter: () => activeAdapter() });
    await afterDelete.initialize();
    expect(afterDelete.snapshot()).toMatchObject({ enabled: false, credential: { configured: false } });
  });

  it("requires the normal idempotency headers and replays successful writes", async () => {
    const { app, state } = await harness();
    const config = { baseUrl: "http://localhost:37840", parentNoteId: "root", token: "private-token" };
    await request(app).put("/api/v1/readweave/etapi-settings").send(config).expect(400);
    await request(app).put("/api/v1/readweave/etapi-settings").set(headers("same-write")).send(config).expect(200);
    const replay = await request(app).put("/api/v1/readweave/etapi-settings").set(headers("same-write")).send(config).expect(200);
    expect(replay.body.replayed).toBe(true);
    expect(Object.keys(state.idempotency)).toHaveLength(1);
  });
});

async function readStoredSecretReference(dataDir: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const settings = JSON.parse(await readFile(join(dataDir, "readweave-etapi-settings.json"), "utf8")) as { secretRef?: string };
  return settings.secretRef || "missing-secret-ref";
}
