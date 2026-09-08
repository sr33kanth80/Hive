// HIVE: the entry point for creating and inspecting swarms.
//
// Thin by design: the registry owns state, the scheduler owns ordering, the
// executor owns spawning. This exists so the RPC layer has one thing to call
// and so an invalid plan is refused with an error a client can render.

import {
  HiveSwarmPlanInvalidError,
  type HiveSwarmCreateInput,
  type HiveSwarmCreateResult,
  type HiveSwarmsListResult,
  type ProjectId,
} from "@t3tools/contracts";
import { SwarmRegistry } from "@t3tools/swarm/registry";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
  }
>()("t3/hive/SwarmService") {}

export const make = Effect.gen(function* () {
  const registry = yield* SwarmRegistry;
  const executor = yield* SwarmExecutor;
  const crypto = yield* Crypto.Crypto;

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

  const listForProject: SwarmService["Service"]["listForProject"] = (input) =>
    Effect.map(registry.listForProject(input.projectId), (swarms) => ({ swarms }));

  return { create, listForProject } satisfies SwarmService["Service"];
});

export const layer = Layer.effect(SwarmService, make);
