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
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import type {
  Swarm,
  SwarmId,
  SwarmStoreFile,
  SwarmTask,
  SwarmTaskId,
  SwarmTaskStatus,
} from "./schema.ts";
import { runnableTasks, unreachableTasks, validateTaskGraph } from "./scheduler.ts";
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
  }
>()("@t3tools/swarm/registry/SwarmRegistry") {}

export const make = (filePath: string) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const initial = yield* loadSwarms(filePath);
    const state = yield* Ref.make<SwarmStoreFile>(initial);
    const lock = yield* Semaphore.make(1);

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

    const mutate = (update: (swarms: ReadonlyArray<Swarm>, at: string) => ReadonlyArray<Swarm>) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const at = yield* nowIso;
          yield* Ref.update(state, (store) => ({ ...store, swarms: update(store.swarms, at) }));
          yield* persist();
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
          }),
        );
        return swarm;
      });

    const all = Effect.map(Ref.get(state), (store) => store.swarms);

    const get: SwarmRegistry["Service"]["get"] = (id) =>
      Effect.map(all, (swarms) => swarms.find((swarm) => swarm.id === id) ?? null);

    const listForProject: SwarmRegistry["Service"]["listForProject"] = (projectId) =>
      Effect.map(all, (swarms) => swarms.filter((swarm) => swarm.projectId === projectId));

    const markRunning: SwarmRegistry["Service"]["markRunning"] = (input) =>
      mutate((swarms, at) =>
        updateSwarm(swarms, input.swarmId, at, (swarm) =>
          updateTask(swarm, input.taskId, (task) => ({
            ...task,
            status: "running",
            threadId: input.threadId,
          })),
        ),
      );

    const markFinished: SwarmRegistry["Service"]["markFinished"] = (input) =>
      mutate((swarms, at) =>
        updateSwarm(swarms, input.swarmId, at, (swarm) => {
          const detail = input.detail?.trim();
          const settled = updateTask(swarm, input.taskId, (task) => ({
            ...task,
            status: input.status,
            // A blank reason must not overwrite one already recorded, and an
            // empty string is not a valid TrimmedNonEmptyString.
            ...(detail ? { detail } : {}),
          }));
          // A failure strands the work downstream of it. Marking that now is
          // what stops a dead swarm from looking like it is still progressing.
          const stranded = new Set(unreachableTasks(settled).map((task) => task.id));
          return {
            ...settled,
            tasks: settled.tasks.map((task) =>
              stranded.has(task.id) ? { ...task, status: "blocked" as const } : task,
            ),
          };
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
      mutate((swarms, at) =>
        updateSwarm(swarms, input.swarmId, at, (swarm) => {
          const detail = input.detail.trim();
          const settled = updateTask(swarm, input.taskId, (task) => ({
            ...task,
            status: "failed" as const,
            ...(detail ? { detail } : {}),
          }));
          const stranded = new Set(unreachableTasks(settled).map((task) => task.id));
          return {
            ...settled,
            tasks: settled.tasks.map((task) =>
              stranded.has(task.id) ? { ...task, status: "blocked" as const } : task,
            ),
          };
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
    } satisfies SwarmRegistry["Service"];
  });

export const layer = (
  filePath: string,
): Layer.Layer<SwarmRegistry, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(SwarmRegistry, make(filePath));
