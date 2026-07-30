import { randomUUID } from 'node:crypto';
import { sessionStateSchema, type SessionState, type TranscriptTurn } from '@emdash/core/acp';
import { asAgentProviderId } from '@emdash/plugins/agents';
import { err, ok, type Result } from '@emdash/shared';
import { ReplicaState } from '@emdash/wire';
import { getAcpRuntimeClient, type AcpRuntimeClient } from '@main/core/acp/controller';
import { agentHookService } from '@main/core/agent-hooks/agent-hook-service';
import { isValidProviderId } from '@main/core/agents/plugin-registry';
import { createConversation } from '@main/core/conversations/createConversation';
import { taskSessionManager } from '@main/core/tasks/task-session-manager';
import { workspaceRegistry } from '@main/core/workspaces/workspace-registry';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import {
  rigCommentPermissionsChannel,
  type RigCommentAgentRequest,
  type RigCommentMessage,
  type RigCommentPermissionRequest,
  type RigCommentThreadEntry,
  type RigCommentsError,
} from '@shared/rig/comments';
import { rigCommentsController, resolveCommentTarget } from './comments';

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

type TurnOutcome = 'completed' | 'error' | 'timeout';

function agentError(message: string): RigCommentsError {
  return { kind: 'agent', message };
}

// ── prompt ───────────────────────────────────────────────────────────────────

/**
 * Everything the agent gets. It has no conversation history and no chat panel,
 * so the file, the anchored passage and the whole thread have to be in here.
 *
 * The situational half rides in `hiddenContext` (delivered as a leading text
 * block by the runtime, `session/cell.ts`), leaving the reader's own words as
 * the visible prompt — the same shape the in-app thread replies use.
 */
function composePrompt(
  request: RigCommentAgentRequest,
  relPath: string
): { text: string; hiddenContext: string } {
  const question = request.thread[request.thread.length - 1];
  const earlier = request.thread.slice(0, -1);
  const quote = request.quote?.trim();

  const context: string[] = [`You are answering in a review comment thread on \`${relPath}\`.`];
  if (quote) {
    context.push(
      '',
      'The thread is anchored to this passage of the document:',
      '"""',
      quote,
      '"""'
    );
  }
  if (earlier.length > 0) {
    context.push('', 'The thread so far, oldest first:', ...earlier.map(formatEntry));
  }
  context.push(
    '',
    'Your entire output is posted verbatim as one reply in this thread, by the app, on your behalf. Do not try to post it yourself.',
    'Answer concisely and directly: a few sentences of plain prose, no preamble and no sign-off. This is a comment in a review thread, not a report.'
  );

  return { text: question?.body.trim() ?? '', hiddenContext: context.join('\n') };
}

