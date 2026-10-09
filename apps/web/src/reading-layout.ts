export const SOURCE_MIN_WIDTH = 220;
export const SOURCE_MAX_WIDTH = 1040;
export const SOURCE_DEFAULT_WIDTH = 480;
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 640;
export const READING_MIN_WIDTH = 360;

export function sourceWidthLimit(availableWidth: number): number {
  return Math.max(SOURCE_MIN_WIDTH, Math.min(SOURCE_MAX_WIDTH, availableWidth - READING_MIN_WIDTH - 16));
}

export function sidebarWidthLimit(viewportWidth: number): number {
  // Reserve the activity rail, shell gutters, splitter and both readable panels
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - 64 - 48 - 16 - SOURCE_MIN_WIDTH - READING_MIN_WIDTH));
}

export function normalizeSourceWidth(savedValue: string | null): number {
  const saved = Number(savedValue);
  // The former default was automatically stored on mount; migrate that default only
  if (!Number.isFinite(saved) || saved < SOURCE_MIN_WIDTH || saved === 272) return SOURCE_DEFAULT_WIDTH;
  return Math.min(SOURCE_MAX_WIDTH, Math.round(saved));
}
