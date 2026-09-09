// HIVE: turns a swarm plan into running agents.
//
// For every task whose dependencies are satisfied, this creates an isolated
// worktree, opens a thread in it, and starts a turn with the task as the
// prompt. Independent tasks launch together; dependent ones wait their turn.
//
// Isolation is not optional here. Agents fanned out of one plan reach for the
// same files, so each task gets its own worktree and branch — which is also
// what makes conflict prediction able to say anything useful about them.

import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  defaultInstanceIdForDriver,
  MessageId,
  ProviderDriverKind,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import { SwarmRegistry } from "@t3tools/swarm/registry";
import type { Swarm, SwarmId, SwarmTask } from "@t3tools/swarm/schema";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export interface LaunchedTask {
  readonly taskId: string;
  readonly threadId: ThreadId;
  readonly branch: string;
}

export class SwarmExecutor extends Context.Service<
  SwarmExecutor,
  {
    /**
     * Start every task the plan currently allows. Safe to call repeatedly —
     * tasks already running or finished are not runnable, so a second call
     * launches only what a completion has since unblocked.
     */
    readonly launchRunnable: (swarmId: SwarmId) => Effect.Effect<ReadonlyArray<LaunchedTask>>;
  }
>()("t3/hive/SwarmExecutor") {}

/** Branch names must survive git and a filesystem, so keep them boring. */
export function swarmBranchName(swarmId: string, taskId: string): string {
  const slug = (value: string) =>
    value
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, "-")
      .replaceAll(/^-+|-+$/gu, "")
      .slice(0, 32);
  return `hive/${slug(swarmId) || "swarm"}/${slug(taskId) || "task"}`;
}

export const make = Effect.gen(function* () {
  const registry = yield* SwarmRegistry;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const crypto = yield* Crypto.Crypto;

  const commandId = (label: string) =>
    Effect.map(crypto.randomUUIDv4, (id) => CommandId.make(`swarm-${label}-${id}`));

  const launchTask = Effect.fn("SwarmExecutor.launchTask")(function* (input: {
    readonly swarm: Swarm;
    readonly task: SwarmTask;
    readonly projectCwd: string;
    readonly modelSelection: ModelSelection;
  }) {
    const branch = swarmBranchName(input.swarm.id, input.task.id);

    // The worktree is created before the thread so the thread is born with its
    // branch and path already set. ws.ts creates the thread first and patches
    // them on afterwards, which leaves a window where the thread has neither;
    // there is no reason to reproduce that here.
    const worktree = yield* gitWorkflow.createWorktree({
      cwd: input.projectCwd,
      refName: "HEAD",
      newRefName: branch,
      path: null,
    });

    const threadId = ThreadId.make(yield* crypto.randomUUIDv4);
    const createdAt = yield* nowIso;

    yield* engine.dispatch({
      type: "thread.create",
      commandId: yield* commandId("thread-create"),
      threadId,
      projectId: input.swarm.projectId,
      title: input.task.title,
      modelSelection: input.modelSelection,
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: worktree.worktree.refName,
      worktreePath: worktree.worktree.path,
      createdAt,
    });

    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: yield* commandId("turn-start"),
      threadId,
      message: {
        messageId: MessageId.make(`swarm-${input.task.id}-${yield* crypto.randomUUIDv4}`),
        role: "user",
        text: input.task.title,
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      createdAt,
    });

    yield* registry.markRunning({
      swarmId: input.swarm.id,
      taskId: input.task.id,
      threadId,
    });

    return { taskId: input.task.id, threadId, branch } satisfies LaunchedTask;
  });

  const launchRunnable: SwarmExecutor["Service"]["launchRunnable"] = (swarmId) =>
    Effect.gen(function* () {
      const swarm = yield* registry.get(swarmId);
      if (swarm === null) return [];

      const runnable = yield* registry.claimRunnable(swarmId);
      if (runnable.length === 0) return [];

      const snapshot = yield* Effect.orDie(snapshots.getShellSnapshot());
      const project = snapshot.projects.find((entry) => entry.id === swarm.projectId);
      if (project === undefined) {
        yield* Effect.logWarning("hive swarm has no project to run in", {
          swarmId,
          projectId: swarm.projectId,
        });
        return [];
      }

      // Pinned at creation, so a wave of dependent tasks launching minutes
      // later runs on the provider the developer picked rather than whatever
      // the project default happens to say by then.
      const provider = ProviderDriverKind.make("codex");
      const modelSelection: ModelSelection = swarm.modelSelection ??
        project.defaultModelSelection ?? {
          instanceId: defaultInstanceIdForDriver(provider),
          model: DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL,
        };

      // Tasks are launched one at a time even though they will run in
      // parallel: `git worktree add` mutates shared repository state, so
      // racing it is how you get a corrupt index rather than faster startup.
      const launched: LaunchedTask[] = [];
      for (const task of runnable) {
        const result = yield* launchTask({
          swarm,
          task,
          projectCwd: project.workspaceRoot,
          modelSelection,
        }).pipe(
          // One task failing to start must not strand the rest of the wave.
          Effect.catchCause((cause) =>
            Effect.logWarning("hive swarm task failed to launch", {
              swarmId,
              taskId: task.id,
              cause: String(cause),
            }).pipe(Effect.as(null)),
          ),
        );
        if (result !== null) launched.push(result);
      }

      return launched;
    });

  return { launchRunnable } satisfies SwarmExecutor["Service"];
});

export const layer = Layer.effect(SwarmExecutor, make);
