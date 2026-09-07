import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import {
  type Claim,
  type ClaimFilesSource,
  type ClaimStoreFile,
  EMPTY_STORE,
  normalizeClaimPaths,
} from "./schema.ts";
import { loadStore, saveStore } from "./store.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export interface ClaimFilesInput {
  readonly threadId: ThreadId;
  readonly files: ReadonlyArray<string>;
  readonly filesSource: ClaimFilesSource;
  readonly projectId?: ProjectId | null;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
}

export interface RegisterInput {
  readonly threadId: ThreadId;
  readonly projectId?: ProjectId | null;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
}

export class ClaimsRegistry extends Context.Service<
  ClaimsRegistry,
  {
    /** Record a thread with no files yet, so it is visible before its first turn settles. */
    readonly register: (input: RegisterInput) => Effect.Effect<void>;
    /** Fold a settled turn's file list into the thread's claim. */
    readonly claimFiles: (input: ClaimFilesInput) => Effect.Effect<void>;
    /** Mark stale. Deliberately not a delete — gc owns removal. */
    readonly release: (threadId: ThreadId) => Effect.Effect<void>;
    /** Drop stale claims older than maxAgeMillis. Returns how many were removed. */
    readonly gc: (maxAgeMillis: number) => Effect.Effect<number>;
    readonly active: Effect.Effect<ReadonlyArray<Claim>>;
    readonly all: Effect.Effect<ReadonlyArray<Claim>>;
    /** Active claims from other threads sharing at least one file. */
    readonly overlaps: (input: {
      readonly files: ReadonlyArray<string>;
      readonly excludeThreadId?: ThreadId;
    }) => Effect.Effect<ReadonlyArray<Claim>>;
  }
>()("@t3tools/claims/registry/ClaimsRegistry") {}

/**
 * One environment is one server process and the orchestration engine already
 * serializes commands, so in-memory state guarded by a semaphore is the real
 * concurrency boundary. The atomic file write is for durability across a crash,
 * not for contention between processes.
 *
 * Writes are not debounced: claims change once per settled turn, not per file
 * edit, so batching would trade a lost-write window for no measurable gain.
 */
export const make = (filePath: string) =>
  Effect.gen(function* () {
    // Bake the filesystem services into the returned closures so callers of the
    // registry do not have to carry them. Mirrors PullRequestService and
    // terminal/Manager, which capture their context the same way.
    const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

    const initial = yield* loadStore(filePath);
    const state = yield* Ref.make<ClaimStoreFile>(initial);
    const lock = yield* Semaphore.make(1);

    const persist = Effect.fn("ClaimsRegistry.persist")(function* () {
      const current = yield* Ref.get(state);
      yield* saveStore(filePath, current).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("hive claims registry write failed; keeping in-memory state", {
            filePath,
            cause: String(cause),
          }),
        ),
        Effect.provide(context),
      );
    });

    const mutate = (update: (claims: ReadonlyArray<Claim>, at: string) => ReadonlyArray<Claim>) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const at = yield* nowIso;
          yield* Ref.update(state, (store) => ({ ...store, claims: update(store.claims, at) }));
          yield* persist();
        }),
      );

    const upsert = (
      claims: ReadonlyArray<Claim>,
      threadId: ThreadId,
      at: string,
      apply: (existing: Claim | undefined) => Claim,
    ): ReadonlyArray<Claim> => {
      const existing = claims.find((claim) => claim.threadId === threadId);
      const next = apply(existing);
      return existing === undefined
        ? [...claims, next]
        : claims.map((claim) => (claim.threadId === threadId ? next : claim));
    };

    const register: ClaimsRegistry["Service"]["register"] = (input) =>
      mutate((claims, at) =>
        upsert(claims, input.threadId, at, (existing) => ({
          threadId: input.threadId,
          projectId: input.projectId ?? existing?.projectId ?? null,
          branch: input.branch ?? existing?.branch ?? null,
          worktreePath: input.worktreePath ?? existing?.worktreePath ?? null,
          files: existing?.files ?? [],
          status: "active",
          filesSource: existing?.filesSource ?? "diff",
          turnCount: existing?.turnCount ?? 0,
          updatedAt: at,
        })),
      );

    const claimFiles: ClaimsRegistry["Service"]["claimFiles"] = (input) =>
      mutate((claims, at) =>
        upsert(claims, input.threadId, at, (existing) => {
          const merged = normalizeClaimPaths([...(existing?.files ?? []), ...input.files]);
          return {
            threadId: input.threadId,
            projectId: input.projectId ?? existing?.projectId ?? null,
            branch: input.branch ?? existing?.branch ?? null,
            worktreePath: input.worktreePath ?? existing?.worktreePath ?? null,
            files: merged,
            status: "active",
            // A turn whose diff was unavailable taints the claim: the file list
            // is known to be incomplete until a later turn succeeds.
            filesSource: input.filesSource === "diff-unavailable" ? "diff-unavailable" : "diff",
            turnCount: (existing?.turnCount ?? 0) + 1,
            updatedAt: at,
          };
        }),
      );

    const release: ClaimsRegistry["Service"]["release"] = (threadId) =>
      mutate((claims, at) =>
        claims.map((claim) =>
          claim.threadId === threadId ? { ...claim, status: "stale", updatedAt: at } : claim,
        ),
      );

    const gc: ClaimsRegistry["Service"]["gc"] = (maxAgeMillis) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const at = yield* DateTime.now;
          const cutoff = DateTime.toEpochMillis(at) - maxAgeMillis;
          const before = (yield* Ref.get(state)).claims.length;
          yield* Ref.update(state, (store) => ({
            ...store,
            claims: store.claims.filter((claim) => {
              if (claim.status !== "stale") return true;
              const updatedAt = Date.parse(claim.updatedAt);
              return Number.isNaN(updatedAt) ? true : updatedAt > cutoff;
            }),
          }));
          const after = (yield* Ref.get(state)).claims.length;
          if (after !== before) yield* persist();
          return before - after;
        }),
      );

    const all = Effect.map(Ref.get(state), (store) => store.claims);
    const active = Effect.map(all, (claims) => claims.filter((claim) => claim.status === "active"));

    const overlaps: ClaimsRegistry["Service"]["overlaps"] = (input) =>
      Effect.map(active, (claims) => {
        const wanted = new Set(normalizeClaimPaths(input.files));
        if (wanted.size === 0) return [];
        return claims.filter(
          (claim) =>
            claim.threadId !== input.excludeThreadId &&
            claim.files.some((file) => wanted.has(file)),
        );
      });

    return {
      register,
      claimFiles,
      release,
      gc,
      active,
      all,
      overlaps,
    } satisfies ClaimsRegistry["Service"];
  });

export const layer = (
  filePath: string,
): Layer.Layer<ClaimsRegistry, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(ClaimsRegistry, make(filePath));

export { EMPTY_STORE };
