import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256Text, stableStringify } from "@course-os/domain";
import { compileWritingStandard, loadWritingStandards } from "../apps/api/src/writing-standards.js";

if (process.argv.includes("--help")) {
  console.log("pnpm exec tsx scripts/sync-writing-standards.ts [--check]\nSync imports the current APCF LOCK-pinned public standards; --check verifies the self-contained runtime bundle without APCF installed.");
} else if (process.argv.includes("--check")) {
  const bundle = loadWritingStandards();
  console.log(JSON.stringify({ status: "passed", policySnapshotId: bundle.policySnapshotId, writingRules: 29, styleRules: 15 }));
} else {
  if (process.argv.slice(2).length) throw new Error("WRITING_STANDARD_ARGUMENT_UNSUPPORTED");
  const lock = await readFile(resolve(".agent-project-control/standards/LOCK.yaml"), "utf8");
  const value = (key: string) => {
    const match = new RegExp(`^${key}: (.+)$`, "m").exec(lock);
    if (!match) throw new Error(`WRITING_STANDARD_LOCK_MISSING:${key}`);
    return match[1]!.trim();
  };
  if (value("version") !== "v0.1") throw new Error("WRITING_STANDARD_VERSION_UNSUPPORTED");
  const files = [];
  for (const kind of ["writing", "style"] as const) {
    const sourcePath = value(`${kind}_path`);
    if (!sourcePath.startsWith(".agent-project-control/standards/") || sourcePath.includes("..")) throw new Error("WRITING_STANDARD_SOURCE_PATH_INVALID");
    const bytes = await readFile(resolve(sourcePath));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== value(`${kind}_sha256`)) throw new Error(`WRITING_STANDARD_SOURCE_HASH_MISMATCH:${kind}`);
    const ids = kind === "writing" ? Array.from({ length: 29 }, (_, i) => String(i + 1)) : Array.from({ length: 15 }, (_, i) => `S${String(i).padStart(2, "0")}`);
    compileWritingStandard(bytes.toString("utf8"), ids);
    files.push({ path: `${kind}-standard-source.md`, sourcePath, sha256 });
  }
  const activationLock = JSON.parse(await readFile(resolve(".agent-project-control/standards/WRITING-ACTIVATION.lock.json"), "utf8")) as { schema: number; contract: string; files: Record<string, string> };
  if (activationLock.schema !== 1 || activationLock.contract !== "writing-reliability-1") throw new Error("WRITING_ACTIVATION_LOCK_INVALID");
  for (const [sourceName, path] of [["RULE-ACTIVATION-v0.1.md", "writing-activation-source.md"], ["WRITING-MINIMAL-EXAMPLES.md", "writing-minimal-examples.md"]] as const) {
    const sourcePath = `.agent-project-control/standards/${sourceName}`;
    const sha256 = createHash("sha256").update(await readFile(resolve(sourcePath))).digest("hex");
    if (activationLock.files[sourcePath] !== sha256) throw new Error(`WRITING_ACTIVATION_SOURCE_HASH_MISMATCH:${sourceName}`);
    files.push({ path, sourcePath, sha256 });
  }
  // Validate every source before replacing the distributable copies.
  for (const file of files) await copyFile(resolve(file.sourcePath), resolve("config/generation-harness", file.path));
  const aggregateSha256 = sha256Text(stableStringify(files.map(({ path, sha256 }) => ({ path, sha256 }))));
  const manifest = {
    schemaVersion: "1.0.0", standardVersion: "v0.1", policySnapshotId: `writing-policy:${aggregateSha256.slice(0, 16)}`,
    status: "approved", sourceCommit: "", frameworkRelease: "0.3.2", summary: "APCF Writing 1–29 / Style S00–S14 全文及 writing-reliability-1 提醒与案例；按发行锁校验，七段教学和逐式解释保持项目合同",
    files, aggregateSha256
  };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(resolve("config/writing-policy-manifest.json"), text);
  await writeFile(resolve("config/writing-policy-snapshots", `${manifest.policySnapshotId.split(":")[1]}.json`), text);
  console.log(JSON.stringify({ status: "synced", ...loadWritingStandards(), writing: undefined, style: undefined, activation: undefined, examples: undefined }));
}
