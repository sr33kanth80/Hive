// HIVE: decides what a swarm may run right now.
//
// Pure functions over swarm state. No spawning, no I/O, no clock — given a set
// of tasks and their statuses, say which are runnable, which are waiting, and
// which can never run. Keeping this pure is what makes the interesting part
// (the ordering) testable without agents, worktrees, or git.

import type { Swarm, SwarmTask, SwarmTaskId, SwarmTaskStatus } from "./schema.ts";

export interface GraphProblem {
  readonly kind: "unknown-dependency" | "self-dependency" | "cycle";
  readonly taskId: SwarmTaskId;
  readonly detail: string;
}

/**
 * Reject a plan before it runs rather than discovering it is unrunnable
 * halfway through. A cycle is the case that matters: every task in it waits
 * forever, and from the outside the swarm simply looks slow.
 */
export function validateTaskGraph(tasks: ReadonlyArray<SwarmTask>): ReadonlyArray<GraphProblem> {
  const problems: GraphProblem[] = [];
  const byId = new Map(tasks.map((task) => [task.id, task]));

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        problems.push({
          kind: "self-dependency",
          taskId: task.id,
          detail: "A task cannot depend on itself.",
        });
        continue;
      }
      if (!byId.has(dependency)) {
        problems.push({
          kind: "unknown-dependency",
          taskId: task.id,
          detail: `Depends on "${dependency}", which is not in this swarm.`,
        });
      }
    }
  }

  // Depth-first search with an explicit colour map: white unvisited, grey on
  // the current path, black finished. Meeting grey means the path looped.
  const state = new Map<SwarmTaskId, "grey" | "black">();
  const reported = new Set<SwarmTaskId>();

  const walk = (taskId: SwarmTaskId, path: ReadonlyArray<SwarmTaskId>): void => {
    const colour = state.get(taskId);
    if (colour === "black") return;
    if (colour === "grey") {
      const loop = [...path.slice(path.indexOf(taskId)), taskId].join(" → ");
      if (!reported.has(taskId)) {
        reported.add(taskId);
        problems.push({ kind: "cycle", taskId, detail: `Dependency cycle: ${loop}` });
      }
      return;
    }
    state.set(taskId, "grey");
    for (const dependency of byId.get(taskId)?.dependsOn ?? []) {
      if (byId.has(dependency)) walk(dependency, [...path, taskId]);
    }
    state.set(taskId, "black");
  };

  for (const task of tasks) walk(task.id, []);
  return problems;
}

const TERMINAL: ReadonlySet<SwarmTaskStatus> = new Set(["done", "failed", "blocked"]);

/** Tasks whose dependencies have all completed successfully. */
export function runnableTasks(swarm: Swarm): ReadonlyArray<SwarmTask> {
  const statuses = new Map(swarm.tasks.map((task) => [task.id, task.status]));
  return swarm.tasks.filter(
    (task) =>
      task.status === "pending" &&
      task.dependsOn.every((dependency) => statuses.get(dependency) === "done"),
  );
}

/**
 * Tasks that can never run, because something they depend on failed or was
 * itself blocked. Returned so a swarm can mark them rather than leaving them
 * pending forever.
 */
export function unreachableTasks(swarm: Swarm): ReadonlyArray<SwarmTask> {
  const byId = new Map(swarm.tasks.map((task) => [task.id, task]));
  const verdicts = new Map<SwarmTaskId, boolean>();

  const isUnreachable = (taskId: SwarmTaskId, path: ReadonlySet<SwarmTaskId>): boolean => {
    const cached = verdicts.get(taskId);
    if (cached !== undefined) return cached;
    // A cycle cannot complete, so treat it as unreachable rather than recursing.
    if (path.has(taskId)) return true;

    const task = byId.get(taskId);
    if (task === undefined) return true;
    if (task.status === "failed" || task.status === "blocked") return true;
    if (task.status === "done" || task.status === "running") return false;

    const nextPath = new Set(path).add(taskId);
    const verdict = task.dependsOn.some((dependency) => isUnreachable(dependency, nextPath));
    verdicts.set(taskId, verdict);
    return verdict;
  };

  return swarm.tasks.filter(
    (task) => task.status === "pending" && isUnreachable(task.id, new Set()),
  );
}

/** A swarm is settled once no task is running and none can still start. */
export function isSettled(swarm: Swarm): boolean {
  const anyActive = swarm.tasks.some((task) => task.status === "running");
  return !anyActive && runnableTasks(swarm).length === 0;
}

export interface SwarmProgress {
  readonly total: number;
  readonly done: number;
  readonly running: number;
  readonly failed: number;
  readonly blocked: number;
  readonly pending: number;
}

export function swarmProgress(swarm: Swarm): SwarmProgress {
  const count = (status: SwarmTaskStatus) =>
    swarm.tasks.filter((task) => task.status === status).length;
  return {
    total: swarm.tasks.length,
    done: count("done"),
    running: count("running"),
    failed: count("failed"),
    blocked: count("blocked"),
    pending: count("pending"),
  };
}

/**
 * The longest chain of dependencies, which is the floor on how long a swarm can
 * take no matter how many agents run at once. Worth surfacing: it is the
 * honest answer to "how much will parallelism buy me here?"
 */
export function criticalPathLength(tasks: ReadonlyArray<SwarmTask>): number {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const depth = new Map<SwarmTaskId, number>();

  const measure = (taskId: SwarmTaskId, path: ReadonlySet<SwarmTaskId>): number => {
    if (path.has(taskId)) return 0;
    const cached = depth.get(taskId);
    if (cached !== undefined) return cached;
    const task = byId.get(taskId);
    if (task === undefined) return 0;
    const nextPath = new Set(path).add(taskId);
    const longest = task.dependsOn.reduce(
      (best, dependency) => Math.max(best, measure(dependency, nextPath)),
      0,
    );
    const value = longest + 1;
    depth.set(taskId, value);
    return value;
  };

  return tasks.reduce((best, task) => Math.max(best, measure(task.id, new Set())), 0);
}

/** Terminal statuses, exported so callers agree on what "finished" means. */
export function isTerminal(status: SwarmTaskStatus): boolean {
  return TERMINAL.has(status);
}
