import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

describe("versioned API contracts", () => {
  it("keeps browser and ReadWeave paths in separate documents", async () => {
    const browser = parse(await readFile(resolve("packages/contracts/openapi/browser-api.yaml"), "utf8"));
    const readweave = parse(await readFile(resolve("packages/contracts/openapi/readweave-course-api.yaml"), "utf8"));
    expect(browser.info.version).toBe("2.4.0");
    expect(readweave.info.version).toBe("2.4.0");
    expect(browser.servers[0].url).toBe("/api/v1");
    expect(readweave.servers[0].url).toBe("/api/course/v1");
    expect(Object.keys(browser.paths).some((path) => path.includes("research-archives"))).toBe(false);
    expect(Object.keys(readweave.paths).some((path) => path.includes("generation-jobs"))).toBe(false);
  });

  it("validates a release manifest with strict additional-property rejection", async () => {
    const schema = JSON.parse(await readFile(resolve("packages/contracts/schemas/release-manifest.schema.json"), "utf8"));
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const sample = {
      id: "manifest-1",
      schemaVersion: "2.1.0",
      courseReleaseId: "release-1",
      sourceHashes: ["a".repeat(64)],
      pageHashes: ["b".repeat(64)],
      explanationHashes: ["c".repeat(64)],
      assessmentHashes: ["d".repeat(64)],
      writingPolicySnapshotId: "policy-1",
      modelRoutes: ["deterministic"],
      qualityHarnessVersion: "quality-v1",
      costInputs: [],
      createdAt: "2026-08-28T12:00:00.000Z"
    };
    expect(validate(sample)).toBe(true);
    expect(validate({ ...sample, untracked: true })).toBe(false);
  });
});
