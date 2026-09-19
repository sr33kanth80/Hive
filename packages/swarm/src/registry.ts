// HIVE: owns swarm state and applies status transitions.
//
// The scheduler decides what may run; this decides what has happened. Keeping
// them apart means the ordering logic stays pure and testable, and the mutable
// part stays small enough to reason about.

import type { ModelSelection, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type {
  Swarm,
  SwarmId,
  SwarmStoreFile,
  SwarmTask,
  SwarmTaskId,
  SwarmTaskStatus,
} from "./schema.ts";
import { isSettled, runnableTasks, unreachableTasks, validateTaskGraph } from "./scheduler.ts";
import { loadSwarms, saveSwarms } from "./store.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export class SwarmPlanInvalid extends Error {
  readonly _tag = "SwarmPlanInvalid";
}

export interface CreateSwarmInput {
  readonly id: SwarmId;
  readonly projectId: ProjectId;
  readonly goal: string;
  readonly tasks: ReadonlyArray<{
    readonly id: SwarmTaskId;
    readonly title: string;
    readonly dependsOn?: ReadonlyArray<SwarmTaskId>;
  }>;
  /** Provider and model every task runs on, pinned for the swarm's lifetime. */
  readonly modelSelection?: ModelSelection;
}

/**
 * Every swarm in one project, as it stands after a change. The whole project's
 * set rather than the single swarm that moved, so a subscriber renders from one
 * value instead of maintaining its own merge of patches.
 */
export interface SwarmProjectChange {
  readonly projectId: ProjectId;
  readonly swarms: ReadonlyArray<Swarm>;
}

