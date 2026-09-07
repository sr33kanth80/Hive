import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * A claim records which repo-relative files a thread's branch has touched, so
 * concurrent threads can be warned that their work will collide on merge.
 *
 * Claims are derived from git — the per-turn file list on
 * `thread.turn-diff-completed`, which the server computes by diffing checkpoint
 * refs. They are not derived from provider file-edit events, so they are
 * provider-agnostic and survive worktree isolation.
 */
export const ClaimStatus = Schema.Literals(["active", "stale"]);
export type ClaimStatus = typeof ClaimStatus.Type;

/**
 * How the file list was obtained. A turn whose diff failed reports no files,
 * which is indistinguishable from a turn that genuinely changed nothing unless
 * the reason is recorded — treating the two alike silently under-claims.
 */
export const ClaimFilesSource = Schema.Literals(["diff", "diff-unavailable"]);
export type ClaimFilesSource = typeof ClaimFilesSource.Type;

export const Claim = Schema.Struct({
  /** Stable from thread creation; branch and worktreePath are attached later. */
  threadId: ThreadId,
  projectId: Schema.NullOr(ProjectId),
  /** Null until the thread's worktree is prepared. */
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  /** Repo-root-relative, forward-slashed, deduplicated, sorted. */
  files: Schema.Array(Schema.String),
  status: ClaimStatus,
  filesSource: ClaimFilesSource,
  /** Turns folded into this claim. Zero means the thread has not settled a turn. */
  turnCount: Schema.Number,
  updatedAt: Schema.String,
});
export type Claim = typeof Claim.Type;

export const ClaimStoreFile = Schema.Struct({
  version: Schema.Literal(1),
  claims: Schema.Array(Claim),
});
export type ClaimStoreFile = typeof ClaimStoreFile.Type;

export const EMPTY_STORE: ClaimStoreFile = { version: 1, claims: [] };

/**
 * Git reports diff paths relative to the repository root with forward slashes,
 * but callers and tests supply platform paths and `./` prefixes. Normalizing on
 * the way in keeps a worktree's `src/a.ts` equal to the main checkout's.
 */
export function normalizeClaimPath(filePath: string): string {
  const forwardSlashed = filePath.replaceAll("\\", "/");
  const collapsed = forwardSlashed.replaceAll(/\/{2,}/gu, "/");
  const segments: string[] = [];
  for (const segment of collapsed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." && segments.length > 0 && segments.at(-1) !== "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

export function normalizeClaimPaths(filePaths: Iterable<string>): ReadonlyArray<string> {
  const normalized = new Set<string>();
  for (const filePath of filePaths) {
    const value = normalizeClaimPath(filePath);
    if (value !== "") normalized.add(value);
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}
