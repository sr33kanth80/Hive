import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export type AgentFileEditStatus = "inProgress" | "completed" | "failed" | "declined";

export interface AgentFileEdit {
  /** Workspace-relative path, as the provider reported it. */
  readonly path: string;
  readonly status: AgentFileEditStatus;
  /** Set when a subagent made the edit rather than the thread's own agent. */
  readonly agentId: string | null;
  /** Lets a caller tell a new edit from a re-render of the same one. */
  readonly activityId: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstFilePath(payload: Record<string, unknown>): string | null {
  const files = asRecord(payload.data)?.files;
  if (!Array.isArray(files)) return null;
  for (const entry of files) {
    const path = asRecord(entry)?.path;
    if (typeof path === "string" && path.trim().length > 0) {
      return path;
    }
  }
  return null;
}

/**
 * Providers disagree on the in-progress spelling, and the payload projection
 * rewrites a completed tool to `failed` or `declined` when the item itself
 * ended that way. Anything unrecognized is still in flight.
 */
function editStatus(value: unknown): AgentFileEditStatus {
  switch (value) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "declined":
      return "declined";
    default:
      return "inProgress";
  }
}

/**
 * The file this thread's agent most recently wrote to, for a view that follows
 * along while it works.
 *
 * Only edits that still carry a path are eligible. Providers differ in how much
 * they report, and an edit whose path never survived the wire is not something
 * a follower can point at — skipping to the previous one keeps the view on the
 * last file we can actually show rather than blanking it.
 */
export function latestAgentFileEdit(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): AgentFileEdit | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity) continue;
    const payload = asRecord(activity.payload);
    if (payload?.itemType !== "file_change") continue;
    const path = firstFilePath(payload);
    if (path === null) continue;
    const agentId = payload.agentId;
    return {
      path,
      status: editStatus(payload.status),
      agentId: typeof agentId === "string" ? agentId : null,
      activityId: activity.id,
    };
  }
  return null;
}
