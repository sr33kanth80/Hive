// HIVE: Derives the ownership registry from settled turns.
//
// Claims come from `thread.turn-diff-completed`, whose payload carries the
// per-turn file list the server already computes by diffing checkpoint refs
// (see CheckpointReactor.captureAndDispatchCheckpoint). That makes claims
// git-derived and provider-agnostic: no provider event payloads are parsed, and
// the paths are repo-root-relative, so a worktree's `src/a.ts` is the same key
// as the main checkout's.
//
// This is a reactor rather than a hook in the decider or projector because both
// are pure — writing the registry from either would break the core invariant
// and the Effect conventions check.

import { ClaimsRegistry, make as makeClaimsRegistry } from "@t3tools/claims/registry";
import { ownershipFilePath } from "@t3tools/claims/store";
import type { OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";

/**
 * The registry lives beside the server's database, under the same stateDir that
 * owns state.sqlite, so it respects the dev/userdata split and stays outside
 * every project workspace and worktree.
 */
export const claimsRegistryLayer = Layer.effect(
  ClaimsRegistry,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const filePath = yield* ownershipFilePath(config.stateDir);
    return yield* makeClaimsRegistry(filePath);
  }),
);

export class ClaimsReactor extends Context.Service<
  ClaimsReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ClaimsReactor") {}

type ClaimsWork =
  | { readonly kind: "register"; readonly event: OrchestrationEvent }
  | { readonly kind: "meta"; readonly event: OrchestrationEvent }
  | { readonly kind: "turn-diff"; readonly event: OrchestrationEvent }
  | { readonly kind: "release"; readonly event: OrchestrationEvent };

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const registry = yield* ClaimsRegistry;

  const apply = Effect.fn("ClaimsReactor.apply")(function* (work: ClaimsWork) {
    const payload = work.event.payload as Record<string, unknown>;
    const threadId = payload.threadId;
    if (typeof threadId !== "string") return;

    switch (work.kind) {
      case "register": {
        return yield* registry.register({
          threadId: threadId as never,
          projectId: (payload.projectId ?? null) as never,
          branch: (payload.branch ?? null) as string | null,
          worktreePath: (payload.worktreePath ?? null) as string | null,
        });
      }
      case "meta": {
        // Branch and worktreePath are attached after creation, once the
        // worktree is prepared, so the claim learns them late.
        return yield* registry.register({
          threadId: threadId as never,
          ...(payload.branch === undefined ? {} : { branch: payload.branch as string | null }),
          ...(payload.worktreePath === undefined
            ? {}
            : { worktreePath: payload.worktreePath as string | null }),
        });
      }
      case "turn-diff": {
        const files = Array.isArray(payload.files)
          ? (payload.files as ReadonlyArray<{ readonly path?: unknown }>)
              .map((file) => file.path)
              .filter((path): path is string => typeof path === "string")
          : [];
        // An empty list is ambiguous at the source: a diff failure is caught and
        // reported as no files, identically to a turn that changed nothing. The
        // checkpoint status is the only signal separating them, so record it.
        const status = payload.status;
        const filesSource = files.length === 0 && status !== "ready" ? "diff-unavailable" : "diff";
        return yield* registry.claimFiles({
          threadId: threadId as never,
          files,
          filesSource,
        });
      }
      case "release": {
        return yield* registry.release(threadId as never);
      }
    }
  });

  const worker = yield* makeDrainableWorker((work: ClaimsWork) =>
    apply(work).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("hive claims update failed", {
              kind: work.kind,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const processEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "thread.created":
        return worker.enqueue({ kind: "register", event });
      case "thread.meta-updated":
        return worker.enqueue({ kind: "meta", event });
      case "thread.turn-diff-completed":
        return worker.enqueue({ kind: "turn-diff", event });
      case "thread.deleted":
      case "thread.archived":
        return worker.enqueue({ kind: "release", event });
    }
    return Effect.void;
  };

  const start = Effect.fn("ClaimsReactor.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, processEvent));
  });

  return { start, drain: worker.drain } satisfies ClaimsReactor["Service"];
});

export const layer = Layer.effect(ClaimsReactor, make);
