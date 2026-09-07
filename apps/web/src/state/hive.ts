import { createHiveEnvironmentAtoms } from "@t3tools/client-runtime/state/hive";

import { connectionAtomRuntime } from "../connection/runtime";

export const hiveEnvironment = createHiveEnvironmentAtoms(connectionAtomRuntime);
