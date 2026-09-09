// HIVE: remembers whether swarm mode is on.
//
// Swarm used to live in `useState` inside the composer, which meant any remount
// silently switched it off — and starting a swarm remounts the composer, because
// it spawns threads and the app navigates to one. A mode the developer turned on
// explicitly must not turn itself off; if it ever goes off, that is because they
// clicked it.
//
// Scoped per project rather than globally: swarm only exists when a project is
// active, it creates worktrees in that repository, and inheriting "on" into an
// unrelated repo would fan work out somewhere the developer never asked for.

import type { ProjectId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

interface SwarmModeStoreState {
  enabledByProjectId: Record<string, boolean>;
  setSwarmEnabled: (projectId: ProjectId, enabled: boolean) => void;
}

export const useSwarmModeStore = create<SwarmModeStoreState>()(
  persist(
    (set) => ({
      enabledByProjectId: {},
      setSwarmEnabled: (projectId, enabled) =>
        set((state) => ({
          enabledByProjectId: { ...state.enabledByProjectId, [projectId]: enabled },
        })),
    }),
    {
      name: "t3code:hive-swarm-mode:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ enabledByProjectId: state.enabledByProjectId }),
    },
  ),
);

/** Off unless this project was explicitly turned on. */
export function selectSwarmEnabled(
  enabledByProjectId: Record<string, boolean>,
  projectId: ProjectId | null | undefined,
): boolean {
  if (projectId == null) return false;
  return enabledByProjectId[projectId] ?? false;
}
