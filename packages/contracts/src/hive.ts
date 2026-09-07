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
