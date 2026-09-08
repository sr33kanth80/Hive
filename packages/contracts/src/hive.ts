// HIVE: wire contracts for conflict prediction.
//
// Kept in its own file rather than folded into an existing schema module, so
// the fork's contract surface stays visible and upstream files stay untouched
// apart from the registration points in rpc.ts.

import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * One directed prediction: merging `branch` with `otherBranch` conflicts on
 * `files`. Produced by an in-memory git merge, so a conflict here is one git
 * itself would raise at merge time rather than a heuristic guess.
 */
export const HiveConflict = Schema.Struct({
  threadId: ThreadId,
  branch: TrimmedNonEmptyString,
  threadTitle: Schema.NullOr(TrimmedNonEmptyString),
  otherThreadId: ThreadId,
  otherBranch: TrimmedNonEmptyString,
  otherThreadTitle: Schema.NullOr(TrimmedNonEmptyString),
  /** Files git reports as conflicting. Never empty. */
  files: Schema.Array(TrimmedNonEmptyString),
});
export type HiveConflict = typeof HiveConflict.Type;

export const HiveConflictsListInput = Schema.Struct({
  projectId: ProjectId,
});
export type HiveConflictsListInput = typeof HiveConflictsListInput.Type;

export const HiveConflictsListResult = Schema.Struct({
  conflicts: Schema.Array(HiveConflict),
  /**
   * Threads that were skipped because they have no branch yet, or because git
   * declined to answer. Surfacing this keeps "no conflicts" honest: it
   * distinguishes "nothing collides" from "we could not tell".
   */
  skippedThreadIds: Schema.Array(ThreadId),
});
export type HiveConflictsListResult = typeof HiveConflictsListResult.Type;

// --- Swarms -----------------------------------------------------------------
//
// A swarm is one developer prompt broken into tasks, some of which can run at
// once and some of which must wait. The dependency edges are the point: they
// are what let independent work fan out while dependent work stays ordered.
//
// These live in contracts rather than in the swarm package because they cross
// the wire, and a second definition would drift from this one.

export const HiveSwarmTaskId = TrimmedNonEmptyString;
export type HiveSwarmTaskId = typeof HiveSwarmTaskId.Type;

/**
 * `blocked` is deliberately distinct from `pending`: a task waiting its turn
 * and a task that can never run because a dependency failed are different
 * situations, and collapsing them leaves a dead swarm looking busy.
 */
export const HiveSwarmTaskStatus = Schema.Literals([
  "pending",
  "running",
  "done",
  "failed",
  "blocked",
]);
export type HiveSwarmTaskStatus = typeof HiveSwarmTaskStatus.Type;

export const HiveSwarmTask = Schema.Struct({
  id: HiveSwarmTaskId,
  /** What the agent is asked to do. Becomes the thread's opening prompt. */
  title: TrimmedNonEmptyString,
  /** Tasks that must reach `done` before this one may start. */
  dependsOn: Schema.Array(HiveSwarmTaskId),
  status: HiveSwarmTaskStatus,
  threadId: Schema.NullOr(ThreadId),
});
export type HiveSwarmTask = typeof HiveSwarmTask.Type;

export const HiveSwarmStatus = Schema.Literals(["planning", "running", "settled"]);
export type HiveSwarmStatus = typeof HiveSwarmStatus.Type;

export const HiveSwarm = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  /** The developer's original prompt, kept so the swarm can explain itself. */
  goal: TrimmedNonEmptyString,
  status: HiveSwarmStatus,
  tasks: Schema.Array(HiveSwarmTask),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type HiveSwarm = typeof HiveSwarm.Type;

export const HiveSwarmCreateInput = Schema.Struct({
  projectId: ProjectId,
  goal: TrimmedNonEmptyString,
  tasks: Schema.Array(
    Schema.Struct({
      id: HiveSwarmTaskId,
      title: TrimmedNonEmptyString,
      dependsOn: Schema.optional(Schema.Array(HiveSwarmTaskId)),
    }),
  ),
  /** Start the first wave immediately. False stores the plan without running it. */
  launch: Schema.optional(Schema.Boolean),
});
export type HiveSwarmCreateInput = typeof HiveSwarmCreateInput.Type;

export const HiveSwarmCreateResult = Schema.Struct({
  swarm: HiveSwarm,
  /** Tasks started right away — the ones with no unmet dependencies. */
  launchedTaskIds: Schema.Array(HiveSwarmTaskId),
});
export type HiveSwarmCreateResult = typeof HiveSwarmCreateResult.Type;

export const HiveSwarmsListInput = Schema.Struct({
  projectId: ProjectId,
});
export type HiveSwarmsListInput = typeof HiveSwarmsListInput.Type;

export const HiveSwarmsListResult = Schema.Struct({
  swarms: Schema.Array(HiveSwarm),
});
export type HiveSwarmsListResult = typeof HiveSwarmsListResult.Type;

/** A plan that cannot run is refused rather than stored. */
export class HiveSwarmPlanInvalidError extends Schema.TaggedErrorClass<HiveSwarmPlanInvalidError>()(
  "HiveSwarmPlanInvalidError",
  {
    detail: TrimmedNonEmptyString,
  },
) {}
