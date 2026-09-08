// HIVE: the domain of a swarm — one goal, many agents, an explicit ordering.
//
// A swarm is the unit Hive actually schedules: a developer's prompt broken into
// tasks, where some can run at once and others must wait. The dependency edges
// are the whole point. Without them a swarm is just N unrelated threads, and
// with them it is a plan that can be executed as fast as its critical path
// allows.

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const SwarmId = TrimmedNonEmptyString;
export type SwarmId = typeof SwarmId.Type;

export const SwarmTaskId = TrimmedNonEmptyString;
export type SwarmTaskId = typeof SwarmTaskId.Type;

/**
 * `blocked` is deliberately distinct from `pending`. A task waiting its turn and
 * a task that can never run because something it needed failed are different
 * situations, and collapsing them leaves a swarm that looks busy forever.
 */
export const SwarmTaskStatus = Schema.Literals(["pending", "running", "done", "failed", "blocked"]);
export type SwarmTaskStatus = typeof SwarmTaskStatus.Type;

export const SwarmTask = Schema.Struct({
  id: SwarmTaskId,
  /** What the agent is asked to do. Becomes the thread's opening prompt. */
  title: TrimmedNonEmptyString,
  /** Tasks that must reach `done` before this one may start. */
  dependsOn: Schema.Array(SwarmTaskId),
  status: SwarmTaskStatus,
  /** Set once the task has been given a thread to run in. */
  threadId: Schema.NullOr(ThreadId),
});
export type SwarmTask = typeof SwarmTask.Type;

export const SwarmStatus = Schema.Literals(["planning", "running", "settled"]);
export type SwarmStatus = typeof SwarmStatus.Type;

export const Swarm = Schema.Struct({
  id: SwarmId,
  projectId: ProjectId,
  /** The developer's original prompt, kept so the swarm can explain itself. */
  goal: TrimmedNonEmptyString,
  status: SwarmStatus,
  tasks: Schema.Array(SwarmTask),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Swarm = typeof Swarm.Type;

export const SwarmStoreFile = Schema.Struct({
  version: Schema.Literal(1),
  swarms: Schema.Array(Swarm),
});
export type SwarmStoreFile = typeof SwarmStoreFile.Type;

export const EMPTY_SWARM_STORE: SwarmStoreFile = { version: 1, swarms: [] };
