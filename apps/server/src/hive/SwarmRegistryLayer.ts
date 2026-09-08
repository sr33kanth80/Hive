// HIVE: binds the swarm registry to this server's state directory.
//
// Lives here rather than in packages/swarm so the package stays free of any
// dependency on the server, exactly like the claims registry layer.

import { SwarmRegistry, make as makeSwarmRegistry } from "@t3tools/swarm/registry";
import { swarmFilePath } from "@t3tools/swarm/store";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";

export const layer = Layer.effect(
  SwarmRegistry,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const filePath = yield* swarmFilePath(config.stateDir);
    return yield* makeSwarmRegistry(filePath);
  }),
);
