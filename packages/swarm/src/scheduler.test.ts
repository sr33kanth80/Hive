import { assert, describe, it } from "@effect/vitest";
import type { ProjectId } from "@t3tools/contracts";

import type { Swarm, SwarmTask, SwarmTaskStatus } from "./schema.ts";
import {
  criticalPathLength,
  isSettled,
  runnableTasks,
  swarmProgress,
  unreachableTasks,
  validateTaskGraph,
} from "./scheduler.ts";

function task(
  id: string,
  dependsOn: ReadonlyArray<string> = [],
  status: SwarmTaskStatus = "pending",
): SwarmTask {
  return { id, title: `do ${id}`, dependsOn, status, threadId: null };
}

function swarm(tasks: ReadonlyArray<SwarmTask>): Swarm {
  return {
    id: "swarm-1",
    projectId: "project-1" as ProjectId,
    goal: "ship the thing",
    status: "running",
    tasks,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("validateTaskGraph", () => {
  it("accepts a plan whose dependencies all resolve", () => {
    assert.deepStrictEqual(validateTaskGraph([task("a"), task("b", ["a"])]), []);
  });

  it("rejects a dependency on a task that is not in the swarm", () => {
    const problems = validateTaskGraph([task("a", ["ghost"])]);
    assert.strictEqual(problems.length, 1);
    assert.strictEqual(problems[0]?.kind, "unknown-dependency");
  });

  it("rejects a task depending on itself", () => {
    const problems = validateTaskGraph([task("a", ["a"])]);
    assert.strictEqual(problems[0]?.kind, "self-dependency");
  });

  it("catches a cycle before it can wait forever at runtime", () => {
    // Every task in a cycle blocks on another, so nothing ever becomes
    // runnable and the swarm just looks slow.
    const problems = validateTaskGraph([task("a", ["c"]), task("b", ["a"]), task("c", ["b"])]);
    assert.isTrue(problems.some((problem) => problem.kind === "cycle"));
  });

  it("does not mistake a diamond for a cycle", () => {
    // a → b, a → c, both → d. Two paths to the same task is not a loop.
    const problems = validateTaskGraph([
      task("a"),
      task("b", ["a"]),
      task("c", ["a"]),
      task("d", ["b", "c"]),
    ]);
    assert.deepStrictEqual(problems, []);
  });
});

describe("runnableTasks", () => {
  it("starts everything with no dependencies at once", () => {
    // The whole point of a swarm: independent work runs in parallel.
    const runnable = runnableTasks(swarm([task("a"), task("b"), task("c")]));
    assert.deepStrictEqual(
      runnable.map((entry) => entry.id),
      ["a", "b", "c"],
    );
  });

  it("holds a task until every dependency is done", () => {
    const held = swarm([task("a", [], "done"), task("b", [], "running"), task("c", ["a", "b"])]);
    assert.deepStrictEqual(runnableTasks(held), []);

    const released = swarm([task("a", [], "done"), task("b", [], "done"), task("c", ["a", "b"])]);
    assert.deepStrictEqual(
      runnableTasks(released).map((entry) => entry.id),
      ["c"],
    );
  });

  it("does not re-run tasks that already started or finished", () => {
    const started = swarm([task("a", [], "running"), task("b", [], "done")]);
    assert.deepStrictEqual(runnableTasks(started), []);
  });
});

describe("unreachableTasks", () => {
  it("marks work that can never run because a dependency failed", () => {
    const broken = swarm([task("a", [], "failed"), task("b", ["a"]), task("c", ["b"])]);
    assert.deepStrictEqual(
      unreachableTasks(broken).map((entry) => entry.id),
      ["b", "c"],
    );
  });

  it("leaves tasks alone while their dependencies are still in flight", () => {
    const inFlight = swarm([task("a", [], "running"), task("b", ["a"])]);
    assert.deepStrictEqual(unreachableTasks(inFlight), []);
  });

  it("does not condemn independent work when one branch fails", () => {
    const partial = swarm([task("a", [], "failed"), task("b", ["a"]), task("c")]);
    assert.deepStrictEqual(
      unreachableTasks(partial).map((entry) => entry.id),
      ["b"],
    );
  });
});

describe("isSettled", () => {
  it("is not settled while work can still start", () => {
    assert.isFalse(isSettled(swarm([task("a")])));
  });

  it("is not settled while a task is running", () => {
    assert.isFalse(isSettled(swarm([task("a", [], "running")])));
  });

  it("is settled once everything finished", () => {
    assert.isTrue(isSettled(swarm([task("a", [], "done"), task("b", ["a"], "done")])));
  });

  it("is settled when the remainder is unreachable", () => {
    // Nothing is running and nothing can start, so the swarm is over even
    // though a task never got its turn.
    assert.isTrue(isSettled(swarm([task("a", [], "failed"), task("b", ["a"])])));
  });
});

describe("criticalPathLength", () => {
  it("is one when everything is independent", () => {
    // Ten parallel tasks still only take one task's worth of time.
    assert.strictEqual(criticalPathLength([task("a"), task("b"), task("c")]), 1);
  });

  it("counts the longest chain, not the task count", () => {
    // a → b → c is three deep; d rides alongside and does not extend it.
    const tasks = [task("a"), task("b", ["a"]), task("c", ["b"]), task("d")];
    assert.strictEqual(criticalPathLength(tasks), 3);
  });

  it("follows the longer side of a diamond", () => {
    const tasks = [
      task("a"),
      task("b", ["a"]),
      task("c", ["b"]),
      task("d", ["a"]),
      task("e", ["c", "d"]),
    ];
    assert.strictEqual(criticalPathLength(tasks), 4);
  });
});

describe("swarmProgress", () => {
  it("counts each status so a swarm can report itself", () => {
    const mixed = swarm([
      task("a", [], "done"),
      task("b", [], "running"),
      task("c", [], "failed"),
      task("d", ["c"], "blocked"),
      task("e"),
    ]);
    assert.deepStrictEqual(swarmProgress(mixed), {
      total: 5,
      done: 1,
      running: 1,
      failed: 1,
      blocked: 1,
      pending: 1,
    });
  });
});
