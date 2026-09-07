// HIVE: predicts whether two threads' branches will actually conflict on merge.
//
// The original plan compared claimed file paths and warned on any overlap. That
// produces false positives constantly — two threads editing different parts of
// the same file merge cleanly — and a warning people learn to dismiss is worse
// than no warning at all.
//
// `git merge-tree --write-tree` performs the merge in memory, touching neither
// the working tree nor the index, and reports the files that genuinely
// conflict. That is a real answer rather than a heuristic, and it costs one
// cheap git invocation per candidate pair.
//
// Every pair is checked rather than prefiltering on claimed-path overlap: the
// prefilter would miss conflicts that path comparison cannot see, most obviously
// a rename on one side against an edit to the old name on the other.

import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as VcsProcess from "../vcs/VcsProcess.ts";

export interface ConflictCandidate {
  readonly threadId: ThreadId;
  /** The candidate's branch. Threads without one cannot be compared. */
  readonly branch: string;
}

export interface ConflictPrediction {
  readonly threadId: ThreadId;
  readonly branch: string;
  /** Files git reports as conflicting. Never empty. */
  readonly files: ReadonlyArray<string>;
}

export class ConflictDetector extends Context.Service<
  ConflictDetector,
  {
    /**
     * Merge `branch` against each candidate in memory and report those that
     * conflict. Candidates that cannot be evaluated are omitted, not guessed at.
     */
    readonly predict: (input: {
      readonly cwd: string;
      readonly branch: string;
      readonly candidates: ReadonlyArray<ConflictCandidate>;
    }) => Effect.Effect<ReadonlyArray<ConflictPrediction>>;
  }
>()("t3/hive/ConflictDetector") {}

/**
 * `git merge-tree --write-tree --name-only` prints the merged tree's object id
 * on the first line, then the conflicting paths, then a blank line before any
 * informational messages. Only the middle section is of interest.
 *
 * Paths containing newlines would confuse this; git offers `-z` for that, at
 * the cost of a section-parsing scheme that is harder to read. Line parsing is
 * the right trade until such a path actually turns up.
 */
export function parseConflictedPaths(stdout: string): ReadonlyArray<string> {
  const lines = stdout.split("\n");
  const paths: string[] = [];
  // Skip the tree object id on the first line.
  for (const line of lines.slice(1)) {
    const trimmed = line.trimEnd();
    if (trimmed === "") break;
    paths.push(trimmed);
  }
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

export const make = Effect.gen(function* () {
  const vcs = yield* VcsProcess.VcsProcess;

  const mergeConflicts = Effect.fn("ConflictDetector.mergeConflicts")(function* (input: {
    readonly cwd: string;
    readonly branch: string;
    readonly candidate: ConflictCandidate;
  }) {
    const result = yield* vcs.run({
      operation: "hive.conflictDetector.mergeTree",
      command: "git",
      args: ["merge-tree", "--write-tree", "--name-only", input.branch, input.candidate.branch],
      cwd: input.cwd,
      // Exit 1 is merge-tree reporting conflicts, which is a successful
      // prediction rather than a command failure. Without this the interesting
      // case is raised as an error and never reaches the parser.
      allowNonZeroExit: true,
    });

    // 0 means the merge is clean; 1 means it conflicts. Anything else is git
    // declining to answer — unrelated histories, a missing ref, an old binary —
    // and a prediction we cannot make must not be reported as a conflict.
    if (result.exitCode === 0) return null;
    if (result.exitCode !== 1) {
      yield* Effect.logWarning("hive conflict prediction unavailable", {
        branch: input.branch,
        candidateBranch: input.candidate.branch,
        exitCode: result.exitCode,
        detail: result.stderr.slice(0, 200),
      });
      return null;
    }

    const files = parseConflictedPaths(result.stdout);
    if (files.length === 0) return null;
    return {
      threadId: input.candidate.threadId,
      branch: input.candidate.branch,
      files,
    } satisfies ConflictPrediction;
  });

  const predict: ConflictDetector["Service"]["predict"] = (input) =>
    Effect.gen(function* () {
      const candidates = input.candidates.filter(
        (candidate) => candidate.branch !== input.branch && candidate.branch.length > 0,
      );
      if (candidates.length === 0) return [];

      const predictions = yield* Effect.forEach(
        candidates,
        (candidate) =>
          mergeConflicts({ cwd: input.cwd, branch: input.branch, candidate }).pipe(
            // One unreadable candidate must not sink the whole prediction.
            Effect.catchCause((cause) =>
              Effect.logWarning("hive conflict prediction failed", {
                candidateBranch: candidate.branch,
                cause: String(cause),
              }).pipe(Effect.as(null)),
            ),
          ),
        { concurrency: 4 },
      );

      return predictions.filter(
        (prediction): prediction is ConflictPrediction => prediction !== null,
      );
    });

  return { predict } satisfies ConflictDetector["Service"];
});

export const layer = Layer.effect(ConflictDetector, make);
