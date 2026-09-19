// HIVE: client-side access to conflict predictions.
//
// Predictions run a real git merge per thread pair on the server, so this is
// deliberately not a fast-polling query. It refreshes on a slow interval and
// goes stale quickly enough that reopening a view re-asks.

import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

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
     * is running and never once it settles. That last part is why this is a
     * subscription rather than a poll: settling is the final thing a swarm does,
     * so a poll interval is pure latency on the transition that matters most,
     * with nothing afterwards to correct a stale view.
     */
    swarms: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:hive:swarms",
      tag: WS_METHODS.hiveSwarmsSubscribe,
    }),

    createSwarm: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:hive:create-swarm",
      tag: WS_METHODS.hiveSwarmsCreate,
    }),

    /** Swarm mode from the composer: one prompt in, a planned swarm out. */
    createSwarmFromPrompt: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:hive:create-swarm-from-prompt",
      tag: WS_METHODS.hiveSwarmsFromPrompt,
    }),
  };
}
