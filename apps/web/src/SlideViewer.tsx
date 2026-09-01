import { useEffect, useRef, useState, type PointerEvent } from "react";

export interface ViewState {
  zoom: number;
  panX: number;
  panY: number;
}

export function SlideViewer({ imageUrl, title, value, onChange }: { imageUrl: string; title: string; value: ViewState; onChange: (value: ViewState) => void }) {
  const shellRef = useRef<HTMLElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState("");

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const nextZoom = clamp(value.zoom * (event.deltaY < 0 ? 1.12 : 0.89), 0.5, 5);
      onChange({ ...value, zoom: nextZoom });
    };
    frame.addEventListener("wheel", wheel, { passive: false });
    return () => frame.removeEventListener("wheel", wheel);
  }, [onChange, value]);

  useEffect(() => {
    const update = () => {
      const active = document.fullscreenElement === shellRef.current;
      setFullscreen(active);
      if (active) setFullscreenError("");
    };
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (value.zoom <= 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, panX: value.panX, panY: value.panY };
    setDragging(true);
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    onChange({ ...value, panX: dragRef.current.panX + event.clientX - dragRef.current.x, panY: dragRef.current.panY + event.clientY - dragRef.current.y });
  };
  const pointerUp = () => { dragRef.current = undefined; setDragging(false); };
  const toggleFullscreen = () => {
    setFullscreenError("");
    const operation = document.fullscreenElement ? document.exitFullscreen() : shellRef.current?.requestFullscreen();
    if (operation) void operation.catch(() => setFullscreenError("浏览器没有授予全屏权限，请允许当前页面进入全屏后重试"));
  };

  return (
    <section ref={shellRef} className={`slide-shell ${fullscreen ? "is-fullscreen" : ""}`} aria-label="原始课件页面">
      <div className="viewer-toolbar">
        <div className="zoom-group" aria-label="缩放控制">
          <button data-action="slide-zoom-out" onClick={() => onChange({ ...value, zoom: clamp(value.zoom - 0.25, 0.5, 5) })} aria-label="缩小">−</button>
          <output>{Math.round(value.zoom * 100)}%</output>
          <button data-action="slide-zoom-in" onClick={() => onChange({ ...value, zoom: clamp(value.zoom + 0.25, 0.5, 5) })} aria-label="放大">＋</button>
        </div>
        <button data-action="slide-reset" onClick={() => onChange({ zoom: 1, panX: 0, panY: 0 })}>复位</button>
        <button data-action={fullscreen ? "slide-exit-fullscreen" : "slide-fullscreen"} onClick={toggleFullscreen}>{fullscreen ? "退出全屏" : "全屏"}</button>
      </div>
      <div
        ref={frameRef}
        className={`slide-frame${dragging ? " dragging" : ""}`}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
        onDoubleClick={() => onChange({ zoom: 1, panX: 0, panY: 0 })}
      >
        <img
          src={imageUrl}
          alt={`${title} 原始课件截图`}
          draggable={false}
          style={{ transform: `translate(${value.panX}px, ${value.panY}px) scale(${value.zoom})` }}
        />
      </div>
      <p className={`viewer-help ${fullscreenError ? "viewer-error" : ""}`} role={fullscreenError ? "alert" : undefined}>{fullscreenError || "按住 Ctrl 或 Command 滚轮缩放，放大后拖动查看细节"}</p>
    </section>
  );
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
