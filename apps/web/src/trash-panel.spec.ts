import type { TrashRecord } from "@course-os/contracts";
import { describe, expect, it } from "vitest";
import {
  canDirectlyDeleteTrashRecord,
  canDirectlyDeleteTrashRecords,
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
