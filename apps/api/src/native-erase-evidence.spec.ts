import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TrashNativeErasePlan } from "@course-os/readweave-adapter";
import { createNativeEraseVerifier, nativeEraseVerifiedByEvents } from "./native-erase-evidence.js";

const host = "notes.example.test";
const plan = { trashId: "trash-a", workspaceId: "test", nodeId: "material-a", deletedAt: "2026-01-01T00:00:00Z",
  snapshotHash: "hash-a", rootNoteIds: ["noteA", "releaseA"], noteIds: ["noteA", "childA", "releaseA"],
  rootBranchIds: { noteA: ["branchA"] }, nativeLinks: [] } as TrashNativeErasePlan;
const event = (id: string, overrides = {}) => ({ at: "2026-01-02T00:00:00Z", host, method: "DELETE", status: 204,
  uri: `/api/notes/${id}?taskId=task-${id}&eraseNotes=true&last=true`, ...overrides });
const verify = (events: unknown[]) => nativeEraseVerifiedByEvents(plan, events, `https://${host}`);

describe("native erase authority evidence", () => {
  it("requires affirmative successful erasure of every scoped root", () => {
    expect(verify([event("noteA")])).toBe(false);
    expect(verify([event("noteA"), event("releaseA")])).toBe(true);
  });
  it("never treats 404, soft delete, ETAPI or an untrusted host as proof", () => {
    for (const changes of [{ status: 404 }, { status: 200 }, { host: "foreign.example.test" },
      { uri: "/etapi/notes/noteA?taskId=x&eraseNotes=true&last=true" },
      { uri: "/api/notes/noteA?taskId=x&eraseNotes=false&last=true" }]) {
      expect(verify([event("noteA", changes), event("releaseA")])).toBe(false);
    }
  });
  it("rejects replay from before the current deletion and ambiguous query parameters", () => {
    expect(verify([event("noteA", { at: "2025-12-31T00:00:00Z" }), event("releaseA")])).toBe(false);
    expect(verify([event("noteA", { uri: "/api/notes/noteA?taskId=x&eraseNotes=false&eraseNotes=true&last=true" }), event("releaseA")])).toBe(false);
  });
  it("requires the same native task's terminal success", () => {
    const pending = event("noteA", { uri: "/api/notes/noteA?taskId=group&eraseNotes=true&last=false" });
    expect(verify([pending, event("releaseA")])).toBe(false);
    expect(verify([pending, event("releaseA", { uri: "/api/notes/releaseA?taskId=group&eraseNotes=true&last=true" })])).toBe(true);
    expect(verify([pending, event("releaseA"), event("foreignNote", {
      uri: "/api/notes/foreignNote?taskId=group&eraseNotes=true&last=true"
    })])).toBe(false);
  });
  it("accepts only the branch frozen by the scoped preflight", () => {
    expect(verify([event("noteA", { status: 200, uri: "/api/branches/branchA?taskId=x&eraseNotes=true&last=true" }), event("releaseA")])).toBe(true);
    expect(verify([event("noteA", { status: 204, uri: "/api/branches/branchA?taskId=x&eraseNotes=true&last=true" }), event("releaseA")])).toBe(false);
    expect(verify([event("noteA", { status: 200, uri: "/api/branches/foreignBranch?taskId=x&eraseNotes=true&last=true" }), event("releaseA")])).toBe(false);
  });
  it("fails closed for missing proof and safely reads complete log lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "course-native-erase-"));
    try {
      const file = join(dir, "native.jsonl");
      const check = createNativeEraseVerifier(file, `https://${host}`)!;
      expect(await check(plan)).toBe(false);
      await writeFile(file, [event("noteA"), event("releaseA")].map(row => JSON.stringify(row)).join("\n") + "\n{broken");
      expect(await check(plan)).toBe(true);
      expect(createNativeEraseVerifier(undefined, `https://${host}`)).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
