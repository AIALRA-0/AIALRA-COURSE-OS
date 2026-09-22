import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SecretVault } from "./secret-vault.js";

const originalNodeEnv = process.env.NODE_ENV;
const originalSettingsKey = process.env.COURSE_OS_SETTINGS_KEY;
const originalSettingsKeyFile = process.env.COURSE_OS_SETTINGS_KEY_FILE;

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalSettingsKey === undefined) delete process.env.COURSE_OS_SETTINGS_KEY;
  else process.env.COURSE_OS_SETTINGS_KEY = originalSettingsKey;
  if (originalSettingsKeyFile === undefined) delete process.env.COURSE_OS_SETTINGS_KEY_FILE;
  else process.env.COURSE_OS_SETTINGS_KEY_FILE = originalSettingsKeyFile;
});

describe("settings secret vault", () => {
  it("requires a deployment key in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.COURSE_OS_SETTINGS_KEY;
    delete process.env.COURSE_OS_SETTINGS_KEY_FILE;
    const root = await mkdtemp(join(tmpdir(), "course-os-vault-"));
    expect(() => new SecretVault(join(root, "secrets.json"))).toThrow("COURSE_OS_SETTINGS_KEY_REQUIRED");
  });

  it("reads the deployment key from the Compose secret file", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.COURSE_OS_SETTINGS_KEY;
    const root = await mkdtemp(join(tmpdir(), "course-os-vault-file-"));
    const keyFile = join(root, "settings-key");
    process.env.COURSE_OS_SETTINGS_KEY_FILE = keyFile;
    await writeFile(keyFile, "file-backed-deployment-key\n", { mode: 0o600 });
    const vault = new SecretVault(join(root, "secrets.json"));
    await vault.set("model-provider:deepseek", "secret-value");
    expect(await vault.get("model-provider:deepseek")).toBe("secret-value");
  });

  it("encrypts and reads a provider credential with the configured key", async () => {
    process.env.NODE_ENV = "production";
    const root = await mkdtemp(join(tmpdir(), "course-os-vault-"));
    const vault = new SecretVault(join(root, "secrets.json"), "test-deployment-key");
    await vault.set("model-provider:deepseek", "secret-value");
    expect(await vault.get("model-provider:deepseek")).toBe("secret-value");
    expect(await vault.has("model-provider:deepseek")).toBe(true);
  });

  it("deletes only the selected credential and treats repeated deletion as safe", async () => {
    const root = await mkdtemp(join(tmpdir(), "course-os-vault-delete-"));
    const filePath = join(root, "secrets.json");
    const vault = new SecretVault(filePath, "test-deployment-key");
    await Promise.all([
      vault.set("readweave:first", "first-secret-value"),
      vault.set("readweave:second", "second-secret-value")
    ]);

    expect(await vault.delete("readweave:first")).toBe(true);
    expect(await vault.delete("readweave:first")).toBe(false);
    expect(await vault.get("readweave:first")).toBeUndefined();
    expect(await vault.get("readweave:second")).toBe("second-secret-value");
    const persisted = await readFile(filePath, "utf8");
    expect(persisted).not.toContain("first-secret-value");
    expect(persisted).not.toContain("second-secret-value");
  });
});