function formatEntry(entry: RigCommentThreadEntry): string {
  return `- ${entry.author}: ${entry.body.replace(/\s+/g, ' ').trim()}`;
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
  /** Stops the idle clock while a human is deciding; restarts it once they have. */
  setAwaitingPermission: (waiting: boolean) => void;
  dispose: () => void;
} {
  let settle: (outcome: TurnOutcome) => void = () => {};
  const outcome = new Promise<TurnOutcome>((resolve) => {
    settle = resolve;
  });

  let live = true;
  let waiting = false;
  let unsubscribe: () => void = () => {};
  let idleTimer: NodeJS.Timeout | null = null;
  let absoluteTimer: NodeJS.Timeout | null = null;

  const stopIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };

  const armIdle = (): void => {
    stopIdle();
    idleTimer = setTimeout(() => finish('timeout'), IDLE_TIMEOUT_MS);
  };

  const finish = (value: TurnOutcome): void => {
    if (!live) return;
    live = false;
    stopIdle();
    if (absoluteTimer) clearTimeout(absoluteTimer);
    unsubscribe();
    settle(value);
  };

  unsubscribe = agentHookService.on('agent:event', (event) => {
    if (event.conversationId !== conversationId) return;
    if (event.type === 'stop') finish('completed');
    else if (event.type === 'error') finish('error');
  });

  absoluteTimer = setTimeout(() => {
    log.warn('Rig comment agent: turn hit the absolute deadline', {
      conversationId,
      limitMs: ABSOLUTE_TIMEOUT_MS,
      awaitingPermission: waiting,
    });
    finish('timeout');
  }, ABSOLUTE_TIMEOUT_MS);
  armIdle();

  return {
    outcome,
    setAwaitingPermission: (next: boolean): void => {
      if (!live || next === waiting) return;
      waiting = next;
      // Restarting from zero rather than resuming: once the reader has answered,
      // the agent gets a full working window to act on the answer.
      if (next) stopIdle();
      else armIdle();
    },
    dispose: () => finish('timeout'),
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

function toPermissionRequests(
  pending: SessionState['pendingPermissions']
): RigCommentPermissionRequest[] {
  return pending.map((request) => ({
    requestId: request.requestId,
    title: request.toolCall.title,
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

/** The assistant prose of the most recent turn that has any. */
function assistantText(turns: readonly TranscriptTurn[]): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    const text = turns[i].items
      .flatMap((item) => (item.kind === 'message' && item.role === 'assistant' ? [item.text] : []))
      .join('\n\n')
      .trim();
    if (text) return text;
  }
  return '';
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
    const { absPath, projectId, taskId, parentId, providerId } = request;

    if (request.thread.length === 0) {
      return err(agentError('There is nothing in the thread to answer.'));
    }
    if (!isValidProviderId(providerId)) {
      return err(agentError(`Unknown agent: ${providerId}.`));
    }

    // Fail before spawning anything if the file's comments aren't postable.
    const target = resolveCommentTarget(absPath);
    if (!target) {
      return err<RigCommentsError>({
        kind: 'notBound',
        message: "This workspace isn't synced to a rig",
      });
    }

    // The doc tab belongs to a live task, so its workspace is mounted: this is a
    // pure read of the registries, with none of `provisionWorkspace`'s side effects.
    const workspaceId = taskSessionManager.getWorkspaceId(taskId);
    const cwd = workspaceId ? workspaceRegistry.get(workspaceId)?.path : undefined;
    if (!workspaceId || !cwd) {
      return err(agentError("This task's workspace isn't running, so no agent can be started."));
    }

    const conversationId = randomUUID();
    const model = request.model?.trim() || null;
    const { text, hiddenContext } = composePrompt(request, target.relPath);
    const initialQueue = [{ text, hiddenContext }];

    let client: AcpRuntimeClient;
    try {
      client = await getAcpRuntimeClient();
    } catch (error) {
      log.warn('Rig comment agent: ACP runtime unavailable', { providerId, error: String(error) });
      return err(agentError('The agent runtime could not be started.'));
    }

    // Subscribe before the turn can start, so a fast agent cannot finish first.
    const turn = awaitTurnEnd(conversationId);
    let permissions: { dispose: () => void } | null = null;

    /**
     * One publish path for both consumers: the card that draws the buttons, and
     * the clock that must not run while they are unanswered.
     */
    const publishPermissions = (requests: RigCommentPermissionRequest[]): void => {
      turn.setAwaitingPermission(requests.length > 0);
      events.emit(rigCommentPermissionsChannel, { absPath, rootId: parentId, requests });
    };

    try {
      // For `type: 'acp'` this only inserts the row — no session starts here, and
      // `initialQueue` is honoured exactly once, before a sessionId exists.
      await createConversation({
        id: conversationId,
        projectId,
        taskId,
        provider: asAgentProviderId(providerId),
        title: 'Re: doc comment',
        type: 'acp',
        ...(model ? { model } : {}),
        initialQueue,
      });

      const started = await client.startSession({
        input: {
          conversationId,
          projectId,
          taskId,
          providerId,
          workspaceId,
          cwd,
          sessionId: null,
          model,
          initialQueue,
        },
      });
      if (!started.success) {
        log.warn('Rig comment agent: could not start the session', {
          conversationId,
          providerId,
          error: String(started.error.type),
        });
        return err(agentError('The agent could not be started.'));
      }

      // Only now do the per-session live topics exist — attaching any earlier
      // fails with UNKNOWN_TOPIC (same constraint the intent bridge works under).
      liveTurns.set(parentId, conversationId);
      permissions = followPermissions(client, conversationId, publishPermissions);

      const outcome = await turn.outcome;
      if (outcome === 'error') {
        return err(agentError('The agent stopped with an error before answering.'));
      }

      // Before `readAnswer`, which may poll for seconds: a later `config_option_update`
      // that omits the model category resets `modelOptions` to null.
      const usedModel = (await readSessionModel(client, conversationId)) ?? model;

      const answer = await readAnswer(client, conversationId);
      if (!answer) {
        return err(
          agentError(
            outcome === 'timeout'
              ? 'The agent did not answer in time.'
              : 'The agent finished without writing an answer.'
          )
        );
      }

      return await rigCommentsController.reply({
        absPath,
        parentId,
        body: answer,
        authorKind: 'agent',
        meta: { agent: agentLabel(providerId), ...(usedModel ? { model: usedModel } : {}) },
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
      // The card outlives the turn by a moment: clear its buttons explicitly, so
      // a request abandoned by `stopSession` can never be left dangling in the
      // margin with nothing behind it.
      events.emit(rigCommentPermissionsChannel, { absPath, rootId: parentId, requests: [] });
      // Release this conversation's lease on the shared per-provider/workspace
      // agent process. It is refcounted, so a foreground session in the same
      // worktree keeps the process alive; only the last holder shuts it down.
      void client.stopSession({ conversationId }).catch(() => {
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
