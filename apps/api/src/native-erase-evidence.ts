import { open } from "node:fs/promises";
import type { TrashNativeErasePlan } from "@course-os/readweave-adapter";

interface NativeEraseEvent {
  at: string;
  host: string;
  method: string;
  uri: string;
  status: number;
}

/** Only a dedicated, read-only server log can attest native erasure. */
export function nativeEraseVerifiedByEvents(plan: TrashNativeErasePlan, events: unknown[], publicUrl: string): boolean {
  let host: string;
  try { host = new URL(publicUrl).hostname; } catch { return false; }
  const since = Date.parse(plan.deletedAt);
  if (!Number.isFinite(since) || !plan.rootNoteIds.length) return false;
  const roots = new Set(plan.rootNoteIds);
  const terminalTasks = new Set<string>();
  const matches: Array<{ root: string; task: string }> = [];
  for (const value of events) {
    if (!value || typeof value !== "object") continue;
    const event = value as Partial<NativeEraseEvent>;
    if (event.host !== host || event.method !== "DELETE" || ![200, 204].includes(event.status ?? 0)
      || typeof event.at !== "string" || typeof event.uri !== "string") continue;
    const at = Date.parse(event.at);
    if (!Number.isFinite(at) || at < since || at > Date.now() + 60_000) continue;
    let url: URL;
    try { url = new URL(event.uri, publicUrl); } catch { continue; }
    if (url.hostname !== host || !event.uri.startsWith("/")) continue;
    const route = /^\/api\/(notes|branches)\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (!route) continue;
    // The deployed native note handler returns no body (204); the branch
    // handler returns noteDeleted (200) after its eraseNotes=true branch.
    if ((route[1] === "notes" && event.status !== 204)
      || (route[1] === "branches" && event.status !== 200)) continue;
    const get = (key: string) => url.searchParams.getAll(key).length === 1 ? url.searchParams.get(key) : null;
    const task = get("taskId");
    if (!task || task.length > 256 || get("eraseNotes") !== "true") continue;
    const root = route[1] === "notes" ? route[2]!
      : Object.entries(plan.rootBranchIds ?? {}).find(([, ids]) => ids.includes(route[2]!))?.[0];
    if (root && roots.has(root)) {
      matches.push({ root, task });
      if (get("last") === "true") terminalTasks.add(task);
    }
  }
  return [...roots].every(root => matches.some(match => match.root === root && terminalTasks.has(match.task)));
}

/** Bounded scan; missing/rotated/unreadable proof never authorizes reconciliation. */
export function createNativeEraseVerifier(auditPath: string | undefined, publicUrl: string | undefined)
  : ((plan: TrashNativeErasePlan) => Promise<boolean>) | undefined {
  if (!auditPath || !publicUrl) return undefined;
  return async plan => {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(auditPath, "r");
      const stat = await file.stat();
      if (!stat.isFile()) return false;
      const start = Math.max(0, stat.size - 262_144);
      const bytes = Buffer.alloc(Math.min(stat.size, 262_144));
      const read = await file.read(bytes, 0, bytes.length, start);
      const lines = bytes.subarray(0, read.bytesRead).toString("utf8").split("\n");
      if (start) lines.shift();
      const events: unknown[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch { /* incomplete log lines cannot authorize erasure */ }
      }
      return nativeEraseVerifiedByEvents(plan, events, publicUrl);
    } catch { return false; }
    finally { await file?.close().catch(() => undefined); }
  };
}
