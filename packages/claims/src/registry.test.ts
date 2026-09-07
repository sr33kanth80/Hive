import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { make } from "./registry.ts";
import { loadStore, ownershipFilePath } from "./store.ts";

const threadA = "thread-a" as ThreadId;
const threadB = "thread-b" as ThreadId;

/** A registry rooted in a scoped temp dir, mirroring how the server derives it. */
const makeRegistryInTempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "hive-claims-test-" });
  const filePath = yield* ownershipFilePath(stateDir);
  const registry = yield* make(filePath);
  return { registry, filePath };
});

describe("claims registry", () => {
  it.effect("reports both threads and pairs them when their files overlap", () =>
    Effect.gen(function* () {
      const { registry } = yield* makeRegistryInTempDir;

      yield* registry.claimFiles({
        threadId: threadA,
        files: ["src/auth.ts", "src/util.ts"],
        filesSource: "diff",
      });
      yield* registry.claimFiles({
        threadId: threadB,
        files: ["./src/auth.ts", "docs/readme.md"],
        filesSource: "diff",
      });

      const active = yield* registry.active;
      assert.strictEqual(active.length, 2);

      // A thread never collides with itself.
      const own = yield* registry.overlaps({
        files: ["src/auth.ts"],
        excludeThreadId: threadA,
      });
      assert.deepStrictEqual(
        own.map((claim) => claim.threadId),
        [threadB],
      );

      const none = yield* registry.overlaps({ files: ["src/untouched.ts"] });
      assert.deepStrictEqual(none, []);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("accumulates files across turns instead of replacing them", () =>
    Effect.gen(function* () {
      const { registry } = yield* makeRegistryInTempDir;

      yield* registry.claimFiles({ threadId: threadA, files: ["a.ts"], filesSource: "diff" });
      yield* registry.claimFiles({ threadId: threadA, files: ["b.ts"], filesSource: "diff" });

      const [claim] = yield* registry.active;
      assert.deepStrictEqual(claim?.files, ["a.ts", "b.ts"]);
      assert.strictEqual(claim?.turnCount, 2);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("marks a released thread stale and only gc removes it", () =>
    Effect.gen(function* () {
      const { registry } = yield* makeRegistryInTempDir;

      yield* registry.claimFiles({ threadId: threadA, files: ["a.ts"], filesSource: "diff" });
      yield* registry.release(threadA);

      const active = yield* registry.active;
      assert.deepStrictEqual(active, []);

      const all = yield* registry.all;
      assert.strictEqual(all[0]?.status, "stale");

      // A young stale claim survives; an expired one is collected.
      assert.strictEqual(yield* registry.gc(60_000), 0);
      assert.strictEqual(yield* registry.gc(0), 1);
      assert.deepStrictEqual(yield* registry.all, []);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("records that a turn's diff was unavailable rather than claiming nothing", () =>
    Effect.gen(function* () {
      const { registry } = yield* makeRegistryInTempDir;

      yield* registry.claimFiles({
        threadId: threadA,
        files: [],
        filesSource: "diff-unavailable",
      });

      const [claim] = yield* registry.all;
      assert.strictEqual(claim?.filesSource, "diff-unavailable");
      assert.deepStrictEqual(claim?.files, []);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("survives a restart by reloading the persisted registry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "hive-claims-test-" });
      const filePath = yield* ownershipFilePath(stateDir);

      const first = yield* make(filePath);
      yield* first.claimFiles({
        threadId: threadA,
        files: ["src/a.ts"],
        filesSource: "diff",
      });

      // A second instance over the same path is what a server restart looks like.
      const second = yield* make(filePath);
      const active = yield* second.active;
      assert.strictEqual(active.length, 1);
      assert.deepStrictEqual(active[0]?.files, ["src/a.ts"]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("writes a registry that always reads back as valid", () =>
    Effect.gen(function* () {
      const { registry, filePath } = yield* makeRegistryInTempDir;

      yield* Effect.forEach(
        Array.from({ length: 50 }, (_, index) => index),
        (index) =>
          registry.claimFiles({
            threadId: (index % 2 === 0 ? threadA : threadB) as ThreadId,
            files: [`src/file-${index}.ts`],
            filesSource: "diff",
          }),
        { discard: true },
      );

      const reloaded = yield* loadStore(filePath);
      assert.strictEqual(reloaded.version, 1);
      assert.strictEqual(reloaded.claims.length, 2);
      const total = reloaded.claims.reduce((sum, claim) => sum + claim.files.length, 0);
      assert.strictEqual(total, 50);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("treats a worktree path and a main-checkout path as the same file", () =>
    Effect.gen(function* () {
      const { registry } = yield* makeRegistryInTempDir;

      // Git reports repo-root-relative paths, so both checkouts yield one key.
      yield* registry.claimFiles({
        threadId: threadA,
        files: ["src\\auth.ts"],
        filesSource: "diff",
      });
      const overlapping = yield* registry.overlaps({ files: ["./src/auth.ts"] });
      assert.deepStrictEqual(
        overlapping.map((claim) => claim.threadId),
        [threadA],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("claims store resilience", () => {
  it.effect("quarantines a corrupt registry and keeps working", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "hive-claims-test-" });
      const filePath = yield* ownershipFilePath(stateDir);

      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fs.writeFileString(filePath, "{ this is not json");

      // Loading must not fail: a bad state file cannot take the server down.
      const loaded = yield* loadStore(filePath);
      assert.deepStrictEqual(loaded.claims, []);

      const quarantined = yield* fs.readDirectory(path.dirname(filePath));
      assert.isTrue(quarantined.some((entry) => entry.includes(".corrupt-")));

      // And the registry is usable afterwards.
      const registry = yield* make(filePath);
      yield* registry.claimFiles({ threadId: threadA, files: ["a.ts"], filesSource: "diff" });
      assert.strictEqual((yield* registry.active).length, 1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("quarantines a registry that parses but fails schema validation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "hive-claims-test-" });
      const filePath = yield* ownershipFilePath(stateDir);

      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fs.writeFileString(filePath, `{"version":99,"claims":"nope"}`);

      const loaded = yield* loadStore(filePath);
      assert.deepStrictEqual(loaded.claims, []);
      const entries = yield* fs.readDirectory(path.dirname(filePath));
      assert.isTrue(entries.some((entry) => entry.includes(".corrupt-")));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("treats a missing registry as empty rather than an error", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "hive-claims-test-" });
      const filePath = yield* ownershipFilePath(stateDir);
      const loaded = yield* loadStore(filePath);
      assert.deepStrictEqual(loaded, { version: 1, claims: [] });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
