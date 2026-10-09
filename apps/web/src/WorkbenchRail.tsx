import { Icon, type IconName } from "./Icon.js";
import { useEffect, useState } from "react";

function RailButton({ name, label, handler, selected }: { name: IconName; label: string; handler: () => void; selected?: boolean }) {
  const [hint, setHint] = useState(false);
  return <button type="button" className="workbench-rail-button" aria-label={label} aria-pressed={selected}
    onMouseEnter={() => setHint(true)} onMouseLeave={() => setHint(false)} onFocus={() => setHint(true)} onBlur={() => setHint(false)}
    onKeyDown={event => { if (event.key === "Escape" && hint) { event.preventDefault(); event.stopPropagation(); setHint(false); } }}
    onClick={() => { setHint(false); handler(); }}><Icon name={name} />{hint && <span className="rail-tooltip" role="tooltip">{label}</span>}</button>;
}

export function WorkbenchRail({ collapsed, drawerOpen = false, onCourses, onSearch, onTrash, onImport, onSettings, onAccount, panel }: {
  collapsed: boolean; drawerOpen?: boolean; panel: string | null; onCourses: () => void; onSearch: () => void;
  onTrash: () => void; onImport: () => void; onSettings: () => void; onAccount: () => void;
}) {
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && window.innerWidth <= 900);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 900px)");
    const update = () => setCompact(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const coursesVisible = compact ? drawerOpen : !collapsed;
  const action = (name: IconName, label: string, handler: () => void, selected?: boolean) =>
    <RailButton name={name} label={label} handler={handler} selected={selected} />;
  return <nav className="workbench-rail" aria-label="工作区工具">
    <div className="workbench-rail-group">
      {action("book", coursesVisible ? "收起课程目录" : "展开课程目录", onCourses, coursesVisible && panel !== "search" && panel !== "trash")}
      {action("search", "全局课程搜索", onSearch, panel === "search")}
      {action("trash", "回收站", onTrash, panel === "trash")}
      <span className="rail-divider" />
      {action("upload", "导入材料", onImport)}
    </div>
    <div className="workbench-rail-group rail-utilities">
      {action("settings", "工作区设置", onSettings)}
      {action("user", "账户", onAccount)}
    </div>
  </nav>;
}
