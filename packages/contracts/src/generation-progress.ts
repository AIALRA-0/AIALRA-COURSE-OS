type UnknownRecord = Record<string, unknown>;
function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}
function readNumber(source: UnknownRecord, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

/** Aggregate a scoped, persisted event history, counting pages rather than calls or attempts. */
export function summarizeImportStageEvents(events: readonly unknown[], pageIds: readonly string[]): UnknownRecord {
  const validIds = new Set(pageIds);
  const states = new Map<string, Map<string, { state: string; at?: string }>>();
  const starts = new Map<string, string>();
  const retries = new Set<string>();
  const record = (stage: string, pageId: string, state: string, at?: string) => {
    const pages = states.get(stage) ?? new Map<string, { state: string; at?: string }>();
    pages.set(pageId, { state, at });
    states.set(stage, pages);
  };
  const ordered = events.map(asRecord).filter((event): event is UnknownRecord => Boolean(event))
    .sort((left, right) => (readNumber(left, ["id"]) ?? 0) - (readNumber(right, ["id"]) ?? 0));
  for (const event of ordered) {
    const payload = asRecord(event.payload);
    const pageId = payload?.pageId;
    if (typeof pageId !== "string" || !validIds.has(pageId)) continue;
    const at = typeof event.occurredAt === "string" && Number.isFinite(Date.parse(event.occurredAt)) ? event.occurredAt : undefined;
    const type = event.type;
    if (type === "generation.page.core_saved") {
      record("core_save", pageId, "completed", at);
      record("generation", pageId, "completed", at);
      if (payload?.bridgeCompleted === true) record("bridge", pageId, "completed", at);
      retries.delete(pageId);
    }
    else if (type === "generation.page.storage_retry") {
      if (payload?.reusedTeaching === true) record("generation", pageId, "completed", at);
      // A later bridge/cost retry must not undo the earlier core-save receipt.
      if (states.get("core_save")?.get(pageId)?.state !== "completed") { record("core_save", pageId, "started", at); retries.add(pageId); }
    } else if (type === "generation.page.completed") {
      record("generation", pageId, "completed", at);
      record("core_save", pageId, "completed", at);
      if (payload?.bridgeCompleted === true) record("bridge", pageId, "completed", at);
      retries.delete(pageId);
    } else if (type === "generation.page.failed") {
      const issue = typeof payload?.issue === "string" ? payload.issue : "";
      const stage = states.get("core_save")?.get(pageId)?.state === "completed" && states.get("bridge")?.has(pageId) ? "bridge"
        : issue.startsWith("READWEAVE_") ? "core_save" : "generation";
      if (states.get(stage)?.get(pageId)?.state !== "completed" || stage === "generation") record(stage, pageId, "failed", at);
      retries.delete(pageId);
    } else if (typeof type === "string" && type.startsWith("generation.stage.")) {
      const phase = payload?.phase;
      const stage = phase === "bridge" ? "bridge"
        : phase === "page_understanding" || payload?.activity === "visual_understanding" ? "vision"
          : (payload?.stage === "teach" || payload?.stage === "review") && !phase ? "generation" : undefined;
      if (!stage) continue;
      const status = type.slice("generation.stage.".length);
      if (!["started", "completed", "skipped", "failed"].includes(status)) continue;
      // A model response for the bridge is not the bridge's authoritative save.
      if (status === "started" && at && !starts.has(stage)) starts.set(stage, at);
      if (stage === "bridge" && status === "completed" && states.get("bridge")?.get(pageId)?.state === "completed") continue;
      record(stage, pageId, stage === "bridge" && status === "completed" ? "started" : payload?.incomplete === true ? "failed" : status, at);
    }
  }
  const output: UnknownRecord = {};
  for (const [stage, pages] of states) {
    const values = [...pages.values()];
    const count = (state: string) => values.filter(value => value.state === state).length;
    const running = count("started");
    const failed = count("failed");
    const completed = count("completed");
    const times = values.flatMap(value => value.at ? [value.at] : []).sort();
    output[stage] = { completed, total: validIds.size, running, failed, skipped: count("skipped"),
      state: running ? "running" : failed ? "failed" : completed === validIds.size ? "completed" : "unknown",
      startedAt: starts.get(stage), endedAt: completed === validIds.size ? times.at(-1) : undefined, updatedAt: times.at(-1) };
  }
  const generatedPages = states.get("generation");
  const savedPages = states.get("core_save");
  if (generatedPages) {
    const pendingSave = [...generatedPages].filter(([id, value]) => value.state === "completed" && savedPages?.get(id)?.state !== "completed").length;
    output.core_save = { ...(asRecord(output.core_save) ?? { completed: 0, total: validIds.size, state: "unknown" }), pendingSave, storageRetrying: retries.size };
  }
  if (retries.size && !generatedPages) output.core_save = { ...asRecord(output.core_save), storageRetrying: retries.size };
  return output;
}

/** Each row describes its own work; rows can run together and are never added into a percentage. */
