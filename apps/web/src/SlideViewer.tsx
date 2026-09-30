import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { ImageResourceCache } from "./reading-prefetch.js";

export interface ViewState {
  zoom: number;
  panX: number;
  panY: number;
}

export function SlideViewer({ imageUrl, title, value, onChange, imageResources }: { imageUrl: string; title: string; value: ViewState; onChange: (value: ViewState) => void; imageResources?: ImageResourceCache }) {
  const shellRef = useRef<HTMLElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const valueRef = useRef(value);
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const [imageStatus, setImageStatus] = useState<{ url: string; attempt: number; state: "loading" | "ready" | "error" }>();
  const [imageAttemptVersion, setImageAttemptVersion] = useState(0);
  const imageAttemptRef = useRef({ url: imageUrl, attempt: 0 });
  if (imageAttemptRef.current.url !== imageUrl) imageAttemptRef.current = { url: imageUrl, attempt: 0 };
  const imageAttempt = imageAttemptRef.current.attempt;
  const currentImageStatus = imageStatus?.url === imageUrl && imageStatus.attempt === imageAttempt ? imageStatus : undefined;
  const imageSource = imageResources
    ? currentImageStatus?.state === "ready" ? imageUrl : undefined
    : currentImageStatus?.state === "error" ? undefined : imageUrl;
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState("");
  valueRef.current = value;

  useEffect(() => {
    if (!imageResources || !imageUrl) return;
    let active = true;
    const attempt = imageAttempt;
    setImageStatus({ url: imageUrl, attempt, state: "loading" });
    const pending = attempt > 0 ? imageResources.retry(imageUrl, "high") : imageResources.load(imageUrl, "high");
    void pending.then(() => {
      if (active) setImageStatus((current) => current?.url === imageUrl && current.attempt === attempt ? { url: imageUrl, attempt, state: "ready" } : current);
    }).catch(() => {
      if (active) setImageStatus((current) => current?.url === imageUrl && current.attempt === attempt ? { url: imageUrl, attempt, state: "error" } : current);
    });
    return () => { active = false; };
  }, [imageResources, imageUrl, imageAttempt, imageAttemptVersion]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const current = valueRef.current;
      const nextZoom = clamp(current.zoom * (event.deltaY < 0 ? 1.12 : 0.89), 0.5, 5);
      onChange({ ...current, zoom: nextZoom });
    };
    frame.addEventListener("wheel", wheel, { passive: false });
    return () => frame.removeEventListener("wheel", wheel);
  }, [onChange]);

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
    if (event.target instanceof Element && event.target.closest("button")) return;
    if (valueRef.current.zoom <= 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, panX: valueRef.current.panX, panY: valueRef.current.panY };
    setDragging(true);
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    onChange({ ...valueRef.current, panX: dragRef.current.panX + event.clientX - dragRef.current.x, panY: dragRef.current.panY + event.clientY - dragRef.current.y });
  };
  const pointerUp = () => { dragRef.current = undefined; setDragging(false); };
  const toggleFullscreen = () => {
    setFullscreenError("");
    const operation = document.fullscreenElement ? document.exitFullscreen() : shellRef.current?.requestFullscreen();
    if (operation) void operation.catch(() => setFullscreenError("浏览器没有授予全屏权限，请允许当前页面进入全屏后重试"));
  };
  const retryImage = () => {
    imageAttemptRef.current = { url: imageUrl, attempt: imageAttempt + 1 };
    setImageStatus({ url: imageUrl, attempt: imageAttempt + 1, state: "loading" });
    setImageAttemptVersion((current) => current + 1);
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
        {(!currentImageStatus || currentImageStatus.state === "loading") && <span className="slide-image-status" role="status">正在载入本页原图</span>}
        {currentImageStatus?.state === "error" && <span className="slide-image-status" role="alert">原图载入失败<button type="button" data-action="slide-image-retry" onClick={retryImage} style={{ pointerEvents: "auto" }}>重试原图</button></span>}
        <img
          key={`${imageUrl}:${imageAttempt}`}
          src={imageSource}
          alt={`${title} 原始课件截图`}
          draggable={false}
          fetchPriority={imageResources ? "high" : undefined}
          onLoad={() => setImageStatus((current) => current && (current.url !== imageUrl || current.attempt !== imageAttempt) ? current : { url: imageUrl, attempt: imageAttempt, state: "ready" })}
          onError={() => setImageStatus((current) => current && (current.url !== imageUrl || current.attempt !== imageAttempt) ? current : { url: imageUrl, attempt: imageAttempt, state: "error" })}
          style={{ visibility: currentImageStatus?.state === "ready" ? "visible" : "hidden", transform: `translate(${value.panX}px, ${value.panY}px) scale(${value.zoom})` }}
        />
      </div>
      <p className={`viewer-help ${fullscreenError ? "viewer-error" : ""}`} role={fullscreenError ? "alert" : undefined}>{fullscreenError || "按住 Ctrl 或 Command 滚轮缩放，放大后拖动查看细节"}</p>
    </section>
  );
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
