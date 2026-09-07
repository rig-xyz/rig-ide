import { randomUUID } from 'node:crypto';
import {
  sessionStateSchema,
  transcriptTurnSchema,
  type SessionState,
  type ToolCallItem,
  type TranscriptTurn,
} from '@emdash/core/acp';
import { err, ok, type Result } from '@emdash/shared';
import { ReplicaState } from '@emdash/wire';
import { getAcpRuntimeClient, type AcpRuntimeClient } from '@main/core/acp/controller';
import { agentHookService } from '@main/core/agent-hooks/agent-hook-service';
import { isValidProviderId } from '@main/core/agents/plugin-registry';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import {
  rigCommentAgentProgressChannel,
  rigCommentPermissionsChannel,
  type RigCommentAgentRequest,
  type RigCommentMessage,
  type RigCommentPermissionDetail,
  type RigCommentPermissionRequest,
  type RigCommentsError,
} from '@shared/rig/comments';
import { classifyProviderAnswer } from './comment-agent-answer-classify';
import { partitionAutoApprovable, partitionGloballyApprovable } from './comment-agent-auto-approve';
import { createTurnDeadline, type TurnOutcome } from './comment-agent-lifecycle';
import {
  assistantText,
  commentAgentProgress,
  type CommentAgentProgress,
} from './comment-agent-progress';
import { composeCommentAgentPrompt } from './comment-agent-prompt';
import { extractProposal } from './comment-agent-proposal';
import { resolveCommentDispatchContext, rigCommentsController } from './comments';
import { checkRelayTrust } from './relay-trust';
import { rigSettingsStore } from './settings-instance';

/**
 * Answering an `@agent` mention in a doc comment thread.
 *
 * The agent runs headlessly — no chat panel is ever mounted for it — but it is
 * the same agent with the same tools it has in the chat pane, and it may read,
 * edit and run things in the workspace. The one thing it does not do is post:
 * the reply reaches the relay through this module, under the signed-in account,
 * marked as jointly authored (`authorKind: 'agent'`).
 *
 * Tools mean permission prompts, and the runtime's permission broker is a bare
 * promise with no default and no timeout — nothing settles it but a human
 * choosing an option. There being no chat panel is not a reason to take the
 * tools away, only a reason to render the prompt somewhere else: this module
 * follows the headless session's own `pendingPermissions` and republishes them
 * to the thread card that dispatched the turn (`rigCommentPermissionsChannel`),
 * which draws one button per option and settles through `resolvePermission`
 * below. The reader decides in the margin, next to the question they asked.
 *
 * One request never reaches that card: the read-only `rig context` lookup
 * this same flow's own hidden-context prompt tells the model to run (see
 * `comment-agent-prompt.ts`). Surfacing an Allow/Reject card with a raw
 * base64 command line for a by-design-safe evidence read is a UX defect, not
 * a safeguard — `partitionAutoApprovable` (`comment-agent-auto-approve.ts`)
 * resolves it immediately instead. Every other tool call prompts, unless the
 * reader has turned on Settings → Agents → "Auto-approve agent actions", in
 * which case `partitionGloballyApprovable` resolves those too — see
 * `publishPermissions` below.
 *
 * Every wait here is still bounded — see `awaitTurnEnd`, where the inactivity
 * clock stops for exactly as long as a human is the one being waited on.
 */

/**
 * How long the turn may go without the agent finishing. Paused while a
 * permission request is outstanding: waiting on a reader is not idleness.
 */
const IDLE_TIMEOUT_MS = 90_000;
/**
 * Hard ceiling on one turn, permission waits included. Nothing may hold an
 * agent process (and the reader's attention) open past this.
 */
const ABSOLUTE_TIMEOUT_MS = 15 * 60_000;
/** Committed turns land in the reducer just after the stop signal; give them a moment. */
const ANSWER_MAX_WAIT_MS = 5_000;
const ANSWER_POLL_MS = 250;
const HISTORY_LIMIT = 20;

function agentError(message: string): RigCommentsError {
  return { kind: 'agent', message };
}

/** Cap on how much of a session-start failure's cause message reaches the reader. */
const MAX_ERROR_DETAIL = 600;

