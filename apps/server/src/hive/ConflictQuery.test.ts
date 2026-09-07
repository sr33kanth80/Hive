import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationThreadShell, ProjectId, ThreadId } from "@t3tools/contracts";

import { partitionComparableThreads } from "./ConflictQuery.ts";

const PROJECT = "project-1" as ProjectId;
const OTHER_PROJECT = "project-2" as ProjectId;

function shell(input: {
  readonly id: string;
  readonly projectId?: ProjectId;
  readonly branch?: string | null;
  readonly archivedAt?: string | null;
}): OrchestrationThreadShell {
  return {
    id: input.id as ThreadId,
    projectId: input.projectId ?? PROJECT,
    branch: input.branch === undefined ? "hive/branch" : input.branch,
    archivedAt: input.archivedAt ?? null,
  } as unknown as OrchestrationThreadShell;
}

describe("partitionComparableThreads", () => {
  it("compares only live threads in the requested project", () => {
    const { comparable } = partitionComparableThreads(
      [
        shell({ id: "a" }),
        shell({ id: "b", projectId: OTHER_PROJECT }),
        shell({ id: "c", archivedAt: "2026-01-01T00:00:00.000Z" }),
      ],
      PROJECT,
    );
    assert.deepStrictEqual(
      comparable.map((thread) => thread.id),
      ["a"],
    );
  });

  it("reports branchless threads as skipped rather than dropping them", () => {
    // A thread with no branch cannot be merged against anything, and silently
    // ignoring it would make an empty conflict list misleading.
    const { comparable, skipped } = partitionComparableThreads(
      [shell({ id: "a" }), shell({ id: "b", branch: null })],
      PROJECT,
    );
    assert.deepStrictEqual(
      comparable.map((thread) => thread.id),
      ["a"],
    );
    assert.deepStrictEqual(skipped, ["b" as ThreadId]);
  });

  it("does not report threads from other projects as skipped", () => {
    const { skipped } = partitionComparableThreads(
      [shell({ id: "b", projectId: OTHER_PROJECT, branch: null })],
      PROJECT,
    );
    assert.deepStrictEqual(skipped, []);
  });
});
