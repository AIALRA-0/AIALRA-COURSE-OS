/** Optional presentation preferences must never block reading or authoritative writes. */
export function readViewPreference(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function saveViewPreference(key: string, value: string): boolean {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
