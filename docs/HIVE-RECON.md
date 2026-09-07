# Hive Recon — checkpoints, branches, lifecycle, persistence

Read-only recon for the Hive fork (task F02). Every claim below cites a file and line numbers
against the tree at `D:\t3code-main\t3code-main`. Nothing in the codebase was modified.

Scope note: Hive derives file ownership from **git-computed checkpoint diffs**, not from parsing
provider file-edit events. This document is scoped to that decision. Provider event payloads are
covered only where they contradict it (section E).

---

## A. Turn diff pipeline

### Where the per-turn file list comes from

`CheckpointReactor` owns it end to end.

| Step | Location |
| --- | --- |
| Entry point, on `turn.completed` \| `turn.aborted` | [CheckpointReactor.ts:359-361](../apps/server/src/orchestration/Layers/CheckpointReactor.ts) |
| Guard: only the active turn may capture | CheckpointReactor.ts:372-375 |
| Core capture + dispatch | CheckpointReactor.ts:219-357 |
| Resolve `cwd`, must be a git repo | CheckpointReactor.ts:200-217 (`isGitRepository` at :213) |

Inside `captureAndDispatchCheckpoint`:

1. Refs are derived from the turn counter — `from = checkpointRefForThreadTurn(threadId, turnCount - 1)`,
   `to = checkpointRefForThreadTurn(threadId, turnCount)` (:236-238).
2. The baseline ref's existence is checked; a missing baseline logs a warning but does not abort (:240-250).
3. `checkpointStore.captureCheckpoint` writes the `to` ref (:252-255).
4. `workspaceEntries.refresh(cwd)` re-indexes the workspace (:259).
5. The diff runs as `diffCheckpoints({ ..., format: "numstat" })`, or resolves to `""` when there was no
   baseline (:264-274).
6. `parseTurnDiffFilesFromNumstat` parses it, and each entry is mapped to
   `{ path, kind: "modified", additions, deletions }` (:276-283).
7. The result is dispatched as the `thread.turn.diff.complete` command carrying `files` (:309-321).
8. Two receipts follow: `checkpoint.diff.finalized` (:322-330) and `turn.processing.quiesced` (:331-337),
   then a `checkpoint.captured` activity (:339-356).

**Confirmed:** the brief's guess that "CheckpointReactor.ts around 219-317 captures the completed turn's
files" is correct. The comment at :219 reads "Capture the completed turn's files, then publish its summary
and receipts."

### Path semantics — repo-root-relative

The git invocation is `["diff", "--numstat", "-z"]` with **no `--relative` flag**
([GitVcsDriver.ts:875-876](../apps/server/src/vcs/GitVcsDriver.ts)). Git's default output for `diff` is
relative to the **repository root**, not the process cwd.

The parser splits on NUL and handles the rename/copy form, where the path field is empty and the source
and destination arrive as the next two records ([Diffs.ts:9-32](../apps/server/src/checkpointing/Diffs.ts),
rename handling at :19-22). Output is sorted by path (:32).

**Consequence for claims — this is the good news.** A linked worktree's top level *is* its repository
root for path purposes, and a worktree is a checkout of the same tree. So `src/auth.ts` in a worktree and
`src/auth.ts` in the main checkout produce the identical numstat path. Claims can be compared across
threads with no path translation.

**Two caveats to assert in tests:**

- `git diff` honours the `diff.relative` config. A user who sets it turns paths cwd-relative and
  cross-thread comparison breaks silently. Assert repo-relative output rather than assuming it.
- A rename reports only the destination path (Diffs.ts:19-22). The old path never appears, so a claim
  will not cover it — which matters, because renaming a file *does* conflict with another thread editing
  it under its old name.

### Which cwd

`worktreePath ?? workspaceRoot` — [CheckpointDiffQuery.ts:132](../apps/server/src/checkpointing/CheckpointDiffQuery.ts)
and :240. `CheckpointReactor` resolves the same thing from the session runtime cwd or the thread record
(:200-217).

### Timing and failure modes

- Fires on **both** `turn.completed` and `turn.aborted` (:361) — interrupted turns still produce a file list.
- Fires **after** the turn has settled, as part of turn quiescing. This is an end-of-turn signal, not a
  live one.
- Turns where git was initialised mid-turn have no baseline: the checkpoint is kept, `files` is `[]`, and
  no diff is attempted (:261-274).
- A diff failure appends a warning activity and **swallows the error, yielding `files: []`** (:284-299).

---

## B. Thread, branch, worktree

### Worktrees are opt-in, and arrive *after* the thread

`ThreadCreateCommand` declares both as nullable:

```
branch:       Schema.NullOr(TrimmedNonEmptyString)   // orchestration.ts:806
worktreePath: Schema.NullOr(TrimmedNonEmptyString)   // orchestration.ts:807
```

