import type { TrashRecord } from "@course-os/contracts";
import { describe, expect, it } from "vitest";
import {
  canDirectlyDeleteTrashRecord,
  canDirectlyDeleteTrashRecords,
  canConfirmNativeErasePlan,
  latestRestorableTrashRecords,
  type TrashCapabilities
} from "./App.js";

function trashRecord(overrides: Partial<TrashRecord> = {}): TrashRecord {
  return {
    id: "trash-a-old",
    workspaceId: "workspace-a",
    nodeId: "node-a",
    nodeKind: "material",
    title: "材料 A",
    deletedAt: "2026-10-01T00:00:00.000Z",
    deletedBy: "test",
    restoreAvailable: true,
    readweaveNoteId: "note-a",
    ...overrides
  };
}

describe("trash panel row and direct-delete policy", () => {
  it("keeps only the newest restorable record for each workspace and object", () => {
    const rows = latestRestorableTrashRecords([
      trashRecord({ id: "old", deletedAt: "2026-10-01T00:00:00.000Z" }),
      trashRecord({ id: "latest-restorable", deletedAt: "2026-10-03T00:00:00.000Z" }),
      trashRecord({ id: "newer-unrestorable", deletedAt: "2026-10-04T00:00:00.000Z", restoreAvailable: false }),
      trashRecord({ id: "same-node-other-workspace", workspaceId: "workspace-b", deletedAt: "2026-10-02T00:00:00.000Z" }),
      trashRecord({ id: "unrestorable-only", nodeId: "node-b", restoreAvailable: false })
    ]);

    expect(rows.map((record) => record.id)).toEqual([
      "latest-restorable",
      "same-node-other-workspace"
    ]);
  });

  it("fails closed unless direct deletion is supported and the note ID is present", () => {
    const direct: TrashCapabilities = { directPermanentDelete: true, requiresNativeUi: false };
    const native: TrashCapabilities = { directPermanentDelete: false, requiresNativeUi: true };
    const restorable = trashRecord();

    expect(canDirectlyDeleteTrashRecord(undefined, restorable)).toBe(false);
    expect(canDirectlyDeleteTrashRecord({ directPermanentDelete: false, requiresNativeUi: false }, restorable)).toBe(false);
    expect(canDirectlyDeleteTrashRecord({ directPermanentDelete: true, requiresNativeUi: true }, restorable)).toBe(false);
    expect(canDirectlyDeleteTrashRecord(direct, { readweaveNoteId: undefined })).toBe(false);
    expect(canDirectlyDeleteTrashRecord(direct, restorable)).toBe(true);
    expect(canDirectlyDeleteTrashRecord(native, restorable)).toBe(false);
  });

  it("allows bulk direct deletion only when every visible row qualifies", () => {
    const direct: TrashCapabilities = { directPermanentDelete: true, requiresNativeUi: false };
    const rows = [trashRecord(), trashRecord({ id: "trash-b", nodeId: "node-b", readweaveNoteId: undefined })];

    expect(canDirectlyDeleteTrashRecords(direct, [])).toBe(false);
    expect(canDirectlyDeleteTrashRecords(direct, [rows[0]!])).toBe(true);
    expect(canDirectlyDeleteTrashRecords(direct, rows)).toBe(false);
    expect(canDirectlyDeleteTrashRecords(undefined, [rows[0]!])).toBe(false);
  });
});

describe("native erase preview and confirmation gates", () => {
  const nativeCapabilities: TrashCapabilities = { directPermanentDelete: false, requiresNativeUi: true, canConfirmNativeErase: true };
  const item = trashRecord({ snapshotHash: "snapshot-current" });
  const plan = {
    trashId: item.id,
    workspaceId: item.workspaceId,
    nodeId: item.nodeId,
    deletedAt: item.deletedAt,
    snapshotHash: "snapshot-current",
    rootNoteIds: ["root-a", "root-b"],
    noteIds: ["root-a", "root-b", "child-a"],
    nativeLinks: [
      { noteId: "root-a", url: "https://readweave.example/notes/root-a", title: "根笔记 A" },
      { noteId: "root-b", url: "https://readweave.example/notes/root-b", title: "根笔记 B" }
    ]
  };

  it("requires native confirmation capability and a complete matching server plan", () => {
    expect(canConfirmNativeErasePlan(undefined, item, plan)).toBe(false);
    expect(canConfirmNativeErasePlan({ ...nativeCapabilities, canConfirmNativeErase: false }, item, plan)).toBe(false);
    expect(canConfirmNativeErasePlan(nativeCapabilities, item, undefined)).toBe(false);
    expect(canConfirmNativeErasePlan(nativeCapabilities, item, plan)).toBe(true);
    expect(canConfirmNativeErasePlan(nativeCapabilities, { ...item, deletedAt: "2026-10-02T00:00:00.000Z" }, plan)).toBe(false);
    expect(canConfirmNativeErasePlan(nativeCapabilities, { ...item, snapshotHash: "snapshot-old" }, plan)).toBe(false);
    expect(canConfirmNativeErasePlan(nativeCapabilities, item, { ...plan, nativeLinks: plan.nativeLinks.slice(0, 1) })).toBe(false);
  });

  it("refuses links that are not safe server-provided web URLs", () => {
    expect(canConfirmNativeErasePlan(nativeCapabilities, item, {
      ...plan,
      nativeLinks: [{ ...plan.nativeLinks[0]!, url: "javascript:alert(1)" }, plan.nativeLinks[1]!]
    })).toBe(false);
  });
});
