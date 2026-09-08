// HIVE: advances a swarm as its threads finish.
//
// The executor starts what the plan allows; this notices when a task is over,
// records the outcome, and starts whatever that unblocked. Together they are
// the loop that makes a swarm run itself.
//
// A reactor rather than a hook in the decider or projector, for the same reason
// as the claims reactor: both of those are pure, and this does I/O.

import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { SwarmRegistry } from "@t3tools/swarm/registry";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import { SwarmExecutor } from "./SwarmExecutor.ts";

export class SwarmReactor extends Context.Service<
  SwarmReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/hive/SwarmReactor") {}

interface ThreadOutcome {
  readonly threadId: ThreadId;
  readonly status: "done" | "failed";
}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const registry = yield* SwarmRegistry;
  const executor = yield* SwarmExecutor;

  const apply = Effect.fn("SwarmReactor.apply")(function* (outcome: ThreadOutcome) {
    const found = yield* registry.findByThread(outcome.threadId);
    // Most threads are not part of a swarm; those are simply not our business.
    if (found === null) return;
    if (found.task.status !== "running") return;

    yield* registry.markFinished({
      swarmId: found.swarm.id,
      taskId: found.task.id,
      status: outcome.status,
    });

    // Finishing one task is the only thing that can unblock another, so this
    // is exactly when the next wave should start.
    const launched = yield* executor.launchRunnable(found.swarm.id);
    if (launched.length > 0) {
      yield* Effect.logInfo("hive swarm advanced", {
        swarmId: found.swarm.id,
        finished: found.task.id,
        started: launched.map((entry) => entry.taskId),
      });
    }
  });

  const worker = yield* makeDrainableWorker((outcome: ThreadOutcome) =>
    apply(outcome).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("hive swarm advance failed", {
              threadId: outcome.threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  /**
   * A swarm task is over when its thread's provider session stops running.
   * `error` is the only status that means the work failed; `stopped` and
   * `ready` both mean the agent finished its turn and is idle.
   */
  const processEvent = (event: OrchestrationEvent) => {
    if (event.type !== "thread.session-set") return Effect.void;
    const payload = event.payload as {
      readonly threadId?: unknown;
      readonly session?: { readonly status?: unknown };
    };
    const threadId = payload.threadId;
    const status = payload.session?.status;
    if (typeof threadId !== "string") return Effect.void;

    if (status === "error") {
      return worker.enqueue({ threadId: threadId as ThreadId, status: "failed" });
    }
    if (status === "ready" || status === "stopped") {
      return worker.enqueue({ threadId: threadId as ThreadId, status: "done" });
    }
    return Effect.void;
  };

  const start = Effect.fn("SwarmReactor.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, processEvent));
  });

  return { start, drain: worker.drain } satisfies SwarmReactor["Service"];
});

export const layer = Layer.effect(SwarmReactor, make);
