export function workerDispatchHeaders(workerToken: string, workspaceId: string): Record<string, string> {
  return {
    "X-Course-Worker-Token": workerToken,
    "X-Workspace-Id": workspaceId || "personal"
  };
}
