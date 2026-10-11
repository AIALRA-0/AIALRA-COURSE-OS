export function workerDispatchHeaders(workerToken: string, workspaceId: string): Record<string, string> {
  return {
    "X-Course-Worker-Token": workerToken,
    "X-Workspace-Id": workspaceId || "personal"
  };
}


export async function dispatchGenerationJob(
  apiBaseUrl: string, workerToken: string, jobId: string, workspaceId: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<{ ok: boolean; status?: number; error?: string; causeCode?: string }> {
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${apiBaseUrl}/api/internal/worker/jobs/${encodeURIComponent(jobId)}/run`, {
        method: "POST",
        headers: workerDispatchHeaders(workerToken, workspaceId),
        // This bounds only the HTTP acknowledgement, not generation execution.
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000)
      });
    // The route schedules work and acknowledges immediately. Its payload is
    // unused; explicitly release even a stalled response body before polling.
    await response.body?.cancel();
    return { ok: response.ok, status: response.status };
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    return {
      ok: false,
      error: error instanceof Error ? error.name : "DispatchError",
      causeCode: cause && typeof cause === "object" && "code" in cause
        && typeof cause.code === "string" ? cause.code : undefined
    };
  }
}
