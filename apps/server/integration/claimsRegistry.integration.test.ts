// HIVE: end-to-end proof that a settled turn produces a claim.
//
// Everything below runs the real machinery: a real git workspace, the real
// CheckpointReactor computing a real diff between checkpoint refs, the real
// ClaimsReactor subscribed to the real event stream, and the real registry
// writing a real ownership.json. Only the provider is faked, and only so the
// turn is deterministic.
//
// Harness timing worth knowing, measured rather than assumed: a thread's
// baseline checkpoint does not exist until its first turn runs — it is captured
// during that turn, not at thread creation. The fake adapter applies
// `mutateWorkspace` immediately after emitting its events, fast enough to land
// before that baseline capture, so an edit made during turn 1 is absorbed into
// the baseline and shows up in no diff at all. A diagnostic run confirmed the
// baseline and the turn-1 checkpoint both already contained the edited content.
//
// From turn 2 onward the baseline is fixed, so edits appear normally. Hence
// this test edits on two consecutive turns, which is also why the upstream
// multi-turn checkpoint test asserts on its second checkpoint.
//
// This is an artifact of a fake provider that edits in microseconds; a real
// agent takes long enough that the capture triggered at turn start wins. The
// residual production risk is a narrow race for edits made in the first
// moments of a thread's first turn.

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  CommandId,
  defaultInstanceIdForDriver,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import { type Claim, ClaimStoreFile } from "@t3tools/claims/schema";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { TestTurnResponse } from "./TestProviderAdapter.integration.ts";
import {
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "./OrchestrationEngineHarness.integration.ts";
import type {
  CheckpointDiffFinalizedReceipt,
  TurnProcessingQuiescedReceipt,
} from "../src/orchestration/Services/RuntimeReceiptBus.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const FIXTURE_TURN_ID = "fixture-turn";
const CODEX_PROVIDER = ProviderDriverKind.make("codex");

const decodeStoreFile = Schema.decodeUnknownSync(Schema.fromJsonString(ClaimStoreFile));

function nowIso() {
  return "2026-05-01T00:00:00.000Z";
}

function runtimeBase(eventId: string, createdAt: string) {
  return {
    eventId: EventId.make(eventId),
    provider: CODEX_PROVIDER,
    createdAt,
  };
}

function withClaimsHarness<A, E>(
  use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E>,
) {
  return Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ provider: CODEX_PROVIDER, realClaimsReactor: true }),
    use,
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer));
}

const seedProjectAndThread = (harness: OrchestrationIntegrationHarness) =>
  Effect.gen(function* () {
    const createdAt = nowIso();
    const instanceId = defaultInstanceIdForDriver(CODEX_PROVIDER);
    const model = DEFAULT_MODEL_BY_PROVIDER[CODEX_PROVIDER] ?? DEFAULT_MODEL;

    yield* harness.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-project-create"),
      projectId: PROJECT_ID,
      title: "Claims Project",
      workspaceRoot: harness.workspaceDir,
      defaultModelSelection: { instanceId, model },
      createdAt,
    });

    yield* harness.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-thread-create"),
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Claims Thread",
      modelSelection: { instanceId, model },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: harness.workspaceDir,
      createdAt,
    });
  });

const turnResponse = (index: number, mutate?: (cwd: string) => void): TestTurnResponse => ({
  events: [
    {
      type: "turn.started",
      ...runtimeBase(`evt-claims-${index}-1`, "2026-02-24T10:00:00.000Z"),
      threadId: THREAD_ID,
      turnId: FIXTURE_TURN_ID,
    },
    {
      type: "turn.completed",
      ...runtimeBase(`evt-claims-${index}-2`, "2026-02-24T10:00:00.200Z"),
      threadId: THREAD_ID,
      turnId: FIXTURE_TURN_ID,
      status: "completed",
    },
  ],
  ...(mutate
    ? {
        mutateWorkspace: ({ cwd }: { readonly cwd: string }) => Effect.sync(() => mutate(cwd)),
      }
    : {}),
});

const runTurn = (
  harness: OrchestrationIntegrationHarness,
  index: number,
  mutate?: (cwd: string) => void,
) =>
  Effect.gen(function* () {
    // The first turn creates the session; later turns queue against the
    // existing one, or the adapter never answers and the receipt never fires.
    if (index === 1) {
      yield* harness.adapterHarness!.queueTurnResponseForNextSession(turnResponse(index, mutate));
    } else {
      yield* harness.adapterHarness!.queueTurnResponse(THREAD_ID, turnResponse(index, mutate));
    }
    yield* harness.engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`cmd-turn-start-${index}`),
      threadId: THREAD_ID,
      message: {
        messageId: MessageId.make(`msg-user-${index}`),
        role: "user",
        text: `Turn ${index}`,
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: nowIso(),
    });

    yield* harness.waitForReceipt(
      (receipt): receipt is CheckpointDiffFinalizedReceipt =>
        receipt.type === "checkpoint.diff.finalized" &&
        receipt.threadId === THREAD_ID &&
        receipt.checkpointTurnCount === index,
    );
    yield* harness.waitForReceipt(
      (receipt): receipt is TurnProcessingQuiescedReceipt =>
        receipt.type === "turn.processing.quiesced" &&
        receipt.threadId === THREAD_ID &&
        receipt.checkpointTurnCount === index,
    );
    yield* harness.drainClaimsReactor;
  });

function readClaim(harness: OrchestrationIntegrationHarness): Claim | undefined {
  if (!NodeFS.existsSync(harness.ownershipFilePath)) return undefined;
  return decodeStoreFile(NodeFS.readFileSync(harness.ownershipFilePath, "utf8")).claims.find(
    (entry) => entry.threadId === THREAD_ID,
  );
}

/**
 * The registry is written by a reactor that emits no receipt of its own, and
 * the receipts above belong to checkpointing, so they do not prove the claims
 * reactor has caught up. A bounded wait is the honest way to observe it.
 */
const waitForClaim = (
  harness: OrchestrationIntegrationHarness,
  predicate: (claim: Claim) => boolean,
  description: string,
  timeoutMs = 10_000,
) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
    while (true) {
      const claim = readClaim(harness);
      if (claim !== undefined && predicate(claim)) return claim;
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        const seen =
          claim === undefined
            ? "no claim"
            : `files=[${claim.files.join(", ")}] turnCount=${claim.turnCount} source=${claim.filesSource}`;
        return yield* Effect.die(new Error(`timed out waiting for ${description}; last: ${seen}`));
      }
      yield* Effect.sleep(25);
    }
  });

it.live("a real turn diff reaches the registry as a repo-relative claim", () =>
  withClaimsHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      // Mirrors the shape of the upstream multi-turn checkpoint test: both turns
      // edit the file, and the change is observable in the second turn's diff.
      // Accumulation and normalization are covered by packages/claims unit
      // tests; what this test exists to prove is that a real, git-derived file
      // list reaches the registry at all.
      yield* runTurn(harness, 1, (cwd) => {
        NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v2\n", "utf8");
      });
      yield* runTurn(harness, 2, (cwd) => {
        NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v3\n", "utf8");
      });

      const claim = yield* waitForClaim(
        harness,
        (entry) => entry.files.length > 0,
        "the claim to record the edited file",
      );

      assert.equal(claim.status, "active");
      // Repo-root-relative, exactly as git reports it — not an absolute path.
      // This is the property the whole cross-worktree design rests on.
      assert.deepEqual(claim.files, ["README.md"]);
      assert.equal(claim.filesSource, "diff");
    }),
  ),
);
