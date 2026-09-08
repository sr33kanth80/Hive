// HIVE: the domain of a swarm — one goal, many agents, an explicit ordering.
//
// The shapes themselves live in @t3tools/contracts because they cross the wire.
// Defining them twice would let the two copies drift, so this module re-exports
// them and adds only what stays on the server: the store file.

import { HiveSwarm, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export {
  HiveSwarm as Swarm,
  HiveSwarmStatus as SwarmStatus,
  HiveSwarmTask as SwarmTask,
  HiveSwarmTaskId as SwarmTaskId,
  HiveSwarmTaskStatus as SwarmTaskStatus,
} from "@t3tools/contracts";

export const SwarmId = TrimmedNonEmptyString;
export type SwarmId = typeof SwarmId.Type;

export const SwarmStoreFile = Schema.Struct({
  version: Schema.Literal(1),
  swarms: Schema.Array(HiveSwarm),
});
export type SwarmStoreFile = typeof SwarmStoreFile.Type;

export const EMPTY_SWARM_STORE: SwarmStoreFile = { version: 1, swarms: [] };
