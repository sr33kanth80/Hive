// HIVE: the entry point for creating and inspecting swarms.
//
// Thin by design: the registry owns state, the scheduler owns ordering, the
// executor owns spawning. This exists so the RPC layer has one thing to call
// and so an invalid plan is refused with an error a client can render.

import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  HiveSwarmPlanInvalidError,
  ProviderDriverKind,
  type HiveSwarmCreateInput,
  type HiveSwarmCreateResult,
  type HiveSwarmFromPromptInput,
  type HiveSwarmsListResult,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import { SwarmRegistry } from "@t3tools/swarm/registry";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { SwarmExecutor } from "./SwarmExecutor.ts";

export class SwarmService extends Context.Service<
  SwarmService,
  {
    readonly create: (
      input: HiveSwarmCreateInput,
    ) => Effect.Effect<HiveSwarmCreateResult, HiveSwarmPlanInvalidError>;
    readonly listForProject: (input: {
      readonly projectId: ProjectId;
    }) => Effect.Effect<HiveSwarmsListResult>;
    /**
     * Swarm mode from the composer: plan the prompt, then run it. A prompt the
     * planner declines to split becomes a single task, which behaves exactly
     * like an ordinary thread.
     */
    readonly createFromPrompt: (
      input: HiveSwarmFromPromptInput,
    ) => Effect.Effect<HiveSwarmCreateResult, HiveSwarmPlanInvalidError>;
  }
>()("t3/hive/SwarmService") {}

export const make = Effect.gen(function* () {
  const registry = yield* SwarmRegistry;
  const executor = yield* SwarmExecutor;
  const crypto = yield* Crypto.Crypto;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const create: SwarmService["Service"]["create"] = (input) =>
    Effect.gen(function* () {
      // A failing id generator is a defect, not something a client can act on,
      // and the RPC error channel carries only plan problems.
      const id = `swarm-${yield* Effect.orDie(crypto.randomUUIDv4)}`;

      const created = yield* registry
        .create({
          id,
          projectId: input.projectId,
          goal: input.goal,
          tasks: input.tasks.map((task) => ({
            id: task.id,
            title: task.title,
            ...(task.dependsOn === undefined ? {} : { dependsOn: task.dependsOn }),
          })),
          ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
        })
        // An unrunnable plan is a client mistake worth naming, not a defect.
        .pipe(
          Effect.mapError(
            (error) => new HiveSwarmPlanInvalidError({ detail: error.message || "Invalid plan." }),
          ),
        );

      // Storing without launching lets a plan be reviewed before agents start.
      if (input.launch === false) {
        return { swarm: created, launchedTaskIds: [] } satisfies HiveSwarmCreateResult;
      }

      const launched = yield* executor.launchRunnable(id);
      const swarm = (yield* registry.get(id)) ?? created;
      return {
        swarm,
        launchedTaskIds: launched.map((entry) => entry.taskId),
      } satisfies HiveSwarmCreateResult;
    });

  const createFromPrompt: SwarmService["Service"]["createFromPrompt"] = (input) =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.orDie(snapshots.getShellSnapshot());
      const project = snapshot.projects.find((entry) => entry.id === input.projectId);
      if (project === undefined) {
        return yield* Effect.fail(
          new HiveSwarmPlanInvalidError({ detail: "That project is no longer available." }),
        );
      }

      // The composer's picker wins. It is what the developer can actually see
      // and change; the project default is only a fallback for callers that
      // have no picker, and hardcoded codex only for a project without one.
      const provider = ProviderDriverKind.make("codex");
      const modelSelection: ModelSelection = input.modelSelection ??
        project.defaultModelSelection ?? {
          instanceId: defaultInstanceIdForDriver(provider),
          model: DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL,
        };

      // A planner that cannot answer must not block the request: falling back
      // to one task means swarm mode degrades to an ordinary thread rather
      // than refusing to run.
      const plan = yield* textGeneration
        .generateSwarmPlan({
          cwd: project.workspaceRoot,
          message: input.prompt,
          modelSelection,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("hive swarm planning failed; running as one task", {
              cause: String(cause),
            }).pipe(Effect.as(TextGeneration.singleTaskSwarmPlan(input.prompt))),
          ),
        );

      return yield* create({
        projectId: input.projectId,
        goal: input.prompt,
        tasks: plan.tasks.map((task) => ({
          id: task.id,
          title: task.title,
          dependsOn: task.dependsOn,
        })),
        modelSelection,
      });
    });

  const listForProject: SwarmService["Service"]["listForProject"] = (input) =>
    Effect.map(registry.listForProject(input.projectId), (swarms) => ({ swarms }));

  return { create, createFromPrompt, listForProject } satisfies SwarmService["Service"];
});

export const layer = Layer.effect(SwarmService, make);