export class SwarmRegistry extends Context.Service<
  SwarmRegistry,
  {
    /** Rejects an invalid plan rather than storing something that cannot run. */
    readonly create: (input: CreateSwarmInput) => Effect.Effect<Swarm, SwarmPlanInvalid>;
    readonly get: (id: SwarmId) => Effect.Effect<Swarm | null>;
    readonly list: Effect.Effect<ReadonlyArray<Swarm>>;
    readonly listForProject: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<Swarm>>;
    /** Record that a task was given a thread and has started. */
    readonly markRunning: (input: {
      readonly swarmId: SwarmId;
      readonly taskId: SwarmTaskId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<void>;
    readonly markFinished: (input: {
      readonly swarmId: SwarmId;
      readonly taskId: SwarmTaskId;
      readonly status: Extract<SwarmTaskStatus, "done" | "failed">;
      /** Why it ended this way, when the caller knows. */
      readonly detail?: string | null;
    }) => Effect.Effect<void>;
    /** Find the swarm and task a thread belongs to, if any. */
    readonly findByThread: (
      threadId: ThreadId,
    ) => Effect.Effect<{ readonly swarm: Swarm; readonly task: SwarmTask } | null>;
    /** Tasks that may start now. */
    readonly claimRunnable: (id: SwarmId) => Effect.Effect<ReadonlyArray<SwarmTask>>;
    /**
     * A task that could not be started at all. Distinct from `markFinished`
     * because it never had a thread: without this it would sit `pending`
     * forever and the swarm would look busy rather than broken.
     */
    readonly markLaunchFailed: (input: {
      readonly swarmId: SwarmId;
      readonly taskId: SwarmTaskId;
      readonly detail: string;
    }) => Effect.Effect<void>;
    /**
     * Swarm state pushed as it changes, one event per project touched. Polling
     * `listForProject` means a swarm can finish and sit unnoticed until the next
     * interval; anything waiting on a swarm settling needs to hear about it when
     * it happens rather than up to a poll later.
     */
    readonly changes: Stream.Stream<SwarmProjectChange>;
  }
>()("@t3tools/swarm/registry/SwarmRegistry") {}

export const make = (filePath: string) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const initial = yield* loadSwarms(filePath);
    const state = yield* Ref.make<SwarmStoreFile>(initial);
    const lock = yield* Semaphore.make(1);
    const changesPubSub = yield* PubSub.unbounded<SwarmProjectChange>();

    const persist = Effect.fn("SwarmRegistry.persist")(function* () {
      const current = yield* Ref.get(state);
      yield* saveSwarms(filePath, current).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("hive swarm store write failed; keeping in-memory state", {
            filePath,
            cause: String(cause),
          }),
        ),
        Effect.provide(context),
      );
    });

    /**
     * Settling is a function of the task statuses, so it is computed on the way
     * out rather than written when a task ends. Storing it left any swarm that
     * reached its terminal state under an older server — or before this rule
     * existed — claiming to be running forever, with nothing left to happen that
     * would correct it.
     */
    const withDerivedStatus = (swarm: Swarm): Swarm =>
      swarm.status === "running" && isSettled(swarm)
        ? { ...swarm, status: "settled" as const }
        : swarm;

    /** Every swarm as callers should see it. The only read path. */
    const all = Effect.map(Ref.get(state), (store) => store.swarms.map(withDerivedStatus));

    /**
     * Announce the project the given swarm belongs to. Called after the state
     * has been written, so a subscriber that reacts immediately reads the same
     * value a fresh `listForProject` would return.
     */
    const publishSwarm = (swarmId: SwarmId) =>
      Effect.gen(function* () {
        const swarms = yield* all;
        const changed = swarms.find((swarm) => swarm.id === swarmId);
        if (changed === undefined) return;
        yield* PubSub.publish(changesPubSub, {
          projectId: changed.projectId,
          swarms: swarms.filter((swarm) => swarm.projectId === changed.projectId),
        });
      });

    const mutate = (
      swarmId: SwarmId,
      update: (swarms: ReadonlyArray<Swarm>, at: string) => ReadonlyArray<Swarm>,
    ) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const at = yield* nowIso;
          yield* Ref.update(state, (store) => ({ ...store, swarms: update(store.swarms, at) }));
          yield* persist();
          yield* publishSwarm(swarmId);
        }),
      );

    const updateSwarm = (
      swarms: ReadonlyArray<Swarm>,
      id: SwarmId,
      at: string,
      apply: (swarm: Swarm) => Swarm,
    ): ReadonlyArray<Swarm> =>
      swarms.map((swarm) => (swarm.id === id ? { ...apply(swarm), updatedAt: at } : swarm));

    const updateTask = (
      swarm: Swarm,
      taskId: SwarmTaskId,
      apply: (task: SwarmTask) => SwarmTask,
    ): Swarm => ({
      ...swarm,
      tasks: swarm.tasks.map((task) => (task.id === taskId ? apply(task) : task)),
    });

    /**
     * A task ending strands everything downstream of it. Recording that in the
     * same mutation is what stops a dead swarm from looking like it is still
     * making progress. Shared by both terminal transitions.
     */
    const blockStrandedTasks = (swarm: Swarm): Swarm => {
      const stranded = new Set(unreachableTasks(swarm).map((task) => task.id));
      return {
        ...swarm,
        tasks: swarm.tasks.map((task) =>
          stranded.has(task.id) ? { ...task, status: "blocked" as const } : task,
        ),
      };
    };

    const create: SwarmRegistry["Service"]["create"] = (input) =>
      Effect.gen(function* () {
        const tasks: SwarmTask[] = input.tasks.map((task) => ({
          id: task.id,
          title: task.title,
          dependsOn: task.dependsOn ?? [],
          status: "pending",
          threadId: null,
        }));

        // Refuse an unrunnable plan up front. A cycle would leave every task in
        // it waiting forever while the swarm merely looked slow.
        const problems = validateTaskGraph(tasks);
        if (problems.length > 0) {
          return yield* Effect.fail(
            new SwarmPlanInvalid(problems.map((problem) => problem.detail).join(" ")),
          );
        }

        const at = yield* nowIso;
        const swarm: Swarm = {
          id: input.id,
          projectId: input.projectId,
          goal: input.goal,
          status: "running",
          tasks,
          ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
          createdAt: at,
          updatedAt: at,
        };
        yield* lock.withPermits(1)(
          Effect.gen(function* () {
            yield* Ref.update(state, (store) => ({ ...store, swarms: [...store.swarms, swarm] }));
            yield* persist();
            yield* publishSwarm(swarm.id);
          }),
        );
        return swarm;
      });

    const get: SwarmRegistry["Service"]["get"] = (id) =>
      Effect.map(all, (swarms) => swarms.find((swarm) => swarm.id === id) ?? null);

    const listForProject: SwarmRegistry["Service"]["listForProject"] = (projectId) =>
      Effect.map(all, (swarms) => swarms.filter((swarm) => swarm.projectId === projectId));

    const markRunning: SwarmRegistry["Service"]["markRunning"] = (input) =>
      mutate(input.swarmId, (swarms, at) =>
        updateSwarm(swarms, input.swarmId, at, (swarm) =>
          updateTask(swarm, input.taskId, (task) => ({
            ...task,
            status: "running",
            threadId: input.threadId,
          })),
        ),
      );

    const markFinished: SwarmRegistry["Service"]["markFinished"] = (input) =>
      mutate(input.swarmId, (swarms, at) =>
        updateSwarm(swarms, input.swarmId, at, (swarm) => {
          const detail = input.detail?.trim();
          return blockStrandedTasks(
            updateTask(swarm, input.taskId, (task) => ({
              ...task,
              status: input.status,
              // A blank reason must not overwrite one already recorded, and an
              // empty string is not a valid TrimmedNonEmptyString.
              ...(detail ? { detail } : {}),
            })),
          );
        }),
      );

    const findByThread: SwarmRegistry["Service"]["findByThread"] = (threadId) =>
      Effect.map(all, (swarms) => {
        for (const swarm of swarms) {
          const task = swarm.tasks.find((entry) => entry.threadId === threadId);
          if (task !== undefined) return { swarm, task };
        }
        return null;
      });

    const claimRunnable: SwarmRegistry["Service"]["claimRunnable"] = (id) =>
      Effect.map(get(id), (swarm) => (swarm === null ? [] : runnableTasks(swarm)));

    const markLaunchFailed: SwarmRegistry["Service"]["markLaunchFailed"] = (input) =>
      mutate(input.swarmId, (swarms, at) =>
        updateSwarm(swarms, input.swarmId, at, (swarm) => {
          const detail = input.detail.trim();
          return blockStrandedTasks(
            updateTask(swarm, input.taskId, (task) => ({
              ...task,
              status: "failed" as const,
              ...(detail ? { detail } : {}),
            })),
          );
        }),
      );

    return {
      create,
      get,
      list: all,
      listForProject,
      markRunning,
      markFinished,
      findByThread,
      claimRunnable,
      markLaunchFailed,
      changes: Stream.fromPubSub(changesPubSub),
    } satisfies SwarmRegistry["Service"];
  });

export const layer = (
  filePath: string,
): Layer.Layer<SwarmRegistry, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(SwarmRegistry, make(filePath));
