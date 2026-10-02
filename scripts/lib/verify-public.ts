import { extname } from "node:path";

export type PublicIssue = { path: string; code: string };

const forbiddenExtensions = new Set([".pdf", ".ppt", ".pptx", ".doc", ".docx", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".sqlite", ".db", ".log"]);
const forbiddenRoots = ["var/", "deploy/vps/data/", "deploy/vps/data-next/", "deploy/vps/secrets/", "deploy/vps/secrets-next/"];
const workspacePathPattern = new RegExp(
  `(?:[a-z]:[\\\\/]|/(?:[^/\\s]+/)+)${["AIALRA", "Codex", "Workspace"].join("\\s+")}(?:[\\\\/]|$)`,
  "i"
);
const contentRules = [
  { code: "PRIVATE_DOMAIN", pattern: /\b(?:[a-z0-9-]+\.)+aialra\.online\b/i },
  { code: "PRIVATE_VPS_PATH", pattern: /\/srv\/aialra\b/i },
  { code: "PRIVATE_WINDOWS_PROFILE", pattern: /[a-z]:[\\/]Users[\\/][^\\/\s]+/i },
  { code: "PRIVATE_WORKSPACE_PATH", pattern: workspacePathPattern },
  { code: "PRIVATE_KEY", pattern: /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/ },
  { code: "GITHUB_TOKEN", pattern: /(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
  { code: "CLOUD_ACCESS_KEY", pattern: /AKIA[0-9A-Z]{16}/ }
];

const requiredPublicFiles = [
  "package.json",
  "README.md",
  "README.en.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "SECURITY.md",
  "deploy/vps/compose.yaml",
  "deploy/vps/nginx.conf.template",
  "config/writing-policy-manifest.json"
];

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function issue(path: string, code: string): PublicIssue {
  return { path: normalizePath(path), code };
}

export function inspectPublicFile(path: string, bytes: Uint8Array): PublicIssue[] {
  const normalized = normalizePath(path);
  const issues: PublicIssue[] = [];

  if (forbiddenRoots.some((root) => normalized.startsWith(root))) issues.push(issue(normalized, "PRIVATE_RUNTIME_PATH"));
  if (forbiddenExtensions.has(extname(normalized).toLowerCase())) issues.push(issue(normalized, "FORBIDDEN_BINARY_OR_RUNTIME_FILE"));
  if (bytes.byteLength > 2_000_000) issues.push(issue(normalized, "PUBLIC_FILE_TOO_LARGE"));

  let text: string;
  let binary = bytes.includes(0);
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    binary = true;
    text = new TextDecoder("utf-8").decode(bytes);
  }
  if (binary) issues.push(issue(normalized, "UNEXPECTED_BINARY_CONTENT"));

  for (const rule of contentRules) if (rule.pattern.test(text)) issues.push(issue(normalized, rule.code));
  return issues;
}

export async function scanPublicFiles(
  paths: string[],
  readBytes: (path: string) => Promise<Uint8Array>
): Promise<PublicIssue[]> {
  const normalizedPaths = paths.map(normalizePath);
  const issues: PublicIssue[] = [];
  const readmes = new Map<string, string>();
  let packageManifest: string | undefined;

  for (const path of normalizedPaths) {
    try {
      const bytes = await readBytes(path);
      issues.push(...inspectPublicFile(path, bytes));
      if (path === "package.json" || path === "README.md" || path === "README.en.md") {
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if (path === "package.json") packageManifest = text;
          else readmes.set(path, text);
        } catch {
          // The file-level scan already records undecodable content.
        }
      }
    } catch {
      issues.push(issue(path, "PUBLIC_FILE_UNREADABLE"));
    }
  }

  issues.push(...validatePublicContract(normalizedPaths, packageManifest, readmes));
  return deduplicateIssues(issues);
}

export function validatePublicContract(
  paths: string[],
  packageManifest: string | undefined,
  readmes: ReadonlyMap<string, string>
): PublicIssue[] {
  const normalizedPaths = new Set(paths.map(normalizePath));
  const issues: PublicIssue[] = [];
  for (const required of requiredPublicFiles) {
    if (!normalizedPaths.has(required)) issues.push(issue(required, "REQUIRED_PUBLIC_FILE_MISSING"));
  }

  let version: string | undefined;
  if (packageManifest !== undefined) {
    try {
      const parsed: unknown = JSON.parse(packageManifest);
      if (parsed && typeof parsed === "object" && "version" in parsed && typeof parsed.version === "string" && parsed.version.trim()) {
        version = parsed.version.trim();
      }
    } catch {
      // Report the same safe metadata diagnostic for malformed JSON and missing version fields.
    }
  }
  if (!version) issues.push(issue("package.json", "PACKAGE_VERSION_UNAVAILABLE"));

  if (version) {
    const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const versionPattern = new RegExp(`(^|[^0-9A-Za-z])${escapedVersion}([^0-9A-Za-z]|$)`);
    for (const path of ["README.md", "README.en.md"]) {
      const readme = readmes.get(path);
      if (readme === undefined) {
        if (normalizedPaths.has(path)) issues.push(issue(path, "README_UNREADABLE"));
        continue;
      }
      if (!versionPattern.test(readme)) issues.push(issue(path, "README_VERSION_MISSING"));
    }
  }
  return issues;
}

export function scanHistoryBlobs(blobs: Iterable<{ path: string; bytes: Uint8Array }>): PublicIssue[] {
  const issues: PublicIssue[] = [];
  let coveredBlob = false;
  for (const blob of blobs) {
    coveredBlob = true;
    issues.push(...inspectPublicFile(blob.path, blob.bytes).map(({ path, code }) => issue(path, `HISTORY_${code}`)));
  }
  if (!coveredBlob) issues.push(issue("<history>", "HISTORY_SCAN_UNCOVERED"));
  return deduplicateIssues(issues);
}

export function historyScanFailure(): PublicIssue {
  return issue("<history>", "HISTORY_SCAN_UNAVAILABLE");
}

function deduplicateIssues(issues: PublicIssue[]): PublicIssue[] {
  const seen = new Set<string>();
  return issues.filter(({ path, code }) => {
    const key = `${path}\0${code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
