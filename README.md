# Hive

Hive is a coordination layer for coding agents. It tells you when two agents
working in parallel are about to collide — before you find out at merge time.

## The problem

Coding agents are good at the work. What they cannot do is see each other.

Run three agents on one repository and each one plans as if it were alone. They
pick the same files, reshape the same functions, and invent the same helper
three different ways. Nothing goes wrong until you try to bring the branches
together, and by then the cost is yours to pay.

Hive watches the branches your agents are building and answers one question
continuously: **will these merge?**

## What Hive does today

**Predicts real merge conflicts.** For every pair of threads in a project, Hive
performs the merge in memory with `git merge-tree` — touching neither your
working tree nor your index — and reports the files that genuinely conflict.

This matters more than it sounds. The obvious approach is to compare the file
paths each agent touched and warn on overlap, but two agents editing different
parts of the same file merge cleanly, so overlap warns constantly about nothing.
A warning surface people learn to dismiss is worse than no warning at all.
Every row Hive shows is a conflict git itself would raise.

**Keeps an ownership registry.** Each settled turn contributes the files that
thread's branch has touched, derived from the checkpoint diffs the server
already computes. Because it comes from git rather than from parsing agent
output, it works the same across every provider.

**Says when it does not know.** A thread with no branch yet cannot be merged
against anything, so Hive reports it as unchecked rather than dropping it.
"Nothing collides" and "some threads were not checked" are different answers,
and conflating them is how a tool starts lying to you.

## Status

Early, and honest about it.

The conflict engine is verified at the mechanism level: a real turn, through
real checkpointing, produces a claim naming the file that changed, and the
detector correctly separates genuine conflicts from two branches editing the
same file cleanly.

What has **not** happened yet is validation against real concurrent agent runs.
Nobody has watched Hive call a conflict on work they actually cared about. The
false-positive rate is unmeasured — note that `git merge-tree` is stricter than
"do the changed line ranges intersect", so edits on adjacent lines count as
conflicts.

Also true, so you are not surprised:

- The ownership registry is populated but nothing reads it yet. Conflicts are
  answered from branches. Claims are there for ranking and explanation later.
- The conflicts page lives at `/settings/hive` and is not in the settings
  navigation. Conflicts are operational rather than configuration, and where
  this belongs is still an open question.
- Swarm execution, cross-machine multiplayer, shared memory, and a push
  approval gate are **not built**. They are the direction, not the present.

## Requirements

**Threads must run in worktree mode.** Hive compares branches. In `local`
checkout mode every thread shares one checkout on one branch, so there are no
branches to compare and Hive will honestly report that it checked nothing.

Set it per repository in `t3.json`:

```json
{ "defaultThreadEnvMode": "worktree" }
```

A per-project setting in the app overrides the file, and the composer footer
tells you which mode a thread is actually using.

You also need at least one agent provider installed and authenticated — Claude
Code, Codex, Cursor, Grok, OpenCode, or Antigravity.

## Running it

Node 24.13+ and [Vite+](https://viteplus.dev/guide/):

```bash
curl -fsSL https://vite.plus | bash    # macOS / Linux
```

```bash
irm https://vite.plus/ps1 | iex        # Windows
```

Then:

```bash
vp i
pnpm dev            # server + web client
pnpm dev:desktop    # Electron app
```

Open the pairing URL the server prints. The conflicts page is at
`/settings/hive`.

## How it works

The server is event sourced. Commands produce events, a pure decider turns one
into the other, and side effects run in queue-backed reactors. Hive follows that
grain rather than fighting it:

- `packages/claims` — the ownership registry: schema, an atomically written
  store, and the registry service.
- `apps/server/src/orchestration/ClaimsReactor.ts` — subscribes to settled
  turns and folds their git-derived file lists into claims. A reactor, not a
  hook in the decider or projector, because both of those are pure.
- `apps/server/src/hive/` — the conflict detector and the query that pairs up a
  project's threads.
- `apps/web/src/components/hive/` — the conflicts panel.

Hive's code is deliberately additive: new packages and new files, plus a small
number of registration lines in the host application, each marked `// HIVE`.

## Built on T3 Code

Hive is built on top of [T3 Code](https://github.com/pingdotgg/t3code), an
open-source control surface for coding agents by T3 Tools. T3 Code provides
everything underneath the coordination layer — the agent adapters, git worktree
workspaces, durable threads, checkpointing, and the web, desktop, and mobile
clients.

That foundation is why Hive is small. Conflict prediction reads the checkpoint
diffs T3 Code already computes; it did not have to build agent orchestration to
get there.

T3 Code is MIT licensed, © T3 Tools Inc. Its `LICENSE` is preserved unchanged in
this repository. For anything about the underlying platform — providers, remote
access, keybindings, source control — see [docs/](./docs) and
[docs/internals/overview.md](./docs/internals/overview.md).

## License

MIT. Hive's additions are MIT; portions © T3 Code contributors.
