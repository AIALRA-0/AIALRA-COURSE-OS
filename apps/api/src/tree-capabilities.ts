import type { CourseTreeNode, CourseTreeNodeKind } from "@course-os/contracts";

export function treeCapabilities(kind: CourseTreeNodeKind): CourseTreeNode["capabilities"] {
  if (kind === "workspace") return ["create_course", "create", "properties"];
  if (kind === "course") return ["import_material", "rename", "duplicate", "move", "reorder", "trash", "open_readweave", "history", "properties"];
  if (kind === "module") return ["import_material", "rename", "duplicate", "move", "reorder", "trash", "open_studio", "open_readweave", "history", "properties"];
  if (kind === "material") return ["rename", "duplicate", "move", "reorder", "trash", "open_studio", "open_readweave", "history", "properties"];
  if (kind === "page") return ["open_studio", "open_readweave", "properties"];
  if (kind === "release") return ["open_readweave", "history", "properties"];
  if (kind === "section") return ["history", "properties"];
  if (kind === "trash") return ["restore"];
  return ["properties"];
}