/**
 * The underlying cause of an ACP session-start failure
 * (`AcpStartSessionError`'s `spawn_failed`/`initialize_failed`/… variants all
 * carry a `SerializedError` `cause`), when there is one — surfaced now that
 * the margin renders the full error message instead of truncating it to one
 * line. Loosely typed rather than importing `AcpStartSessionError`: every
 * variant's shape is `{ type, message?, cause?: { message } }`, and reading
 * that structurally is simpler than chasing the exact union import path for
 * a diagnostic-only accessor.
 */
function causeMessage(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) return null;
  const message = (cause as { message?: unknown }).message;
  if (typeof message !== 'string' || message.trim().length === 0) return null;
  const trimmed = message.trim();
  return trimmed.length > MAX_ERROR_DETAIL ? `${trimmed.slice(0, MAX_ERROR_DETAIL)}…` : trimmed;
}

// ── turn lifecycle ───────────────────────────────────────────────────────────

/**
 * Resolves when the headless turn ends.
 *
 * `agentHookService` is the only signal available in main: the ACP status
 * bridge derives turn transitions from the runtime's session summaries and
 * re-emits them on this hook. (`conversationAgentStatusChangedChannel` is not
 * an option — in the main process `events.emit` only sends to renderer windows,
 * so main cannot hear its own emission.)
 *
 * Two endings emit nothing at all: a cancelled turn, and a turn whose
 * `lastStopReason` is null. The timeout is therefore not a belt-and-braces
 * guard — it is the only way those paths ever return.
 *
 * Two clocks, because they measure different things. The idle clock bounds how
 * long the *agent* may go without finishing, and stops while a permission
 * request is outstanding — a reader who hasn't clicked yet is not a stalled
 * turn, and counting their thinking time against the agent would turn every
 * approval into a spurious "did not answer in time". The absolute clock bounds
 * the whole turn regardless, so nothing leaks if the reader walks away.
 */
function awaitTurnEnd(conversationId: string): {
  outcome: Promise<TurnOutcome>;
  /** Restarts the idle clock when the live turn emits text, thinking, or tool progress. */
  noteActivity: () => void;
  /** Stops the idle clock while a human is deciding; restarts it once they have. */
  setAwaitingPermission: (waiting: boolean) => void;
  dispose: () => void;
} {
  let unsubscribe: () => void = () => {};
  const deadline = createTurnDeadline({
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    absoluteTimeoutMs: ABSOLUTE_TIMEOUT_MS,
    onAbsoluteTimeout: (awaitingPermission) => {
      log.warn('Rig comment agent: turn hit the absolute deadline', {
        conversationId,
        limitMs: ABSOLUTE_TIMEOUT_MS,
        awaitingPermission,
      });
    },
    onFinish: () => unsubscribe(),
  });

  unsubscribe = agentHookService.on('agent:event', (event) => {
    if (event.conversationId !== conversationId) return;
    if (event.type === 'stop') deadline.finish('completed');
    else if (event.type === 'error') deadline.finish('error');
  });

  return {
    outcome: deadline.outcome,
    noteActivity: deadline.noteActivity,
    setAwaitingPermission: deadline.setAwaitingPermission,
    dispose: deadline.dispose,
  };
}

// ── permissions ──────────────────────────────────────────────────────────────

/**
 * Turns currently running for a thread: root comment id → conversation id.
 *
 * The renderer settles by thread, not by conversation — it never learns the
 * conversation id, and this is the only place the two are associated. Entries
 * live exactly as long as the turn does.
 */
const liveTurns = new Map<string, string>();

/**
 * What the reader is actually being asked to approve, from the typed tool
 * call. Compact by design: the exact command or path, and for edits a
 * line-count summary — never the full diff over the events channel.
 */
function toPermissionDetail(toolCall: ToolCallItem): RigCommentPermissionDetail {
  switch (toolCall.kind) {
    case 'execute-tool-call':
      return { kind: 'execute', ...(toolCall.command ? { command: toolCall.command } : {}) };
    case 'modify-file-tool-call':
      return {
        kind: 'edit',
        path: toolCall.path,
        summary: `+${countLines(toolCall.newText)} −${countLines(toolCall.oldText)}`,
      };
    case 'create-file-tool-call':
      return { kind: 'edit', path: toolCall.path, summary: `+${countLines(toolCall.content)} −0` };
    case 'delete-file-tool-call':
      return { kind: 'edit', path: toolCall.path, summary: 'delete file' };
    case 'read-tool-call':
      return { kind: 'read', ...(toolCall.path ? { path: toolCall.path } : {}) };
    case 'web-fetch-tool-call':
      return { kind: 'fetch', url: toolCall.url };
    case 'mcp-tool-call':
      return { kind: 'other', name: toolCall.tool };
    case 'unknown-tool-call':
      return { kind: 'other', ...(toolCall.name ? { name: toolCall.name } : {}) };
    default:
      return { kind: 'other' };
  }
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length;
}

