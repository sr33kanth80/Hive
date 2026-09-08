import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { make } from "./registry.ts";
import { loadSwarms, swarmFilePath } from "./store.ts";

const PROJECT = "project-1" as ProjectId;

const makeRegistryInTempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "hive-swarm-test-" });
  const filePath = yield* swarmFilePath(stateDir);
  const registry = yield* make(filePath);
  return { registry, filePath };
});

/** A three-task plan: two independent, one that waits for both. */
const fanOutPlan = {
  id: "swarm-1",
  projectId: PROJECT,
  goal: "migrate the api",
  tasks: [
    { id: "a", title: "migrate routes" },
    { id: "b", title: "migrate handlers" },
    { id: "c", title: "update the docs", dependsOn: ["a", "b"] },
  ],
};

describe("SwarmRegistry", () => {
  it.effect("starts independent work together and holds dependent work back", () =>
    Effect.gen(function* () {
      const { registry } = yield* makeRegistryInTempDir;
      yield* registry.create(fanOutPlan);

      const first = yield* registry.claimRunnable("swarm-1");
      assert.deepStrictEqual(
        first.map((task) => task.id),
        ["a", "b"],
      );

      yield* registry.markRunning({
        swarmId: "swarm-1",
        taskId: "a",
        threadId: "thread-a" as ThreadId,
      });
      yield* registry.markFinished({ swarmId: "swarm-1", taskId: "a", status: "done" });

      // b is still outstanding, so c must keep waiting.
      assert.deepStrictEqual(
        (yield* registry.claimRunnable("swarm-1")).map((task) => task.id),
        ["b"],
      );

      yield* registry.markRunning({
        swarmId: "swarm-1",
        taskId: "b",
        threadId: "thread-b" as ThreadId,
      });
      yield* registry.markFinished({ swarmId: "swarm-1", taskId: "b", status: "done" });

      assert.deepStrictEqual(
        (yield* registry.claimRunnable("swarm-1")).map((task) => task.id),
        ["c"],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("blocks work stranded by a failure instead of leaving it pending", () =>
    Effect.gen(function* () {
      const { registry } = yield* makeRegistryInTempDir;
      yield* registry.create(fanOutPlan);

      yield* registry.markRunning({
        swarmId: "swarm-1",
        taskId: "a",
        threadId: "thread-a" as ThreadId,
      });
      yield* registry.markFinished({ swarmId: "swarm-1", taskId: "a", status: "failed" });

      const swarm = yield* registry.get("swarm-1");
      const c = swarm?.tasks.find((task) => task.id === "c");
      // c depended on the failed task, so it can never run. Saying so is what
      // stops a dead swarm from looking like it is still working.
      assert.strictEqual(c?.status, "blocked");
      // b was independent and is unaffected.
      assert.strictEqual(swarm?.tasks.find((task) => task.id === "b")?.status, "pending");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses a plan containing a dependency cycle", () =>
    Effect.gen(function* () {
      const { registry } = yield* makeRegistryInTempDir;
      // Effect.option turns the failure into None, which is enough to assert
      // the plan was rejected without naming the error type.
      const result = yield* Effect.option(
        registry.create({
          id: "swarm-cycle",
          projectId: PROJECT,
          goal: "impossible",
          tasks: [
            { id: "a", title: "a", dependsOn: ["b"] },
            { id: "b", title: "b", dependsOn: ["a"] },
          ],
        }),
      );
      assert.strictEqual(result._tag, "None");
      assert.deepStrictEqual(yield* registry.list, []);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("maps a thread back to the task it is running", () =>
    Effect.gen(function* () {
      const { registry } = yield* makeRegistryInTempDir;
      yield* registry.create(fanOutPlan);
      yield* registry.markRunning({
        swarmId: "swarm-1",
        taskId: "b",
        threadId: "thread-b" as ThreadId,
      });

      const found = yield* registry.findByThread("thread-b" as ThreadId);
      assert.strictEqual(found?.task.id, "b");
      assert.strictEqual(found?.swarm.id, "swarm-1");

      assert.isNull(yield* registry.findByThread("thread-unknown" as ThreadId));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("survives a restart with task state intact", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "hive-swarm-test-" });
      const filePath = yield* swarmFilePath(stateDir);

      const first = yield* make(filePath);
      yield* first.create(fanOutPlan);
      yield* first.markRunning({
        swarmId: "swarm-1",
        taskId: "a",
        threadId: "thread-a" as ThreadId,
      });

      // Half-finished parallel work is exactly the state that must not be lost.
      const second = yield* make(filePath);
      const swarm = yield* second.get("swarm-1");
      assert.strictEqual(swarm?.tasks.find((task) => task.id === "a")?.status, "running");
      assert.strictEqual(swarm?.tasks.find((task) => task.id === "a")?.threadId, "thread-a");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("quarantines a corrupt store rather than failing to start", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "hive-swarm-test-" });
      const filePath = yield* swarmFilePath(stateDir);
      yield* fs.makeDirectory(
        filePath.slice(0, Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"))),
        { recursive: true },
      );
      yield* fs.writeFileString(filePath, "{ not json at all");

      const loaded = yield* loadSwarms(filePath);
      assert.deepStrictEqual(loaded.swarms, []);

      const registry = yield* make(filePath);
      yield* registry.create(fanOutPlan);
      assert.strictEqual((yield* registry.list).length, 1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
