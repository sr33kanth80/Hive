import type { ProjectId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectSwarmEnabled, useSwarmModeStore } from "./swarmModeStore";

const PROJECT_A = "project-a" as ProjectId;
const PROJECT_B = "project-b" as ProjectId;

const enabledFor = (projectId: ProjectId | null) =>
  selectSwarmEnabled(useSwarmModeStore.getState().enabledByProjectId, projectId);

describe("swarmModeStore", () => {
  beforeEach(() => {
    useSwarmModeStore.setState({ enabledByProjectId: {} });
  });

  it("stays on until it is explicitly turned off", () => {
    useSwarmModeStore.getState().setSwarmEnabled(PROJECT_A, true);
    expect(enabledFor(PROJECT_A)).toBe(true);

    // The bug this store exists for: the composer remounts when a swarm spawns
    // threads and the app navigates to one. Nothing about that should disarm
    // the mode, so only an explicit false may.
    useSwarmModeStore.getState().setSwarmEnabled(PROJECT_A, false);
    expect(enabledFor(PROJECT_A)).toBe(false);
  });

  it("does not follow the developer into another project", () => {
    useSwarmModeStore.getState().setSwarmEnabled(PROJECT_A, true);
    expect(enabledFor(PROJECT_B)).toBe(false);
  });

  it("is off for an unknown or absent project", () => {
    expect(enabledFor(PROJECT_A)).toBe(false);
    expect(enabledFor(null)).toBe(false);
  });
});