function toPermissionRequests(
  pending: SessionState['pendingPermissions']
): RigCommentPermissionRequest[] {
  return pending.map((request) => ({
    requestId: request.requestId,
    title: request.toolCall.title,
    detail: toPermissionDetail(request.toolCall),
    // `inputSummary` is the provider's own gloss on why it's making this call
    // (Claude's `rawInput.description`, e.g. "Read top-of-file comments") —
    // the closest thing the payload carries to the agent explaining itself.
    ...(request.toolCall.inputSummary ? { reason: request.toolCall.inputSummary } : {}),
    options: request.options.map((option) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind,
    })),
  }));
}

/**
 * Follows one headless session's pending permission requests.
 *
 * `onRequests` fires on the seed too, so a request raised before the replica
 * attached is still surfaced. Failing to attach is not fatal to the turn: the
 * agent simply blocks until the absolute deadline, which is logged here so the
 * cause is visible rather than mysterious.
 *
 * `dispose` detaches asynchronously and `onChange` is called ahead of the
 * emitter it clears, so the flag — not the replica — is what guarantees the
 * caller's last word on this thread stays the last word.
 */
function followPermissions(
  client: AcpRuntimeClient,
  conversationId: string,
  onRequests: (requests: RigCommentPermissionRequest[]) => void
): { dispose: () => void } {
  let following = true;
  const replica = new ReplicaState<SessionState>(
    client.session.state({ conversationId }, 'state'),
    {
      schema: sessionStateSchema,
      onChange: (state) => {
        if (!following) return;
        onRequests(toPermissionRequests(state.pendingPermissions));
      },
    }
  );
  replica.ready.catch((error: unknown) => {
    log.warn('Rig comment agent: could not follow the session permissions', {
      conversationId,
      error: String(error),
    });
  });
  return {
    dispose: () => {
      following = false;
      void replica.dispose().catch(() => {
        // Detaching a session that is already gone; nothing to surface.
      });
    },
  };
}

const activeTurnReplicaSchema = transcriptTurnSchema.nullable();
const PROGRESS_EMIT_INTERVAL_MS = 50;

/**
 * Follows the live turn once and projects only safe reader-facing progress:
 * assistant prose plus a coarse activity label. Thinking text, commands,
 * opaque targets, and tool output never cross the renderer event boundary.
 */
