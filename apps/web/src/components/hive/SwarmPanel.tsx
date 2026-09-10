// HIVE: watch swarms run.
//
// Creation lives in the composer — toggle Swarm on and send a prompt. This is
// the observation surface: what Hive split the prompt into, what is running,
// and what is waiting on what. Two ways to start the same thing would only be
// confusing, so there is no task form here.

import type { EnvironmentId, HiveSwarm, HiveSwarmTask, ProjectId } from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { hiveEnvironment } from "../../state/hive";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";

interface DraftTask {
  readonly key: string;
  readonly title: string;
  /** Ids this task waits for, as the developer typed them. */
  readonly dependsOn: string;
}

const STATUS_LABEL: Readonly<Record<HiveSwarmTask["status"], string>> = {
  pending: "waiting",
  running: "running",
  done: "done",
  failed: "failed",
  blocked: "blocked",
};

/** Status carries meaning, so it gets colour rather than only a word. */
const STATUS_CLASS: Readonly<Record<HiveSwarmTask["status"], string>> = {
  pending: "text-muted-foreground",
  running: "text-blue-500",
  done: "text-green-600",
  failed: "text-red-500",
  blocked: "text-amber-600",
};

function TaskRow({ task }: { readonly task: HiveSwarmTask }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1 text-sm">
      <span className={`w-16 shrink-0 font-mono text-xs ${STATUS_CLASS[task.status]}`}>
        {STATUS_LABEL[task.status]}
      </span>
      <span className="font-mono text-xs text-muted-foreground">{task.id}</span>
      <span>{task.title}</span>
      {task.dependsOn.length > 0 ? (
        <span className="font-mono text-xs text-muted-foreground">
          after {task.dependsOn.join(", ")}
        </span>
      ) : null}
      {task.detail !== undefined ? (
        // Full width on its own line: provider errors are long, and truncating
        // the one thing that explains a failure defeats the point of keeping it.
        <span className="w-full break-words text-xs text-muted-foreground">{task.detail}</span>
      ) : null}
    </li>
  );
}

function SwarmCard({ swarm }: { readonly swarm: HiveSwarm }) {
  const done = swarm.tasks.filter((task) => task.status === "done").length;
  const running = swarm.tasks.filter((task) => task.status === "running").length;

  return (
    <li className="rounded-md border border-border/60 bg-muted/30 px-3 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">{swarm.goal}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {done}/{swarm.tasks.length} done{running > 0 ? ` · ${running} running` : ""}
        </span>
      </div>
      <ul className="mt-2 divide-y divide-border/40">
        {swarm.tasks.map((task) => (
          <TaskRow key={task.id} task={task} />
        ))}
      </ul>
    </li>
  );
}

let nextKey = 0;
const newDraft = (): DraftTask => ({ key: `draft-${nextKey++}`, title: "", dependsOn: "" });

export function SwarmPanel() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId: EnvironmentId | null = primaryEnvironment?.environmentId ?? null;
  const projects = useProjects();

  const environmentProjects = useMemo(
    () => projects.filter((project) => project.environmentId === environmentId),
    [projects, environmentId],
  );

  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(null);
  const projectId = selectedProjectId ?? environmentProjects[0]?.id ?? null;

  const [goal, setGoal] = useState("");
  const [drafts, setDrafts] = useState<ReadonlyArray<DraftTask>>(() => [newDraft(), newDraft()]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const query = useEnvironmentQuery(
    environmentId === null || projectId === null
      ? null
      : hiveEnvironment.swarms({ environmentId, input: { projectId } }),
  );
  const swarms = query.data?.swarms ?? [];

  const updateDraft = (key: string, patch: Partial<DraftTask>) => {
    setDrafts((current) =>
      current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)),
    );
  };

  const canSubmit =
    environmentId !== null &&
    projectId !== null &&
    goal.trim().length > 0 &&
    drafts.some((draft) => draft.title.trim().length > 0) &&
    !submitting;

  const submit = async () => {
    if (environmentId === null || projectId === null) return;
    setSubmitting(true);
    setError(null);

    // Task ids are positional so the developer can write "1, 2" as
    // dependencies rather than inventing names for everything.
    const tasks = drafts
      .map((draft, index) => ({ draft, id: String(index + 1) }))
      .filter((entry) => entry.draft.title.trim().length > 0)
      .map((entry) => ({
        id: entry.id,
        title: entry.draft.title.trim(),
        dependsOn: entry.draft.dependsOn
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
      }));

    // The command reports failure as a result rather than throwing, so an
    // invalid plan surfaces here instead of vanishing into a rejected promise.
    const result = await hiveEnvironment.createSwarm.run(appAtomRegistry, {
      environmentId,
      input: { projectId, goal: goal.trim(), tasks },
    });

    if (result._tag === "Success") {
      setGoal("");
      setDrafts([newDraft(), newDraft()]);
    } else {
      setError("Could not start the swarm. Check the task dependencies.");
    }
    setSubmitting(false);
  };

  return (
    <section className="flex flex-col gap-5 p-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">Swarm</h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          Break a job into tasks and run the independent ones at once. Each task gets its own agent
          in its own worktree; a task with dependencies waits until they finish.
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

      <div className="flex flex-col gap-2">
        {projectId === null ? (
          <p className="text-sm text-muted-foreground">No project selected.</p>
        ) : swarms.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No swarms yet. Send a prompt with Swarm turned on.
          </p>
        ) : (
          <ul className="flex max-w-3xl flex-col gap-2">
            {swarms.map((swarm) => (
              <SwarmCard key={swarm.id} swarm={swarm} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
