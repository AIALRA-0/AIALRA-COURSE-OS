import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OperationalStore } from "./store.js";
import type { PlannedCheckpoint } from "./planned-teaching.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("private generation checkpoint", () => {
  it("survives reopening the operational store without entering the public job record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "course-os-checkpoint-"));
    directories.push(directory);
    const path = join(directory, "operations.json");
    const checkpoint: PlannedCheckpoint = {
      fingerprint: "same-source-policy-harness", content: { chapterBridgeMarkdown: "已验证的前情" },
      completedPhases: ["opening"], trace: { version: 1, plan: {} as PlannedCheckpoint["trace"]["plan"], phases: [] }
    };
    await new OperationalStore(path).mutate(state => { state.generationCheckpoints["job:page"] = checkpoint; });
    const reopened = await new OperationalStore(path).read();
    expect(reopened.generationCheckpoints["job:page"]).toEqual(checkpoint);
    expect(JSON.stringify(reopened.jobs)).not.toContain("已验证的前情");
  });
});
