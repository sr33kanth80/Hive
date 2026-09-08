// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import { ConflictDetector, layer, parseConflictedPaths } from "./ConflictDetector.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return NodeChildProcess.execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function write(cwd: string, file: string, contents: string) {
  NodeFS.writeFileSync(NodePath.join(cwd, file), contents, "utf8");
}

/**
 * A repo with three branches off main:
 *   conflicting  — rewrites the same line of shared.txt as `other-edit`
 *   other-edit   — rewrites that line differently
 *   unrelated    — touches a different file entirely
 */
/**
 * The shared file needs genuinely separated regions. Edits on adjacent lines
 * conflict in git because their diff context overlaps, so a three-line fixture
 * cannot express "same file, cleanly merged".
 */
const SHARED_LINES = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);

function sharedWith(edits: ReadonlyMap<number, string>): string {
  return `${SHARED_LINES.map((line, index) => edits.get(index) ?? line).join("\n")}\n`;
}

function seedRepo(cwd: string) {
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  write(cwd, "shared.txt", sharedWith(new Map()));
  write(cwd, "other.txt", "untouched\n");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "initial"]);

  // Same region as `conflicting`, edited differently.
  runGit(cwd, ["checkout", "-b", "other-edit"]);
  write(cwd, "shared.txt", sharedWith(new Map([[3, "EDITED BY OTHER"]])));
  runGit(cwd, ["commit", "-am", "other edits shared"]);

  runGit(cwd, ["checkout", "main"]);
  runGit(cwd, ["checkout", "-b", "unrelated"]);
  write(cwd, "other.txt", "changed elsewhere\n");
  runGit(cwd, ["commit", "-am", "unrelated edits other file"]);

  runGit(cwd, ["checkout", "main"]);
  runGit(cwd, ["checkout", "-b", "conflicting"]);
  write(cwd, "shared.txt", sharedWith(new Map([[3, "EDITED BY MINE"]])));
  runGit(cwd, ["commit", "-am", "mine edits shared"]);

  // Same file, far enough away that git merges it cleanly — the case naive
  // path-overlap detection gets wrong.
  runGit(cwd, ["checkout", "main"]);
  runGit(cwd, ["checkout", "-b", "same-file-clean"]);
  write(cwd, "shared.txt", sharedWith(new Map([[35, "EDITED FAR AWAY"]])));
  runGit(cwd, ["commit", "-am", "clean edit to same file"]);

  runGit(cwd, ["checkout", "conflicting"]);
}

const thread = (value: string): ThreadId => value as ThreadId;

/**
 * One combined layer rather than chained `Effect.provide` calls: chaining them
 * builds separate scopes and can break service lifecycles, which the Effect
 * lint rejects outright.
 */
const testLayer = layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runWith = <A, E>(
  program: Effect.Effect<A, E, ConflictDetector | FileSystem.FileSystem | Scope.Scope>,
) => program.pipe(Effect.provide(testLayer), Effect.scoped);

describe("parseConflictedPaths", () => {
  it("reads the conflicted paths and stops at the informational section", () => {
    const stdout = ["abc123treeoid", "src/a.ts", "src/b.ts", "", "Auto-merging src/a.ts", ""].join(
      "\n",
    );
    assert.deepStrictEqual(parseConflictedPaths(stdout), ["src/a.ts", "src/b.ts"]);
  });

  it("returns nothing when only a tree id was printed", () => {
    assert.deepStrictEqual(parseConflictedPaths("abc123treeoid\n"), []);
  });
});

describe("ConflictDetector", () => {
  it.effect("reports the file two branches genuinely conflict on", () =>
    runWith(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "hive-conflict-test-" });
        seedRepo(cwd);

        const detector = yield* ConflictDetector;
        const predictions = yield* detector.predict({
          cwd,
          branch: "conflicting",
          candidates: [{ threadId: thread("thread-other"), branch: "other-edit" }],
        });

        assert.strictEqual(predictions.length, 1);
        assert.strictEqual(predictions[0]?.threadId, thread("thread-other"));
        assert.deepStrictEqual(predictions[0]?.files, ["shared.txt"]);
      }),
    ),
  );

  it.effect("stays silent when branches touch different files", () =>
    runWith(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "hive-conflict-test-" });
        seedRepo(cwd);

        const detector = yield* ConflictDetector;
        const predictions = yield* detector.predict({
          cwd,
          branch: "conflicting",
          candidates: [{ threadId: thread("thread-unrelated"), branch: "unrelated" }],
        });

        assert.deepStrictEqual(predictions, []);
      }),
    ),
  );

  it.effect("stays silent when two branches edit the same file cleanly", () =>
    runWith(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "hive-conflict-test-" });
        seedRepo(cwd);

        const detector = yield* ConflictDetector;
        // This is the case that makes merge-tree worth the cost: both branches
        // modify shared.txt, so path-overlap detection would warn, but git
        // merges them without complaint.
        const predictions = yield* detector.predict({
          cwd,
          branch: "conflicting",
          candidates: [{ threadId: thread("thread-clean"), branch: "same-file-clean" }],
        });

        assert.deepStrictEqual(predictions, []);
      }),
    ),
  );

  it.effect("reports only the conflicting candidates out of several", () =>
    runWith(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "hive-conflict-test-" });
        seedRepo(cwd);

        const detector = yield* ConflictDetector;
        const predictions = yield* detector.predict({
          cwd,
          branch: "conflicting",
          candidates: [
            { threadId: thread("thread-unrelated"), branch: "unrelated" },
            { threadId: thread("thread-other"), branch: "other-edit" },
            { threadId: thread("thread-clean"), branch: "same-file-clean" },
          ],
        });

        assert.deepStrictEqual(
          predictions.map((prediction) => prediction.threadId),
          [thread("thread-other")],
        );
      }),
    ),
  );

  it.effect("ignores a candidate whose branch does not exist rather than failing", () =>
    runWith(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "hive-conflict-test-" });
        seedRepo(cwd);

        const detector = yield* ConflictDetector;
        const predictions = yield* detector.predict({
          cwd,
          branch: "conflicting",
          candidates: [
            { threadId: thread("thread-missing"), branch: "no-such-branch" },
            { threadId: thread("thread-other"), branch: "other-edit" },
          ],
        });

        // A prediction we cannot make is omitted, never reported as a conflict.
        assert.deepStrictEqual(
          predictions.map((prediction) => prediction.threadId),
          [thread("thread-other")],
        );
      }),
    ),
  );

  it.effect("never compares a thread against its own branch", () =>
    runWith(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "hive-conflict-test-" });
        seedRepo(cwd);

        const detector = yield* ConflictDetector;
        const predictions = yield* detector.predict({
          cwd,
          branch: "conflicting",
          candidates: [{ threadId: thread("thread-self"), branch: "conflicting" }],
        });

        assert.deepStrictEqual(predictions, []);
      }),
    ),
  );
});

