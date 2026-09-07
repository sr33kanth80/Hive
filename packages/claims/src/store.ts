import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ClaimStoreFile, EMPTY_STORE } from "./schema.ts";

/** One codec for both directions: parsing and validation are a single step. */
const StoreCodec = Schema.fromJsonString(ClaimStoreFile);
const decodeStoreFile = Schema.decodeUnknownOption(StoreCodec);
const encodeStoreFile = Schema.encodeEffect(StoreCodec);

/**
 * The registry lives beside the server's database rather than in a project
 * workspace. Anything written inside a workspace or worktree is captured by
 * checkpoints, shows up in every turn diff, can be committed by accident, and
 * splits per-worktree so concurrent threads would each see a different file.
 */
export function ownershipFilePath(stateDir: string): Effect.Effect<string, never, Path.Path> {
  return Effect.map(Path.Path, (path) => path.join(stateDir, "hive", "ownership.json"));
}

/**
 * Rename an unreadable registry aside instead of deleting it, so a corrupt file
 * can be inspected after the fact. Returns the quarantine path.
 */
const quarantine = Effect.fn("ClaimStore.quarantine")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const now = yield* DateTime.now;
  const stamp = DateTime.formatIso(now).replaceAll(/[:.]/gu, "-");
  const quarantinePath = `${filePath}.corrupt-${stamp}`;
  yield* Effect.ignore(fs.rename(filePath, quarantinePath));
  return quarantinePath;
});

/**
 * Load the registry. A missing file is an empty registry; an unreadable,
 * malformed, or schema-invalid one is quarantined and reported as empty. This
 * never fails: a bad state file must not take the server down.
 */
export const loadStore = Effect.fn("ClaimStore.load")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;

  const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return EMPTY_STORE;

  const contents = yield* fs.readFileString(filePath).pipe(Effect.option);
  if (contents._tag === "None") {
    const quarantinePath = yield* quarantine(filePath);
    yield* Effect.logError("hive claims registry unreadable; quarantined and starting fresh", {
      filePath,
      quarantinePath,
    });
    return EMPTY_STORE;
  }

  // Malformed JSON and a valid-JSON-but-wrong-shape file fail the same way here,
  // and both are quarantined rather than crashing the server.
  const decoded = decodeStoreFile(contents.value);
  if (decoded._tag === "None") {
    const quarantinePath = yield* quarantine(filePath);
    yield* Effect.logError("hive claims registry failed to decode; quarantined", {
      filePath,
      quarantinePath,
    });
    return EMPTY_STORE;
  }

  return decoded.value;
});

/**
 * Write the registry atomically: a temp file in the destination directory, then
 * a rename. A reader must never observe a half-written registry, and a crash
 * mid-write must leave the previous version intact.
 *
 * Mirrors apps/server/src/atomicWrite.ts, kept local so this package does not
 * depend on the server.
 */
export const saveStore = Effect.fn("ClaimStore.save")(function* (
  filePath: string,
  store: ClaimStoreFile,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const contents = yield* encodeStoreFile(store);
  const directory = path.dirname(filePath);
  yield* fs.makeDirectory(directory, { recursive: true });

  const tempPath = path.join(directory, `${path.basename(filePath)}.${process.pid}.tmp`);
  yield* fs.writeFileString(tempPath, contents);
  yield* fs.rename(tempPath, filePath);
});
