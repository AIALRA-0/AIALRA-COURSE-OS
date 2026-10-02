import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { inspectPublicFile, scanHistoryBlobs, scanPublicFiles, validatePublicContract } from "./lib/verify-public.js";

const privateDomain = ["review", "aialra", "online"].join(".");
const requiredFiles = [
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

describe("public repository verification", () => {
  it("finds a private marker after the former one megabyte skip point", async () => {
    const bytes = Buffer.from(`${"x ".repeat(550_000)}\n${privateDomain}`);
    const issues = await scanPublicFiles(["docs/large.md"], async () => bytes);
    expect(issues).toContainEqual({ path: "docs/large.md", code: "PRIVATE_DOMAIN" });
  });

  it("scans the verifier's current path instead of exempting it", async () => {
    const issues = await scanPublicFiles(["scripts/verify-public.ts"], async () => Buffer.from(privateDomain));
    expect(issues).toContainEqual({ path: "scripts/verify-public.ts", code: "PRIVATE_DOMAIN" });

    const source = await readFile(new URL("./verify-public.ts", import.meta.url));
    expect(inspectPublicFile("scripts/verify-public.ts", source)).toEqual([]);
    const helper = await readFile(new URL("./lib/verify-public.ts", import.meta.url));
    expect(inspectPublicFile("scripts/lib/verify-public.ts", helper)).toEqual([]);
  });

  it("flags an actual workspace path while allowing the path text by itself", () => {
    const workspacePath = ["F:", "AIALRA Codex Workspace", "course-os"].join("\\");
    expect(inspectPublicFile("docs/config.md", Buffer.from(workspacePath)))
      .toContainEqual({ path: "docs/config.md", code: "PRIVATE_WORKSPACE_PATH" });
    expect(inspectPublicFile("docs/history.md", Buffer.from("AIALRA Codex Workspace"))).toEqual([]);
  });

  it("uses the package version for README checks without a private acceptance count", () => {
    const version = "9.8.7";
    const readmes = new Map([
      ["README.md", `Public contract ${version}`],
      ["README.en.md", `Public contract ${version}`]
    ]);
    expect(validatePublicContract(requiredFiles, JSON.stringify({ version }), readmes)).toEqual([]);
    expect(validatePublicContract(requiredFiles, JSON.stringify({ version }), new Map([["README.md", `Public contract ${version}`]])))
      .toContainEqual({ path: "README.en.md", code: "README_UNREADABLE" });
  });

  it("reports listed files it cannot read", async () => {
    const issues = await scanPublicFiles(["docs/unavailable.md"], async () => {
      throw new Error("fixture read failure");
    });
    expect(issues).toContainEqual({ path: "docs/unavailable.md", code: "PUBLIC_FILE_UNREADABLE" });
  });

  it("does not report a clean result when a reachable historical blob contains a finding", () => {
    const historyFinding = scanHistoryBlobs([{ path: "docs/removed.md", bytes: Buffer.from(privateDomain) }]);
    expect(historyFinding).toContainEqual({ path: "docs/removed.md", code: "HISTORY_PRIVATE_DOMAIN" });
    expect(historyFinding[0]).toEqual({ path: "docs/removed.md", code: "HISTORY_PRIVATE_DOMAIN" });
    expect(scanHistoryBlobs([{ path: "docs/clean.md", bytes: Buffer.from("ordinary public text") }])).toEqual([]);
    expect(scanHistoryBlobs([])).toContainEqual({ path: "<history>", code: "HISTORY_SCAN_UNCOVERED" });
  });
});
