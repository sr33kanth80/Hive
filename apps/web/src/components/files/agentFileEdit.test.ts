import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { latestAgentFileEdit } from "./agentFileEdit";

function activity(
  id: string,
  payload: Record<string, unknown>,
  kind = "tool.updated",
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    kind,
    tone: "tool",
    summary: "Tool activity",
    payload,
    turnId: null,
    createdAt: "2026-09-19T00:00:00.000Z",
  };
}

function fileChange(
  id: string,
  path: string | null,
  status?: string,
  extra: Record<string, unknown> = {},
): OrchestrationThreadActivity {
  return activity(id, {
    itemType: "file_change",
    ...(status ? { status } : {}),
    ...extra,
    data: {
      toolName: "Edit",
      ...(path === null ? {} : { files: [{ path }] }),
    },
  });
}

describe("latestAgentFileEdit", () => {
  it("follows the most recent edit", () => {
    const edit = latestAgentFileEdit([
      fileChange("a", "src/cart.ts", "completed"),
      activity("b", { itemType: "command_execution", status: "completed" }),
      fileChange("c", "README.md", "inProgress"),
    ]);
    expect(edit).toEqual({
      path: "README.md",
      status: "inProgress",
      agentId: null,
      activityId: "c",
    });
  });

  it("falls back to the last edit whose path survived the wire", () => {
    // Providers vary in what they report; an edit with no path is not something
    // a follower can point at, so the view should hold its last known file
    // rather than blanking.
    const edit = latestAgentFileEdit([
      fileChange("a", "src/cart.ts", "completed"),
      fileChange("b", null, "inProgress"),
    ]);
    expect(edit?.path).toBe("src/cart.ts");
    expect(edit?.activityId).toBe("a");
  });

  it("treats a declined or failed edit as terminal, and unknown spellings as live", () => {
    expect(latestAgentFileEdit([fileChange("a", "x.ts", "declined")])?.status).toBe("declined");
    expect(latestAgentFileEdit([fileChange("b", "x.ts", "failed")])?.status).toBe("failed");
    // Some providers spell it in_progress; anything unrecognized is still live.
    expect(latestAgentFileEdit([fileChange("c", "x.ts", "in_progress")])?.status).toBe(
      "inProgress",
    );
    expect(latestAgentFileEdit([fileChange("d", "x.ts")])?.status).toBe("inProgress");
  });

  it("carries the subagent that made the edit", () => {
    const edit = latestAgentFileEdit([
      fileChange("a", "src/cart.ts", "inProgress", { agentId: "task-3" }),
    ]);
    expect(edit?.agentId).toBe("task-3");
  });

  it("returns null when the thread has not touched a file", () => {
    expect(
      latestAgentFileEdit([
        activity("a", { itemType: "command_execution", status: "completed" }),
        activity("b", { itemType: "web_search", status: "completed" }),
      ]),
    ).toBeNull();
    expect(latestAgentFileEdit([])).toBeNull();
  });
});
