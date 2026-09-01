import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";

const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\0").filter(Boolean);
const issues: Array<{ path: string; code: string }> = [];
const forbiddenExtensions = new Set([".pdf", ".ppt", ".pptx", ".doc", ".docx", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".sqlite", ".db", ".log"]);
const allowedBinaryLike = new Set<string>();
const forbiddenRoots = ["var/", "deploy/vps/data/", "deploy/vps/data-next/", "deploy/vps/secrets/", "deploy/vps/secrets-next/"];
const contentRules = [
  { code: "PRIVATE_DOMAIN", pattern: /(?:[a-z0-9-]+\.)+aialra\.online/i },
  { code: "PRIVATE_VPS_PATH", pattern: /\/srv\/aialra\b/i },
  { code: "PRIVATE_WINDOWS_PROFILE", pattern: /[a-z]:[\\/]Users[\\/][^\\/\s]+/i },
  { code: "PRIVATE_WORKSPACE_PATH", pattern: /AIALRA Codex Workspace/i },
  { code: "PRIVATE_KEY", pattern: /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/ },
  { code: "GITHUB_TOKEN", pattern: /(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
  { code: "CLOUD_ACCESS_KEY", pattern: /AKIA[0-9A-Z]{16}/ }
];

for (const path of files) {
  const normalized = path.replaceAll("\\", "/");
  if (forbiddenRoots.some((root) => normalized.startsWith(root))) issues.push({ path: normalized, code: "PRIVATE_RUNTIME_PATH" });
  const extension = extname(normalized).toLowerCase();
  if (forbiddenExtensions.has(extension) && !allowedBinaryLike.has(normalized)) issues.push({ path: normalized, code: "FORBIDDEN_BINARY_OR_RUNTIME_FILE" });
  let info;
  try {
    info = await stat(resolve(normalized));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
    throw error;
  }
  if (info.size > 2_000_000) issues.push({ path: normalized, code: "PUBLIC_FILE_TOO_LARGE" });
  if (normalized === "scripts/verify-public.ts" || info.size > 1_000_000) continue;
  const bytes = await readFile(resolve(normalized));
  if (bytes.includes(0)) {
    issues.push({ path: normalized, code: "UNEXPECTED_BINARY_CONTENT" });
    continue;
  }
  const text = bytes.toString("utf8");
  for (const rule of contentRules) if (rule.pattern.test(text)) issues.push({ path: normalized, code: rule.code });
}

const readme = await readFile(resolve("README.md"), "utf8");
const englishReadme = await readFile(resolve("README.en.md"), "utf8");
for (const [path, text] of [["README.md", readme], ["README.en.md", englishReadme]] as const) {
  if (!text.includes("2.4.0")) issues.push({ path, code: "README_VERSION_MISSING" });
  if (!text.includes("72")) issues.push({ path, code: "README_PRIVATE_ACCEPTANCE_SCOPE_MISSING" });
}
for (const required of ["LICENSE", "SECURITY.md", "deploy/vps/compose.yaml", "deploy/vps/nginx.conf.template", "config/writing-policy-manifest.json"]) {
  if (!files.includes(required)) issues.push({ path: required, code: "REQUIRED_PUBLIC_FILE_MISSING" });
}

process.stdout.write(`${JSON.stringify({ status: issues.length ? "failed" : "passed", fileCount: files.length, issueCount: issues.length, issues }, null, 2)}\n`);
if (issues.length) process.exitCode = 1;
