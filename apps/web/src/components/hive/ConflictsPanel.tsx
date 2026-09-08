// HIVE: shows which threads in a project will collide when their branches merge.
//
// The predictions come from a real in-memory git merge on the server, so every
// row here is a conflict git itself would raise at merge time. That is the bar
// worth holding: a warning surface people learn to dismiss is worse than none.

import type { EnvironmentId, HiveConflict, ProjectId } from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { hiveEnvironment } from "../../state/hive";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";

function ConflictRow({ conflict }: { readonly conflict: HiveConflict }) {
  return (
    <li className="rounded-md border border-border/60 bg-muted/30 px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <span className="font-medium">{conflict.threadTitle ?? conflict.branch}</span>
        <span className="text-muted-foreground">collides with</span>
        <span className="font-medium">{conflict.otherThreadTitle ?? conflict.otherBranch}</span>
      </div>
      <div className="mt-1 font-mono text-xs text-muted-foreground">
        {conflict.branch} ↔ {conflict.otherBranch}
      </div>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {conflict.files.map((file) => (
          <li
            key={file}
            className="rounded border border-border/50 bg-muted/50 px-1.5 py-0.5 font-mono text-xs"
          >
            {file}
          </li>
        ))}
      </ul>
    </li>
  );
}

export function ConflictsPanel() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId: EnvironmentId | null = primaryEnvironment?.environmentId ?? null;
  const projects = useProjects();

  const environmentProjects = useMemo(
    () => projects.filter((project) => project.environmentId === environmentId),
    [projects, environmentId],
  );

  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(null);
  const projectId = selectedProjectId ?? environmentProjects[0]?.id ?? null;

  const query = useEnvironmentQuery(
    environmentId === null || projectId === null
      ? null
      : hiveEnvironment.conflicts({ environmentId, input: { projectId } }),
  );

  const conflicts = query.data?.conflicts ?? [];
  const skipped = query.data?.skippedThreadIds ?? [];

  return (
    <section className="flex flex-col gap-4 p-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">Merge conflicts</h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          Threads whose branches will not merge cleanly. Each row is a conflict git reports from an
          in-memory merge, not a guess based on which files were edited.
        </p>
      </header>

      {environmentProjects.length > 1 ? (
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Project</span>
          <select
            className="rounded border border-input bg-background px-2 py-1"
            value={projectId ?? ""}
            onChange={(event) => setSelectedProjectId(event.target.value as ProjectId)}
          >
            {environmentProjects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {projectId === null ? (
        <p className="text-sm text-muted-foreground">No project to check.</p>
      ) : query.isPending ? (
        <p className="text-sm text-muted-foreground">Checking branches…</p>
      ) : conflicts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No conflicts between the threads on this project.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {conflicts.map((conflict) => (
            <ConflictRow
              key={`${conflict.threadId}:${conflict.otherThreadId}`}
              conflict={conflict}
            />
          ))}
        </ul>
      )}

      {/*
        A thread with no branch yet cannot be merged against anything. Saying so
        keeps an empty result honest: "nothing collides" and "some threads could
        not be checked" are different answers.
      */}
      {skipped.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {skipped.length} thread{skipped.length === 1 ? "" : "s"} not checked — no branch yet.
        </p>
      ) : null}
    </section>
  );
}
