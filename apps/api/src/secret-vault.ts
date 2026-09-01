import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type VaultFile = Record<string, { iv: string; tag: string; value: string; updatedAt: string }>;

/**
 * A deliberately small local secret store for the single-user deployment
 *
 * The browser only receives the masked credential status. The encryption key
 * must come from the deployment secret, never from a request or a log line
 */
export class SecretVault {
  constructor(private readonly filePath: string, masterSecret = process.env.COURSE_OS_SETTINGS_KEY) {
    const resolvedSecret = masterSecret?.trim();
    if (!resolvedSecret && process.env.NODE_ENV === "production") throw new Error("COURSE_OS_SETTINGS_KEY_REQUIRED");
    this.key = createHash("sha256").update(resolvedSecret || "course-os-local-development-key").digest();
  }

  private readonly key: Buffer;

  async set(name: string, value: string): Promise<void> {
    if (!name || !value) throw new Error("SECRET_VAULT_VALUE_REQUIRED");
    const current = await this.read();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    current[name] = {
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      value: encrypted.toString("base64url"),
      updatedAt: new Date().toISOString()
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(current, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  async get(name: string): Promise<string | undefined> {
    const item = (await this.read())[name];
    if (!item) return undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(item.iv, "base64url"));
      decipher.setAuthTag(Buffer.from(item.tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(item.value, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("SECRET_VAULT_DECRYPT_FAILED");
    }
  }

  async has(name: string): Promise<boolean> {
    return Boolean((await this.read())[name]);
  }

  private async read(): Promise<VaultFile> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as VaultFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }
}
