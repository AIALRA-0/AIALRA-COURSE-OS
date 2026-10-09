import { useEffect, useRef, type PointerEvent } from "react";

export function PaneResizeHandle({ value, onChange, reversed = false }: { value: number; onChange: (value: number) => void; reversed?: boolean }) {
  const cleanup = useRef<() => void>(() => undefined);
  useEffect(() => () => cleanup.current(), []);
  const change = (next: number) => onChange(Math.max(25, Math.min(65, next)));
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const container = event.currentTarget.parentElement;
    if (!container) return;
    event.preventDefault(); cleanup.current();
    const width = container.getBoundingClientRect().width, startX = event.clientX, original = value;
    const previousCursor = document.body.style.cursor, previousSelect = document.body.style.userSelect;
    const move = (next: globalThis.PointerEvent) => change(original + (next.clientX - startX) / width * 100 * (reversed ? -1 : 1));
    const finish = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel); window.removeEventListener("keydown", key, true);
      document.body.style.cursor = previousCursor; document.body.style.userSelect = previousSelect;
      cleanup.current = () => undefined;
    };
    const cancel = () => { change(original); finish(); };
    const key = (next: KeyboardEvent) => { if (next.key === "Escape") { next.preventDefault(); next.stopPropagation(); cancel(); } };
    document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true }); window.addEventListener("keydown", key, true);
    cleanup.current = finish;
  };
  return <div className="reading-splitter" role="separator" tabIndex={0} aria-label="调整原图与讲解宽度"
    aria-orientation="vertical" aria-valuemin={25} aria-valuemax={65} aria-valuenow={Math.round(value)}
    aria-valuetext={`原图宽度 ${Math.round(value)}%`} onPointerDown={start} onKeyDown={event => {
      const direction = reversed ? -1 : 1;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); change(value + (event.key === "ArrowLeft" ? -2 : 2) * direction); }
      else if (event.key === "Home" || event.key === "End") { event.preventDefault(); change(event.key === "Home" ? 25 : 65); }
    }}><span /></div>;
}