The real sequencing lives in `bootstrapProgram`
([ws.ts:1095-1168](../apps/server/src/ws.ts)) — one client request that can create a thread, prepare a
worktree, run a setup script, and start a turn:

| Order | What happens | Line |
| --- | --- | --- |
| 1 | `thread.create` dispatched (`worktreePath` usually `null`) | ws.ts:1097-1109 |
| 2 | Deletion-reactor fence drains prior incarnations | ws.ts:1114 |
| 3 | `gitWorkflow.createWorktree({ path: null })` | ws.ts:1147-1153 |
| 4 | `thread.meta.update` attaches `branch` + `worktreePath` | ws.ts:1155-1161 |
| 5 | Setup script | ws.ts:1165 |
| 6 | Turn start | ws.ts:1167 |

**The thread exists before its worktree and before its branch is known.** This invalidates any design
that checks collisions "at thread create, using the branch" — see section C.

Base ref resolution: when `startFromOrigin` is set and the remote branch exists, the base is the resolved
remote-tracking commit; otherwise the local base branch (ws.ts:1118-1146).

### On-disk location

Worktrees live under **T3 home**, not in the user's repository:

```
worktreesDir: join(baseDir, "worktrees")   // config.ts:126
```

`createWorktree` is called with `path: null` (ws.ts:1152), so the server derives the path. The underlying
git call is `worktree add -b <newRefName> <path> <refName>`
([GitVcsDriverCore.ts:2878-2879](../apps/server/src/vcs/GitVcsDriverCore.ts)). Removal and pruning exist
at :3116 and :3165.

### What a claim should be keyed by

`threadId`. It exists from step 1, never changes, and is present on every event Hive will observe.
`branch` and `worktreePath` arrive later (step 4) and can be updated afterwards, so they belong in the
claim as data, not as its key.

**Open item — not verified:** I traced `worktree remove` / `worktree prune` as available operations but
did **not** confirm what happens to a thread's branch and worktree on `thread.delete` or
`thread.archive`. F03's `release()` should be driven by thread lifecycle events regardless, but if you
later want to GC claims when a branch disappears, that wiring needs its own read.

---

## C. Lifecycle gates

### States

Session status is one of `idle | starting | running | ready | interrupted | stopped | error`
(orchestration.ts:387-395). Thread-level concepts — archived, settled, snoozed, pinned — are separate and
handled by dedicated decider paths (see the `decider.*.test.ts` files for the authoritative list).

### The decider cannot host the check

`thread.create` in the decider (decider.ts:335-368) validates only that the project exists and the thread
does not, then emits `thread.created`. It is pure by architectural invariant — no git, no filesystem, no
I/O. A collision check needs git, so it cannot live here.

### Recommended gate point

> **Top of `bootstrapProgram`, [ws.ts:1095](../apps/server/src/ws.ts), immediately before the
> `thread.create` dispatch at :1097.**

**Justification.** This is the only point where the full intent is known and nothing has been committed.
In scope at :1095 you have `bootstrap.createThread` (the task title, the project id) and
`bootstrap.prepareWorktree` (the branch name, the base branch, the project cwd) — everything a scope
predictor needs. Nothing has been dispatched: no thread record, no worktree on disk, no branch, no
provider process, no setup script. A failure raised here unwinds through the `Effect.catchCause` already
wrapping the program at :1170-1174, which maps bootstrap failures to a structured client error — so the
rejection path exists and is already handled by clients. Every later insertion point (after :1109, after
:1153) requires compensating deletes of things that were already created, and the deletion-reactor fence
at :1114 makes that materially more complex.

### Approvals are not reusable as a generic gate

The mechanism: providers raise `thread.approval-response-requested` (orchestration.ts:1273, 1662) and the
client answers with `thread.approval.respond` (orchestration.ts:1019). Requests are typed by
`ProviderRequestKind` = `command | file-read | file-change | mcp-elicitation` (orchestration.ts:131-136),
and pending ones are persisted by `ProjectionPendingApprovalRepository`
([ProjectionPendingApprovals.ts:53-102](../apps/server/src/persistence/Services/ProjectionPendingApprovals.ts)),
keyed by `requestId` — so they do survive a restart.

**Verdict: do not reuse it for F04.** The flow is provider-initiated end to end. A request originates in
a provider runtime, carries that runtime's `requestId`, and its resolution is routed back to the provider
adapter to unblock a waiting agent. There is no server-initiated "raise an approval and wait" entry
point. Bending it to gate thread creation would mean minting a synthetic `requestId` with no provider on
the other side to receive the answer.

F04 should instead **return a structured rejection from the bootstrap call** and let the client render the
proceed / takeover / cancel choice, then re-issue the bootstrap with an override flag. That reuses
machinery that already exists (:1170-1174) instead of subverting machinery that does not fit.

