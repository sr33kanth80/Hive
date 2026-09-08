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

import { ProjectionCheckpointRepository } from "../persistence/Services/ProjectionCheckpoints.ts";
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
  const checkpoints = yield* ProjectionCheckpointRepository;
  const detector = yield* ConflictDetector;

  /**
   * A thread's work lives in its checkpoints, not on its branch: checkpoints
   * are captured to hidden refs precisely so the user's branch is left alone.
   * Comparing branches therefore merges two identical commits and finds
   * nothing, so the earliest checkpoint is the shared base and the latest is
   * the thread's current state.
   */
  const resolveCheckpointBounds = Effect.fn("ConflictQuery.resolveCheckpointBounds")(function* (
    threadId: ThreadId,
  ) {
    const rows = yield* Effect.orDie(checkpoints.listByThreadId({ threadId }));
    const ready = rows
      .filter((row) => row.status === "ready")
      .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount);
    const base = ready.at(0);
    const latest = ready.at(-1);
    // One checkpoint means the thread has a starting state but nothing to
    // compare against it yet.
    if (base === undefined || latest === undefined || base === latest) return null;
    return { baseRef: base.checkpointRef, ref: latest.checkpointRef };
  });

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
      const bounds = new Map<ThreadId, { readonly baseRef: string; readonly ref: string }>();
      for (const thread of comparable) {
        const resolved = yield* resolveCheckpointBounds(thread.id);
        if (resolved !== null) bounds.set(thread.id, resolved);
      }
      // A thread with no comparable checkpoint state has not been checked, and
      // saying so is the difference between "clear" and "we did not look".
      const withState = comparable.filter((thread) => bounds.has(thread.id));
      const withoutState = comparable
        .filter((thread) => !bounds.has(thread.id))
        .map((thread) => thread.id);

      const conflicts: HiveConflict[] = [];
      for (const [index, thread] of withState.entries()) {
        const later = withState.slice(index + 1);
        if (later.length === 0) continue;

        const own = bounds.get(thread.id)!;
        const predictions = yield* detector.predictFromCheckpoints({
          // Any checkout of the repository resolves the refs; the project's own
          // workspace root is the one guaranteed to exist.
          cwd: project.workspaceRoot,
          baseRef: own.baseRef,
          ref: own.ref,
          candidates: later.map((other) => ({
            threadId: other.id,
            ref: bounds.get(other.id)!.ref,
            branch: other.branch!,
          })),
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

      return {
        conflicts,
        skippedThreadIds: [...skipped, ...withoutState],
      } satisfies HiveConflictsListResult;
    });

  return { listForProject } satisfies ConflictQuery["Service"];
});

export const layer = Layer.effect(ConflictQuery, make);
