import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type VaultFile = Record<string, { iv: string; tag: string; value: string; updatedAt: string }>;

/**
 * A deliberately small local secret store for the single-user deployment
 *
 * The browser only receives the masked credential status. The encryption key
 * must come from the deployment secret, never from a request or a log line
 */
export class SecretVault {
  constructor(private readonly filePath: string, masterSecret = configuredSettingsSecret()) {
    const resolvedSecret = masterSecret?.trim();
    if (!resolvedSecret && process.env.NODE_ENV === "production") throw new Error("COURSE_OS_SETTINGS_KEY_REQUIRED");
    this.key = createHash("sha256").update(resolvedSecret || "course-os-local-development-key").digest();
  }

  private readonly key: Buffer;
  private writeChain: Promise<void> = Promise.resolve();

  async set(name: string, value: string): Promise<void> {
    if (!name || !value) throw new Error("SECRET_VAULT_VALUE_REQUIRED");
    await this.serializeWrite(async () => {
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
      await this.persist(current);
    });
  }

  async delete(name: string): Promise<boolean> {
    if (!name) throw new Error("SECRET_VAULT_NAME_REQUIRED");
    let deleted = false;
    await this.serializeWrite(async () => {
      const current = await this.read();
      if (!Object.hasOwn(current, name)) return;
      delete current[name];
      await this.persist(current);
      deleted = true;
    });
    return deleted;
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

  private async serializeWrite(change: () => Promise<void>): Promise<void> {
    this.writeChain = this.writeChain.catch(() => undefined).then(change);
    await this.writeChain;
  }

  private async persist(value: VaultFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

function configuredSettingsSecret(): string | undefined {
  const direct = process.env.COURSE_OS_SETTINGS_KEY?.trim();
  if (direct) return direct;
  const filePath = process.env.COURSE_OS_SETTINGS_KEY_FILE?.trim();
  if (!filePath) return undefined;
  try {
    return readFileSync(filePath, "utf8").trim() || undefined;
  } catch {
    if (process.env.NODE_ENV === "production") throw new Error("COURSE_OS_SETTINGS_KEY_REQUIRED");
    return undefined;
  }
}
