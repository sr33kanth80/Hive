// HIVE: client-side access to conflict predictions.
//
// Predictions run a real git merge per thread pair on the server, so this is
// deliberately not a fast-polling query. It refreshes on a slow interval and
// goes stale quickly enough that reopening a view re-asks.

import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createHiveEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    conflicts: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:hive:conflicts",
      tag: WS_METHODS.hiveConflictsList,
      // Branches change when a turn settles, not continuously, so a short
      // stale window with an occasional refresh is enough. Each refresh costs
      // one git merge-tree per pair of threads.
      staleTimeMs: 15_000,
      refreshIntervalMs: 60_000,
    }),

    /**
     * Swarms change when a task starts or finishes, which is frequent while one
     * is running and never once it settles. A short stale window with a steady
     * refresh keeps the view live without polling hard.
     */
    swarms: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:hive:swarms",
      tag: WS_METHODS.hiveSwarmsList,
      staleTimeMs: 2_000,
      refreshIntervalMs: 5_000,
    }),

    createSwarm: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:hive:create-swarm",
      tag: WS_METHODS.hiveSwarmsCreate,
    }),
  };
}
