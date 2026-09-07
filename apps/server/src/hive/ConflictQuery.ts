// HIVE: answers "which threads in this project will collide on merge?"
//
// Joins what the projection already knows about threads (branch, title) with
// ConflictDetector's in-memory merge. Nothing is derived from claimed file
// paths here — claims say what a branch has touched, but whether two branches
// conflict is a question only git can answer.

import {
  type HiveConflict,
  type HiveConflictsListResult,
  type OrchestrationThreadShell,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ConflictDetector } from "./ConflictDetector.ts";

export class ConflictQuery extends Context.Service<
  ConflictQuery,
  {
    readonly listForProject: (input: {
      readonly projectId: ProjectId;
    }) => Effect.Effect<HiveConflictsListResult>;
  }
>()("t3/hive/ConflictQuery") {}

/**
 * Threads worth comparing: live, in this project, and actually on a branch.
 * A thread without a branch has nothing to merge, so it is reported as skipped
 * rather than silently dropped.
 */
export function partitionComparableThreads(
  threads: ReadonlyArray<OrchestrationThreadShell>,
  projectId: ProjectId,
): {
  readonly comparable: ReadonlyArray<OrchestrationThreadShell>;
  readonly skipped: ReadonlyArray<ThreadId>;
} {
  const inProject = threads.filter(
    (thread) => thread.projectId === projectId && thread.archivedAt === null,
  );
  return {
    comparable: inProject.filter((thread) => thread.branch !== null),
    skipped: inProject.filter((thread) => thread.branch === null).map((thread) => thread.id),
  };
}

export const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const detector = yield* ConflictDetector;

  const listForProject: ConflictQuery["Service"]["listForProject"] = (input) =>
    Effect.gen(function* () {
      // A projection read failure is a server defect, not something a conflict
      // prediction can meaningfully report to a client, and the RPC's error
      // channel deliberately carries only authorization failures.
      const snapshot = yield* Effect.orDie(snapshots.getShellSnapshot());
      const project = snapshot.projects.find((entry) => entry.id === input.projectId);
      if (project === undefined) {
        return { conflicts: [], skippedThreadIds: [] } satisfies HiveConflictsListResult;
      }

      const { comparable, skipped } = partitionComparableThreads(snapshot.threads, input.projectId);

      // Merging is symmetric, so each unordered pair is evaluated once. Doing
      // otherwise would report the same collision twice, once per direction.
      const conflicts: HiveConflict[] = [];
      for (const [index, thread] of comparable.entries()) {
        const later = comparable.slice(index + 1);
        if (later.length === 0) continue;

        const predictions = yield* detector.predict({
          // Any checkout of the repository resolves the refs; the project's own
          // workspace root is the one guaranteed to exist.
          cwd: project.workspaceRoot,
          branch: thread.branch!,
          candidates: later.map((other) => ({ threadId: other.id, branch: other.branch! })),
        });

        for (const prediction of predictions) {
          const other = later.find((entry) => entry.id === prediction.threadId);
          conflicts.push({
            threadId: thread.id,
            branch: thread.branch!,
            threadTitle: thread.title,
            otherThreadId: prediction.threadId,
            otherBranch: prediction.branch,
            otherThreadTitle: other?.title ?? null,
            files: prediction.files,
          });
        }
      }

      return { conflicts, skippedThreadIds: skipped } satisfies HiveConflictsListResult;
    });

  return { listForProject } satisfies ConflictQuery["Service"];
});

export const layer = Layer.effect(ConflictQuery, make);