Worth knowing: `RuntimeMode` is `approval-required | auto-accept-edits | auto | full-access`
(orchestration.ts:120-125) and the default is **`full-access`** (orchestration.ts:127) — the most
permissive. Most users are not running with an approval gate at all today.

---

## D. Persistence

### What the server writes, and where

The primary store is **SQLite** (`@effect/sql-sqlite-bun`). The event log and every projection live there
— `OrchestrationEventStore`, `ProjectionThreads`, `ProjectionCheckpoints`, `ProjectionPendingApprovals`,
`ProjectionTurns` and siblings under `apps/server/src/persistence/Services/`, with schema migrations in
`apps/server/src/persistence/Migrations/`. Events, projections, and the command receipt commit in one
transaction (see `docs/internals/overview.md`).

Filesystem paths are all derived in `ServerConfig`:

| Path | Line |
| --- | --- |
| `baseDir` → `userdata` (or `dev` when a dev URL is set and baseDir is not explicit) | config.ts:105-112 |
| `caches` | config.ts:118 |
| `worktrees` | config.ts:126 |

### Atomicity — a helper already exists

```ts
writeFileStringAtomically({ filePath, contents })   // atomicWrite.ts:5-27
```

It creates the parent directory, writes to a scoped temp directory, then renames into place
([atomicWrite.ts](../apps/server/src/atomicWrite.ts)). **F03 must use this rather than hand-rolling
tmp+rename.**

### Where Hive state should live

Derive a new path in exactly the place `worktreesDir` is derived (config.ts:126):

```ts
hiveDir: join(baseDir, "hive")
```

This is environment-global, a sibling of `worktrees` and `caches`, and outside every project workspace
and every worktree — so it is never captured by a checkpoint, never appears in a turn diff, and cannot be
committed by a user.

**A note on format.** Everything else the server persists is SQLite; a JSON registry is the odd one out.
The argument for JSON anyway is drift: a SQLite table means an upstream migration file, which is exactly
the kind of change that makes a rebase-fork painful. Recommend JSON under `hiveDir` for v1, and revisit
if the registry outgrows a single file.

---

## E. Surprises

Seven findings that contradict a reasonable prior. The first three change design.

1. **`kind` is hardcoded to `"modified"`.** `OrchestrationCheckpointFile` has a `kind` field, but
   `CheckpointReactor.ts:279` sets every entry to `"modified"` regardless of whether the file was added,
   deleted, or renamed. Do not build logic or UI that depends on distinguishing them.

2. **A failed diff is indistinguishable from an empty one.** Diff errors are caught, logged, and yield
   `files: []` (CheckpointReactor.ts:292-299). An empty claim does **not** mean the turn touched nothing.
   F03 must record *why* a file list was empty, or it will silently under-claim and F04 will miss real
   conflicts.

3. **The thread predates its branch and worktree** (ws.ts:1097 vs :1147-1161). Any collision design keyed
   on the branch at `thread.create` time is checking a value that is still `null`.

4. **Renames lose the source path** (Diffs.ts:19-22). Only the destination is reported. A thread that
   renames `a.ts` → `b.ts` never claims `a.ts`, so it will not be flagged against a thread editing
   `a.ts` — a real conflict class the v1 overlap check will miss.

5. **Worktrees live under T3 home, not in the repo** (config.ts:126). Convenient — it means Hive state
   placed next to them is equally invisible to the user's tree — but it also means "the repo root" is not
   a meaningful shared location for anything Hive writes.

6. **The default permission mode is the most permissive one.** `full-access` (orchestration.ts:127).
   Positioning that assumes users already run with approval gates is wrong.

7. **`git diff` output relativity is user-configurable.** `diff.relative` in a user's git config turns
   repo-relative paths into cwd-relative ones. Nothing in the codebase pins it. This is a silent
   cross-thread comparison failure waiting to happen; assert against it.

### Effect patterns in these files

Consistent with the rest of the repo — `Effect.fn` with named spans for traced operations
(`Effect.fn("captureAndDispatchCheckpoint")`, CheckpointReactor.ts:220), `Effect.catch` for recovery,
`Option.match` for nullable resolution (CheckpointReactor.ts:200-208), and receipts published to the
`RuntimeReceiptBus` at async milestones. Nothing anomalous to warn F03 about.

---

## What this means for F03

- Claim key is `threadId`; carry `branch` and `worktreePath` as mutable data.
- Source the file list from the `thread.turn.diff.complete` command / the checkpoint summary — not from
  provider events.
- Hook a `ClaimsReactor` to the same turn-completion signal `CheckpointReactor` uses, or to the
  `checkpoint.diff.finalized` receipt, so claims update once per settled turn.
- Store under `join(baseDir, "hive")` using `writeFileStringAtomically`.
- Treat "diff unavailable" as its own state, distinct from "no files changed".
- Claims update at **turn settlement**, so the registry is at best one turn stale. That is fine for
  merge-conflict prediction, and it is worth stating plainly rather than implying live tracking.