/**
 * Reproduce how T3 Code stores a thread's work: a tree captured with
 * `commit-tree` and no parent, stored under a hidden ref. The thread's branch
 * never advances, which is exactly why comparing branches finds nothing.
 */
function captureCheckpoint(cwd: string, ref: string, edits: ReadonlyMap<number, string>): void {
  write(cwd, "shared.txt", sharedWith(edits));
  runGit(cwd, ["add", "-A", "--", "."]);
  const tree = runGit(cwd, ["write-tree"]).trim();
  const commit = runGit(cwd, ["commit-tree", tree, "-m", `checkpoint ${ref}`]).trim();
  runGit(cwd, ["update-ref", ref, commit]);
  // Leave the working tree as it was, mirroring a capture that does not commit.
  runGit(cwd, ["reset", "-q", "HEAD", "--", "."]);
}

describe("ConflictDetector.predictFromCheckpoints", () => {
  it.effect("finds the conflict that comparing branches would miss", () =>
    runWith(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "hive-checkpoint-test-" });
        seedRepo(cwd);
        runGit(cwd, ["checkout", "-q", "main"]);

        const baseRef = "refs/t3/checkpoints/base/turn/0";
        captureCheckpoint(cwd, baseRef, new Map());
        // Two threads edit the same region, each captured to its own ref.
        captureCheckpoint(cwd, "refs/t3/checkpoints/a/turn/1", new Map([[3, "EDITED BY A"]]));
        captureCheckpoint(cwd, "refs/t3/checkpoints/b/turn/1", new Map([[3, "EDITED BY B"]]));

        const detector = yield* ConflictDetector;

        // The branches never moved, so the branch-based path sees nothing.
        const viaBranches = yield* detector.predict({
          cwd,
          branch: "main",
          candidates: [{ threadId: thread("thread-b"), branch: "main" }],
        });
        assert.deepStrictEqual(viaBranches, []);

        const viaCheckpoints = yield* detector.predictFromCheckpoints({
          cwd,
          baseRef,
          ref: "refs/t3/checkpoints/a/turn/1",
          candidates: [
            {
              threadId: thread("thread-b"),
              ref: "refs/t3/checkpoints/b/turn/1",
              branch: "hive/b",
            },
          ],
        });
        assert.strictEqual(viaCheckpoints.length, 1);
        assert.deepStrictEqual(viaCheckpoints[0]?.files, ["shared.txt"]);
      }),
    ),
  );

  it.effect("stays silent when the checkpoints edit separate regions", () =>
    runWith(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "hive-checkpoint-test-" });
        seedRepo(cwd);
        runGit(cwd, ["checkout", "-q", "main"]);

        const baseRef = "refs/t3/checkpoints/base/turn/0";
        captureCheckpoint(cwd, baseRef, new Map());
        captureCheckpoint(cwd, "refs/t3/checkpoints/a/turn/1", new Map([[3, "EDITED BY A"]]));
        captureCheckpoint(cwd, "refs/t3/checkpoints/b/turn/1", new Map([[35, "FAR AWAY"]]));

        const detector = yield* ConflictDetector;
        const predictions = yield* detector.predictFromCheckpoints({
          cwd,
          baseRef,
          ref: "refs/t3/checkpoints/a/turn/1",
          candidates: [
            {
              threadId: thread("thread-b"),
              ref: "refs/t3/checkpoints/b/turn/1",
              branch: "hive/b",
            },
          ],
        });
        assert.deepStrictEqual(predictions, []);
      }),
    ),
  );

  it.effect("omits a candidate whose checkpoint ref does not resolve", () =>
    runWith(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "hive-checkpoint-test-" });
        seedRepo(cwd);
        runGit(cwd, ["checkout", "-q", "main"]);

        const baseRef = "refs/t3/checkpoints/base/turn/0";
        captureCheckpoint(cwd, baseRef, new Map());
        captureCheckpoint(cwd, "refs/t3/checkpoints/a/turn/1", new Map([[3, "EDITED BY A"]]));

        const detector = yield* ConflictDetector;
        const predictions = yield* detector.predictFromCheckpoints({
          cwd,
          baseRef,
          ref: "refs/t3/checkpoints/a/turn/1",
          candidates: [
            { threadId: thread("ghost"), ref: "refs/t3/checkpoints/missing/turn/9", branch: "x" },
          ],
        });
        assert.deepStrictEqual(predictions, []);
      }),
    ),
  );
});
