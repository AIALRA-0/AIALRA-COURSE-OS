import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SecretVault } from "./secret-vault.js";

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

describe("settings secret vault", () => {
  it("requires a deployment key in production", async () => {
    process.env.NODE_ENV = "production";
    const root = await mkdtemp(join(tmpdir(), "course-os-vault-"));
    expect(() => new SecretVault(join(root, "secrets.json"))).toThrow("COURSE_OS_SETTINGS_KEY_REQUIRED");
  });

  it("encrypts and reads a provider credential with the configured key", async () => {
    process.env.NODE_ENV = "production";
    const root = await mkdtemp(join(tmpdir(), "course-os-vault-"));
    const vault = new SecretVault(join(root, "secrets.json"), "test-deployment-key");
    await vault.set("model-provider:deepseek", "secret-value");
    expect(await vault.get("model-provider:deepseek")).toBe("secret-value");
    expect(await vault.has("model-provider:deepseek")).toBe(true);
  });
});
