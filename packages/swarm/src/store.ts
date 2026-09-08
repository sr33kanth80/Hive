// HIVE: durable swarm state.
//
// Mirrors packages/claims/src/store.ts: environment-global, written atomically,
// and unreadable files are quarantined rather than allowed to take the server
// down. A swarm outlives a restart because half-finished parallel work is
// exactly the state you cannot afford to lose track of.

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { EMPTY_SWARM_STORE, SwarmStoreFile } from "./schema.ts";

const StoreCodec = Schema.fromJsonString(SwarmStoreFile);
const decodeStoreFile = Schema.decodeUnknownOption(StoreCodec);
const encodeStoreFile = Schema.encodeEffect(StoreCodec);

/** Beside the claims registry, under the server's own state directory. */
export function swarmFilePath(stateDir: string): Effect.Effect<string, never, Path.Path> {
  return Effect.map(Path.Path, (path) => path.join(stateDir, "hive", "swarms.json"));
}

const quarantine = Effect.fn("SwarmStore.quarantine")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const now = yield* DateTime.now;
  const stamp = DateTime.formatIso(now).replaceAll(/[:.]/gu, "-");
  const quarantinePath = `${filePath}.corrupt-${stamp}`;
  yield* Effect.ignore(fs.rename(filePath, quarantinePath));
  return quarantinePath;
});

export const loadSwarms = Effect.fn("SwarmStore.load")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;

  const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return EMPTY_SWARM_STORE;

  const contents = yield* fs.readFileString(filePath).pipe(Effect.option);
  if (contents._tag === "None") {
    const quarantinePath = yield* quarantine(filePath);
    yield* Effect.logError("hive swarm store unreadable; quarantined and starting fresh", {
      filePath,
      quarantinePath,
    });
    return EMPTY_SWARM_STORE;
  }

  const decoded = decodeStoreFile(contents.value);
  if (decoded._tag === "None") {
    const quarantinePath = yield* quarantine(filePath);
    yield* Effect.logError("hive swarm store failed to decode; quarantined", {
      filePath,
      quarantinePath,
    });
    return EMPTY_SWARM_STORE;
  }

  return decoded.value;
});

export const saveSwarms = Effect.fn("SwarmStore.save")(function* (
  filePath: string,
  store: SwarmStoreFile,
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