function followProgress(
  client: AcpRuntimeClient,
  conversationId: string,
  onProgress: (progress: CommentAgentProgress) => void,
  onActivity: () => void
): { dispose: () => void; latestText: () => string } {
  let following = true;
  let latestText = '';
  let latestSerialized = '';
  let pending: ReturnType<typeof commentAgentProgress> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let lastEmittedAt = 0;

  const emitPending = (): void => {
    timer = null;
    if (!following || !pending) return;
    const next = pending;
    pending = null;
    const serialized = `${next.activity}\0${next.text}`;
    if (serialized === latestSerialized) return;
    latestSerialized = serialized;
    lastEmittedAt = Date.now();
    onProgress(next);
  };

  const schedule = (next: ReturnType<typeof commentAgentProgress>): void => {
    pending = next;
    if (timer) return;
    const remaining = PROGRESS_EMIT_INTERVAL_MS - (Date.now() - lastEmittedAt);
    if (remaining <= 0) emitPending();
    else timer = setTimeout(emitPending, remaining);
  };

  const replica = new ReplicaState<TranscriptTurn | null>(
    client.session.state({ conversationId }, 'activeTurn'),
    {
      schema: activeTurnReplicaSchema,
      onChange: (turn) => {
        if (!following || !turn) return;
        onActivity();
        const next = commentAgentProgress(turn);
        latestText = next.text;
        schedule(next);
      },
    }
  );
  replica.ready.catch((error: unknown) => {
    log.warn('Rig comment agent: could not follow live progress', {
      conversationId,
      error: String(error),
    });
  });
  return {
    latestText: () => latestText,
    dispose: () => {
      following = false;
      if (timer) clearTimeout(timer);
      timer = null;
      void replica.dispose().catch(() => {
        // The session may have disappeared at the same moment as cleanup.
      });
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The answer, once the reducer has committed the turn. `getHistory` returns
 * committed turns only and the commit lands just after the stop signal, so a
 * single read can legitimately come back empty — poll briefly before giving up.
 */
async function readAnswer(
  client: AcpRuntimeClient,
  conversationId: string
): Promise<string | null> {
  const deadline = Date.now() + ANSWER_MAX_WAIT_MS;
  for (;;) {
    const page = await client.getHistory({ conversationId, limit: HISTORY_LIMIT });
    if (page.success) {
      const text = assistantText(page.data.turns);
      if (text) return text;
    }
    if (Date.now() >= deadline) return null;
    await delay(ANSWER_POLL_MS);
  }
}

/**
 * The `meta.agent` label the rig ecosystem expects. The CLI stamps
 * `claude-code` for Claude; other providers are named by their own id.
 */
function agentLabel(providerId: string): string {
  return providerId === 'claude' ? 'claude-code' : providerId;
}

/**
 * The model the session actually ran on, as the provider reports it.
 *
 * `request.model` is only what was *asked* for, and on the ordinary path it is
 * null — the provider then picks its own default, which is exactly the case
 * that used to leave `meta.model` unset and the author line reading `rig (with
 * …)` instead of `rig · <model> (with …)`. The transcript is no help: no
 * `TranscriptItem` variant carries a model. The session's config state does:
 * `setConfigOption('model', …)` round-trips through the provider and the
 * reducer re-derives `modelOptions` from the provider's own answer, so
 * `modelOptions.selected` is a report rather than an echo.
 *
 * Read while the session is still up — `stopSession` takes the live model with
 * it. Providers exposing no model option report `modelOptions: null`, so this
 * returning null is ordinary and the caller falls back to the requested model.
 *
 * The provider's model *id* is what lands in `meta.model`, not its display
 * name: the rig CLI stamps the raw `--model` string, and one model must not
 * show up under two different names depending on which surface posted.
 */
/**
 * Sentinels a provider may report as the "selected" model when the reader never
 * chose one. They name a *policy*, not a model, so stamping them as provenance
 * is worse than stamping nothing: `rig · default (with …)` reads like a model
 * called "default". Omit instead and the author line degrades to `rig (with …)`.
 */
const MODEL_SENTINELS = new Set(['default', 'auto', 'recommended', 'inherit']);

async function readSessionModel(
  client: AcpRuntimeClient,
  conversationId: string
): Promise<string | null> {
  try {
    const snapshot = await client.session.state({ conversationId }, 'config').snapshot();
    const selected = snapshot.data.modelOptions?.selected ?? null;
    if (!selected || MODEL_SENTINELS.has(selected.trim().toLowerCase())) return null;
    return selected;
  } catch (error) {
    log.warn('Rig comment agent: could not read the session model', {
      conversationId,
      error: String(error),
    });
    return null;
  }
}

/**
 * The FULL model picker state (not just the selected one `readSessionModel`
 * reports) — backs the graceful-provider-failure retry below. Null when the
 * provider exposes no model selector at all, same as `readSessionModel`'s
 * own null case.
 */
async function readModelChoices(
  client: AcpRuntimeClient,
  conversationId: string
): Promise<{ selected: string | null; available: readonly { id: string; name: string }[] } | null> {
  try {
    const snapshot = await client.session.state({ conversationId }, 'config').snapshot();
    const modelOptions = snapshot.data.modelOptions;
    if (!modelOptions) return null;
    return { selected: modelOptions.selected, available: modelOptions.available };
  } catch (error) {
    log.warn('Rig comment agent: could not read the session model options', {
      conversationId,
      error: String(error),
    });
    return null;
  }
}

/**
 * The first alternative model worth a one-shot retry after a
 * model-unsupported failure — never the sentinel/policy options
 * (`MODEL_SENTINELS`, "default"/"auto"/…) and never the SAME model that
 * just failed (`currentModel`, whichever of the requested/session-reported
 * model is known). Null when there is nothing safe to substitute, in which
 * case the caller reports the original failure rather than guessing.
 */
function pickModelSubstitute(
  choices: { selected: string | null; available: readonly { id: string; name: string }[] } | null,
  currentModel: string | null
): string | null {
  if (!choices) return null;
  const exclude = new Set(
    [choices.selected, currentModel]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim().toLowerCase())
  );
  const substitute = choices.available.find((option) => {
    const id = option.id.trim().toLowerCase();
    return !MODEL_SENTINELS.has(id) && !exclude.has(id);
  });
  return substitute?.id ?? null;
}

// ── controller ───────────────────────────────────────────────────────────────

export const rigCommentAgentController = createRPCController({
  /**
   * Runs one headless agent turn seeded with a comment thread, then posts the
   * answer back as an agent-authored reply. Resolves with the posted reply, or
   * a structured error — it never throws across the IPC boundary.
   */
  askAgent: async (
    request: RigCommentAgentRequest
  ): Promise<Result<RigCommentMessage, RigCommentsError>> => {
    const { absPath, parentId, providerId } = request;

    if (request.thread.length === 0) {
      return err(agentError('There is nothing in the thread to answer.'));
    }
    if (!isValidProviderId(providerId)) {
      return err(agentError(`Unknown agent: ${providerId}.`));
    }
    // One turn per thread: a second concurrent turn would overwrite this
    // thread's `liveTurns` entry and could misroute a permission settle.
    // `parentId` is a relay-assigned message id, globally unique across every
    // rig this account can see — not a locally-scoped counter — so keying
    // purely on it (rather than `workspace root + parentId`) cannot collide
    // between two different rigs' threads.
    if (liveTurns.has(parentId)) {
      return err(agentError('An agent is already replying in this thread.'));
    }

    // Fail before spawning anything if the file's comments aren't postable.
    // One combined lookup instead of two: `resolveCommentTarget` and
    // `resolveCommentWorkspaceRoot` both walk up from the same directory to
    // find the same binding, and this is the one call site that needs both
    // results for the same `absPath` (see `resolveCommentDispatchContext`).
    const dispatchContext = resolveCommentDispatchContext(absPath);
    if (!dispatchContext) {
      return err<RigCommentsError>({
        kind: 'notBound',
        message: "This workspace isn't synced to a rig",
      });
    }
    const { target } = dispatchContext;
    // Same trust gate the posting path enforces (`comments.ts`): the reply
    // could never be posted, so don't run a whole agent turn to find out.
    const trust = checkRelayTrust(target.relayUrl);
    if (!trust.trusted) {
      return err<RigCommentsError>({
        kind: 'untrustedRelay',
        host: trust.host,
        message: `This workspace points comments at an unrecognized relay (${trust.host}) — comments are disabled.`,
      });
    }

    // The agent's cwd: this app has no emdash task/workspace registry behind
    // a bound-rig folder open, so the dispatch runs directly in the rig's own
    // workspace root (or linked-worktree root) — the same directory
    // `resolveCommentTarget` above just resolved `relPath` against. Doubles
    // as the ACP connection-sharing key (`workspaceId`, below): headless
    // turns dispatched in the same rig with the same provider share one agent
    // process, same as the emdash task system's `workspaceId` always did.
    const cwd = dispatchContext.cwd;
    const workspaceId = cwd;

    const conversationId = randomUUID();
    const model = request.model?.trim() || null;
    const { text, hiddenContext } = composeCommentAgentPrompt(
      request,
      target.relPath,
      target.bindingId
    );
    const initialQueue = [{ text, hiddenContext }];

    let client: AcpRuntimeClient;
    try {
      client = await getAcpRuntimeClient();
    } catch (error) {
      log.warn('Rig comment agent: ACP runtime unavailable', { providerId, error: String(error) });
      return err(agentError('The agent runtime could not be started.'));
    }

    // Re-checked (the runtime lookup above awaited, so two mentions could have
    // interleaved past the early guard) and reserved synchronously: from here
    // to the `try` there is no await, so the `finally` below always releases it.
    if (liveTurns.has(parentId)) {
      return err(agentError('An agent is already replying in this thread.'));
    }
    liveTurns.set(parentId, conversationId);

    // Subscribe before the turn can start, so a fast agent cannot finish first.
    // `let`, not `const`: a model-unsupported retry (see the classifier
    // below) swaps this for a fresh deadline bound to the SAME
    // conversation's second turn — every reference below reads `turn`
    // fresh rather than closing over one turn's methods, so the retry's
    // own idle/absolute clock is what activity and permission waits
    // actually extend.
    let turn = awaitTurnEnd(conversationId);
    let permissions: { dispose: () => void } | null = null;
    let progress: { dispose: () => void; latestText: () => string } | null = null;

    /**
     * Requests already auto-approved for this turn, so a re-emitted
     * `pendingPermissions` state (the resolution round-trip has not yet
     * removed it) is never resolved — or surfaced — twice.
     */
    const autoApprovedRequestIds = new Set<string>();

    /**
     * Resolves one auto-approved request through the same `resolvePermission`
     * mechanism the card's own Allow button uses below, logging at debug
     * (never a card, per the caller) and warning only on the round-trip
     * itself failing. `label` names which auto-approve path is granting the
     * request, for that log line only.
     */
    const resolveAutoApproved = (label: string, requestId: string, optionId: string): void => {
      log.debug(`Rig comment agent: ${label}`, { conversationId, requestId });
      void client.resolvePermission({ conversationId, requestId, optionId }).then(
        (resolved) => {
          if (!resolved.success) {
            log.warn(`Rig comment agent: could not auto-approve — ${label}`, {
              conversationId,
              requestId,
              error: String(resolved.error.type),
            });
          }
        },
        (error: unknown) => {
          log.warn(`Rig comment agent: could not auto-approve — ${label}`, {
            conversationId,
            requestId,
            error: String(error),
          });
        }
      );
    };

    /**
     * One publish path for both consumers: the card that draws the buttons, and
     * the clock that must not run while they are unanswered. Read-only
     * `rig context` lookups are always filtered out and resolved directly
     * here (see the module doc comment and `comment-agent-auto-approve.ts`).
     * When the reader has turned on Settings → Agents → "Auto-approve agent
     * actions" (`rigSettingsStore`), everything `partitionAutoApprovable` left
     * visible is resolved the same way too, via `partitionGloballyApprovable`
     * — so `visible` ends up empty and no card is ever published for this
     * turn. Read fresh on every publish rather than cached at turn start: a
     * reader who flips the setting mid-turn (from the card's own "Always
     * allow" link, or from Settings) sees it take effect on this turn's very
     * next pending request, not just the next mention.
     */
    const publishPermissions = (requests: RigCommentPermissionRequest[]): void => {
      const afterContextAutoApprove = partitionAutoApprovable(
        requests,
        autoApprovedRequestIds,
        (requestId, optionId) =>
          resolveAutoApproved('auto-approving a read-only context lookup', requestId, optionId)
      );
      const visible = rigSettingsStore.get().autoApproveAgentActions
        ? partitionGloballyApprovable(afterContextAutoApprove, autoApprovedRequestIds, (requestId, optionId) =>
            resolveAutoApproved(
              'auto-approving via the global "Auto-approve agent actions" setting',
              requestId,
              optionId
            )
          )
        : afterContextAutoApprove;
      turn.setAwaitingPermission(visible.length > 0);
      events.emit(rigCommentPermissionsChannel, {
        absPath,
        rootId: parentId,
        requests: visible,
        workspaceRoot: cwd,
      });
    };
    const publishProgress = (update: CommentAgentProgress): void => {
      events.emit(rigCommentAgentProgressChannel, {
        absPath,
        rootId: parentId,
        activity: update.activity,
        text: update.text,
      });
    };

    try {
      // No `createConversation()` here: emdash's version inserts a row into
      // the `conversations` table with `NOT NULL` foreign keys into `projects`
      // and `tasks` — real DB constraints a bound-rig folder's synthesized
      // ids could never satisfy (there is no project/task row, by design).
      // Its side effects (the conversation list refresh event, an optimistic
      // "start" status, a telemetry ping) are all consumed by chat-panel UI
      // this headless turn never shows anyway. Everything the turn actually
      // needs — the live session, its transcript, its permission requests —
      // lives entirely in the ACP runtime worker's own in-memory state,
      // keyed by `conversationId`, and never touches this app's SQLite DB
      // (see `packages/runtime/src/acp-agents/runtime/session-manager.ts`).
      //
      // `projectId`/`taskId` below are therefore opaque labels, not database
      // keys: the wire schema (`acpStartInputSchema`) requires plain strings
      // for logging/telemetry and for `resetToIdle`'s best-effort DB lookup
      // (a no-op when, as here, no row exists) — never validated against a
      // real project or task. `target.bindingId` and the thread's own
      // `parentId` are the honest values to put there for a headless,
      // task-less dispatch.
      const started = await client.startSession({
        input: {
          conversationId,
          projectId: target.bindingId,
          taskId: parentId,
          providerId,
          workspaceId,
          cwd,
          sessionId: null,
          model,
          initialQueue,
        },
      });
      if (!started.success) {
        // The full error, not just `.type`: `.type` alone ("initialize_failed")
        // says nothing about *why* — diagnosing a real failure (codex's
        // missing platform binary, see the punch-list report) meant grepping
        // the ACP runtime worker's own log line instead of this one, because
        // this one used to discard everything but the tag.
        log.warn('Rig comment agent: could not start the session', {
          conversationId,
          providerId,
          error: started.error,
        });
        const detail = causeMessage(started.error);
        return err(
          agentError(
            detail ? `The agent could not be started: ${detail}` : 'The agent could not be started.'
          )
        );
      }

      // Only now do the per-session live topics exist — attaching any earlier
      // fails with UNKNOWN_TOPIC (same constraint the intent bridge works under).
      permissions = followPermissions(client, conversationId, publishPermissions);
      // Wrapped rather than passed as a bound method reference: `turn` may
      // be reassigned to a retry deadline mid-turn (see below), and this
      // must always tick the CURRENT one.
      progress = followProgress(client, conversationId, publishProgress, () => turn.noteActivity());

      const outcome = await turn.outcome;
      if (outcome === 'error') {
        return err(agentError('The agent stopped with an error before answering.'));
      }

      // Started together rather than back-to-back: `readSessionModel` is one
      // round trip and `readAnswer` may poll for seconds, so awaiting them in
      // sequence only delays the answer by the model read for no benefit.
      // Firing `readSessionModel` immediately (rather than after `readAnswer`
      // settles) still matters for correctness, not just speed — a later
      // `config_option_update` that omits the model category resets
      // `modelOptions` to null, so the read has to win the race against that,
      // and starting it up front gives it the same head start it had before.
      const [sessionModel, historyAnswer] = await Promise.all([
        readSessionModel(client, conversationId),
        readAnswer(client, conversationId),
      ]);
      let usedModel = sessionModel ?? model;

      const rawAnswer =
        historyAnswer ?? (outcome === 'completed' ? progress.latestText() || null : null);
      if (!rawAnswer) {
        return err(
          agentError(
            outcome === 'timeout'
              ? 'The agent did not answer in time.'
              : 'The agent finished without writing an answer.'
          )
        );
      }

      // Graceful provider failure (paintbrush v1 punch list, finding 5): a
      // provider's own hard failure — most commonly the codex-acp adapter's
      // bundled Codex rejecting the user's globally-configured model — can
      // surface as plain assistant TEXT (`Warning:` chatter plus a raw JSON
      // error body) rather than a real ACP error, so it would otherwise be
      // posted to the thread verbatim. `classifyProviderAnswer` is pure and
      // detects that shape; see its own doc comment for the root cause.
      let classification = classifyProviderAnswer(rawAnswer);
      if (classification.strippedWarnings.length > 0) {
        log.debug('Rig comment agent: stripped leading provider warnings from an answer', {
          conversationId,
          warnings: classification.strippedWarnings,
        });
      }

      // Best-effort, ONE-SHOT retry: only for the model-unsupported class,
      // and only when the session actually offers another real model to
      // fall back to. Never loops — `classification` is reassigned at most
      // once here, and a retry that itself fails (to switch models, to send,
      // or to answer cleanly) just falls through to reporting the ORIGINAL
      // failure below, exactly as if no retry had been attempted.
      if (classification.kind === 'failure' && classification.reason === 'model-unsupported') {
        const choices = await readModelChoices(client, conversationId);
        const substitute = pickModelSubstitute(choices, usedModel);
        if (substitute) {
          const switched = await client.setModelOption({
            conversationId,
            dimension: 'model',
            value: substitute,
          });
          if (switched.success) {
            const sent = await client.sendPrompt({ conversationId, prompt: { text, hiddenContext } });
            if (sent.success) {
              // A fresh deadline for the SECOND turn — `turn` is reassigned
              // (not shadowed), so every existing reference to it (the
              // progress ticker above, `publishPermissions` below, and this
              // function's own `finally`) now tracks the retry instead.
              turn = awaitTurnEnd(conversationId);
              const retryOutcome = await turn.outcome;
              if (retryOutcome !== 'error') {
                const [retryModel, retryHistoryAnswer] = await Promise.all([
                  readSessionModel(client, conversationId),
                  readAnswer(client, conversationId),
                ]);
                const retryRaw =
                  retryHistoryAnswer ??
                  (retryOutcome === 'completed' ? progress.latestText() || null : null);
                const retryClassification = retryRaw ? classifyProviderAnswer(retryRaw) : null;
                if (retryClassification && retryClassification.kind === 'ok') {
                  log.info('Rig comment agent: retried a paintbrush stroke on a substitute model', {
                    conversationId,
                    from: usedModel,
                    to: substitute,
                  });
                  classification = {
                    kind: 'ok',
                    text: `(retried with ${substitute} after ${usedModel ?? 'the configured model'} could not run this stroke)\n\n${retryClassification.text}`,
                    strippedWarnings: retryClassification.strippedWarnings,
                  };
                  usedModel = retryModel ?? substitute;
                }
              }
            }
          }
        }
      }

      if (classification.kind === 'failure') {
        return err(agentError(classification.message));
      }
      const cleanAnswer = classification.text;

      // Paintbrush strokes ask the agent for a structured replacement
      // alongside its prose (`comment-agent-prompt.ts`); every other mention
      // path posts the transcript answer verbatim, same as always.
      const { body: answer, proposal } = request.paintbrush
        ? extractProposal(cleanAnswer)
        : { body: cleanAnswer, proposal: null };

      return await rigCommentsController.reply({
        absPath,
        parentId,
        body: answer,
        authorKind: 'agent',
        meta: {
          agent: agentLabel(providerId),
          ...(usedModel ? { model: usedModel } : {}),
          ...(proposal ? { proposal } : {}),
        },
      });
    } catch (error) {
      log.warn('Rig comment agent: mention failed', {
        conversationId,
        providerId,
        error: String(error),
      });
      return err(agentError('The agent could not be reached.'));
    } finally {
      turn.dispose();
      liveTurns.delete(parentId);
      permissions?.dispose();
      progress?.dispose();
      // The card outlives the turn by a moment: clear its buttons explicitly, so
      // a request abandoned by `stopSession` can never be left dangling in the
      // margin with nothing behind it.
      events.emit(rigCommentPermissionsChannel, {
        absPath,
        rootId: parentId,
        requests: [],
        workspaceRoot: cwd,
      });
      // Release this conversation's lease on the shared per-provider/workspace
      // agent process. It is refcounted, so a foreground session in the same
      // worktree keeps the process alive; only the last holder shuts it down.
      await client.stopSession({ conversationId }).catch(() => {
        // The session may already be gone; nothing here is worth surfacing.
      });
    }
  },

  /**
   * Settles one permission request raised by a thread's headless turn, from the
   * button the reader pressed in the margin.
   *
   * Keyed by thread, because that is all the renderer knows. The published set
   * updates itself: settling changes the session state, which the follower
   * republishes — nothing here patches the card.
   */
  resolveCommentPermission: async (input: {
    rootId: string;
    requestId: string;
    optionId: string;
  }): Promise<Result<void, RigCommentsError>> => {
    const conversationId = liveTurns.get(input.rootId);
    if (!conversationId) {
      return err(agentError('That agent turn is no longer running.'));
    }
    let client: AcpRuntimeClient;
    try {
      client = await getAcpRuntimeClient();
    } catch (error) {
      log.warn('Rig comment agent: ACP runtime unavailable while resolving a permission', {
        conversationId,
        error: String(error),
      });
      return err(agentError('The agent runtime is not available.'));
    }
    const resolved = await client.resolvePermission({
      conversationId,
      requestId: input.requestId,
      optionId: input.optionId,
    });
    if (!resolved.success) {
      log.warn('Rig comment agent: could not resolve a permission request', {
        conversationId,
        requestId: input.requestId,
        error: String(resolved.error.type),
      });
      return err(agentError('That request could not be answered — it may have expired.'));
    }
    return ok();
  },
});
