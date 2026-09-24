import { randomUUID } from 'node:crypto';
import { sessionStateSchema, type AcpPermissionRequest, type SessionState } from '@emdash/core/acp';
import { err, ok, type Result } from '@emdash/shared';
import { ReplicaLog, ReplicaState } from '@emdash/wire';
import type { AcpRuntimeClient } from '@main/core/acp/controller';
import { log } from '@main/lib/logger';
import type { AgentRequest, SessionAgent, SessionStatus, SpacesRelayApi } from './relay-api';
import { markRequestSettled, type ClaimDispatchResult } from './request-claim';
import { SessionEventPublisher } from './session-publisher';

/**
 * Spaces (lane 4): the real `dispatch` callback `RequestClaimPoller` needs —
 * "start (or reuse) the owner's persistent agent session for that space,
 * pipe its raw ACP events into a relay session run, and settle the request
 * once the turn ends." One persistent session per (space, owner, agent):
 * a second claimed request for the same key reuses the already-running ACP
 * session (via `queuePrompt`, never a second `startSession`) rather than
 * spawning a second CLI process for the same agent in the same space.
 *
 * **Turn boundaries are in-band.** A prior version of this module attributed
 * raw events to a turn using a separate `subscribeBusy` (busy/idle) signal,
 * which arrives on a different live channel from `subscribeRaw` with no
 * ordering guarantee relative to it. That dropped events that arrived before
 * the busy→generating edge (`current` still null) and, worse, events that
 * arrived after the generating→idle edge — including the turn's own final
 * `agent_message_chunk` — because the busy edge had already finalized (and
 * finished the publisher for) the turn. Fixed by having the runtime itself
 * emit `turn_start`/`turn_end` markers into the SAME ordered raw-event
 * stream `subscribeRaw` already delivers (see
 * `SessionCellCallbacks.onTurnBoundary` in `packages/runtime`): ACP
 * guarantees a turn's `session/update` notifications precede its prompt
 * response, so a `turn_end` appended at that response's resolve time is
 * always ordered after every one of them. Dispatch now attributes events
 * and finalizes turns from these markers alone.
 *
 * `SpacesAcpSessions` is the seam: everything this module needs from the
 * ACP runtime (start/queue/cancel a turn, and observe its raw event stream,
 * turn markers included), small enough to fake in tests without a real ACP
 * runtime worker or wire transport. `createRuntimeAcpSessions` (bottom of
 * this file) is the one real implementation, thin and deliberately
 * untested in isolation — same posture `relay-api.ts`'s HTTP implementation
 * takes, exercised indirectly through this module's own tests instead.
 */

export type RawSessionEvent =
  | { kind: 'acp_update'; sessionId: string; update: { sessionUpdate: string } & Record<string, unknown> }
  | { kind: 'turn_start'; turnId: string }
  | { kind: 'turn_end'; turnId: string; stopReason: string | null };

export interface SpacesAcpSessions {
  /** Starts a brand-new local ACP session. Resolves once the session exists — never waits for a turn. */
  startSession(input: {
    conversationId: string;
    providerId: SessionAgent;
    cwd: string;
  }): Promise<Result<void, string>>;
  /**
   * Enqueues one prompt; safe whether the session is idle or already busy —
   * never blocks on the turn it starts or joins. Resolves with the queued
   * prompt's own `turnId`, the same id that will label its `turn_start`/
   * `turn_end` markers on `subscribeRaw`'s stream — the caller's one
   * guaranteed way to bind this specific request to exactly its own turn.
   */
  queuePrompt(
    conversationId: string,
    text: string,
    hiddenContext?: string
  ): Promise<Result<{ turnId: string }, string>>;
  /** Best-effort: asks the runtime to cancel whatever turn is currently running. */
  cancelTurn(conversationId: string): Promise<void>;
  /**
   * Registers a raw-event observer. Must be called (and resolved) BEFORE
   * `startSession`/the first `queuePrompt`, so nothing from the very first
   * turn is missed. Returns an unsubscribe function.
   */
  subscribeRaw(
    conversationId: string,
    onEvent: (raw: RawSessionEvent) => void
  ): Promise<() => void>;
  /**
   * Registers an observer for this conversation's pending ACP permission
   * requests. Must be called (and resolved) BEFORE `startSession`, same
   * ordering requirement as `subscribeRaw`, so a request raised on the very
   * first turn is never missed. Returns an unsubscribe function.
   */
  subscribePendingPermissions(
    conversationId: string,
    onRequest: (request: AcpPermissionRequest) => void
  ): Promise<() => void>;
  /** Resolves one pending permission request by choosing one of its own option ids. */
  resolvePermission(conversationId: string, requestId: string, optionId: string): Promise<void>;
}

type PersistentKey = string;

type QueuedTurn = {
  requestId: string;
  bindingId: string;
  runId: string;
  publisher: SessionEventPublisher;
  cancelledByStop: boolean;
  /**
   * Set once `queuePrompt` resolves. May already be set by `claimTurn`
   * (below) before that happens — a `turn_start` marker can legitimately
   * beat the RPC response acknowledging the very call that caused it, since
   * they travel over different sub-channels of the same connection.
   */
  turnId: string | null;
};

type PersistentSession = {
  conversationId: string;
  providerId: SessionAgent;
  cwd: string;
  /** Turns submitted (via `queuePrompt`) whose `turn_start` marker hasn't claimed them yet. FIFO — the runtime's own prompt queue is FIFO too. */
  pending: QueuedTurn[];
  /** The turn presently between its `turn_start` and matching `turn_end` marker, or null while idle. */
  current: QueuedTurn | null;
  /** Permission requests waiting on the owner's answer, by ACP request id. */
  heldPermissions: Map<string, { request: AcpPermissionRequest; turn: QueuedTurn }>;
};

/**
 * Context the agent gets with every spaces turn, alongside (not inside) the
 * user's own text: where it is, that everyone sees its work, and how to
 * reply. Kept short; the rig skill carries the longer guidance.
 */
export function spacesHiddenContext(request: AgentRequest): string {
  return [
    '<rig_space_context>',
    `You are working in a shared rig space (binding ${request.bindingId}).`,
    "The request comes from your owner, a member of the space; you run on their machine, in the space's folder.",
    'Everything you do in this turn (steps, tool calls, files, your final message) is visible to every member of the space, as a session card in the room.',
    'Your final message is your reply to the room. Do not also post it with `rig chat send`.',
    'Keep the reply short and direct; members can expand the card to see your full trace.',
    'When asked why something changed, use the rig change history (`rig history <path>`) rather than guessing.',
    '</rig_space_context>',
  ].join('\n');
}

function keyFor(bindingId: string, ownerUserId: string, agent: SessionAgent): PersistentKey {
  return `${bindingId}::${ownerUserId}::${agent}`;
}

/**
 * Claims the pending turn a `turn_start{turnId}` marker refers to. Prefers
 * an entry `queuePrompt` has already stamped with this exact `turnId`; if
 * the marker arrived first (see `QueuedTurn.turnId`'s own doc comment),
 * falls back to the oldest not-yet-stamped entry — FIFO is safe here
 * because the ACP session processes its prompt queue serially, one turn at
 * a time — and retroactively stamps it so a later `queuePrompt` resolution
 * or a `stopRun` lookup by `runId` still finds the right entry.
 */
function claimTurn(session: PersistentSession, turnId: string): QueuedTurn | null {
  const stampedIdx = session.pending.findIndex((turn) => turn.turnId === turnId);
  if (stampedIdx !== -1) return session.pending.splice(stampedIdx, 1)[0]!;

  const idx = session.pending.findIndex((turn) => turn.turnId === null);
  if (idx === -1) return null;
  const turn = session.pending.splice(idx, 1)[0]!;
  turn.turnId = turnId;
  return turn;
}

/**
 * A turn's terminal status, read off the ONE signal a `turn_end` marker
 * actually carries: `stopReason`. On a normal turn it's always a real stop
 * reason (`end_turn`, ...); on an explicit cancel it's exactly
 * `'cancelled'`; on an in-turn error it is — deliberately, per the session
 * machine's own `TurnEnded` handling — left `null`, the one value a normal
 * completion never produces. `cancelledByStop` (set by `stopRun`, below) is
 * checked first because a fast user double-stop could otherwise race a
 * `stopReason` that hasn't updated yet.
 */
function statusForEndedTurn(turn: QueuedTurn, stopReason: string | null): SessionStatus {
  if (turn.cancelledByStop || stopReason === 'cancelled') return 'stopped';
  if (stopReason === null) return 'failed';
  return 'done';
}

function requestStatusFor(sessionStatus: SessionStatus): 'done' | 'failed' | 'cancelled' {
  if (sessionStatus === 'stopped') return 'cancelled';
  if (sessionStatus === 'failed') return 'failed';
  return 'done';
}

export function createSpacesDispatcher(deps: {
  api: SpacesRelayApi;
  acp: SpacesAcpSessions;
  /** Resolves a relay `bindingId` to this device's local workspace root, or null when nothing here is bound to it. */
  resolveWorkspace: (bindingId: string) => Promise<string | null>;
}): {
  dispatch: (request: AgentRequest) => Promise<ClaimDispatchResult>;
  /** Stops a run this device is (or was about to start) running. Returns false if this device has no such run — the structural half of "only the owner can stop it": a device that never dispatched a run has nothing here to find. */
  stopRun: (runId: string) => Promise<boolean>;
  /** Answers a held permission request on one of this device's runs. Returns false if this device holds no such request for that run, or the option isn't one it offered. */
  resolvePermission: (runId: string, requestId: string, optionId: string) => Promise<boolean>;
} {
  const sessions = new Map<PersistentKey, PersistentSession>();

  function forwardRaw(session: PersistentSession, raw: RawSessionEvent): void {
    switch (raw.kind) {
      case 'turn_start': {
        const turn = claimTurn(session, raw.turnId);
        if (turn) session.current = turn;
        return;
      }
      case 'turn_end': {
        const turn = session.current;
        // Ignore a marker that doesn't match the turn we think is current —
        // it can only be stale (e.g. delivered after `stopRun` already
        // finalized this turn from the pending queue).
        if (!turn || turn.turnId !== raw.turnId) return;
        session.current = null;
        releaseHeldPermissions(session, turn);
        void finalizeTurn(turn, statusForEndedTurn(turn, raw.stopReason));
        return;
      }
      case 'acp_update': {
        // 19–50KB each and useless in the log — see the goal's own instruction.
        if (raw.update.sessionUpdate === 'available_commands_update') return;
        const turn = session.current;
        if (!turn) return;
        turn.publisher.record(raw.update.sessionUpdate, raw.update);
        return;
      }
    }
  }

  async function finalizeTurn(turn: QueuedTurn, status: SessionStatus): Promise<void> {
    // The card flips out of "running" on this event (run status changes
    // aren't broadcast to the Room), so it must land before `finish`.
    turn.publisher.record('turn_ended', { status });
    await turn.publisher.finish(status);
    await markRequestSettled(
      deps.api,
      { bindingId: turn.bindingId, id: turn.requestId },
      requestStatusFor(status)
    );
  }

  /**
   * Spaces turns only ever run the requester's OWN agent on their own device
   * (no cross-person delegation in the MVP), so a permission request waits
   * for its owner rather than being settled here: it's recorded in the run
   * log with its options, and the owner's own session card answers it via
   * `resolvePermission` below. Other members see the same log event and
   * render at most a muted "waiting on approval" line. Nothing is ever
   * auto-approved or auto-declined. Normal chat sessions never reach this;
   * their own permission flow is untouched.
   *
   * Permission requests arrive on a different channel (session state) from
   * the raw event stream, so if one beats its own `turn_start` marker it's
   * attributed to the oldest queued turn — the one about to start.
   */
  function holdPermission(session: PersistentSession, request: AcpPermissionRequest): void {
    const turn = session.current ?? session.pending[0] ?? null;
    if (!turn) {
      log.warn('Rig spaces dispatch: permission request with no turn to attribute it to', {
        conversationId: session.conversationId,
        requestId: request.requestId,
      });
      return;
    }
    session.heldPermissions.set(request.requestId, { request, turn });
    turn.publisher.record('permission_requested', {
      requestId: request.requestId,
      toolCall: { toolCallId: request.toolCall.toolCallId, title: request.toolCall.title },
      options: request.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
      })),
      pubTs: Date.now(),
    });
  }

  function recordPermissionDecided(
    turn: QueuedTurn,
    request: AcpPermissionRequest,
    optionId: string | null,
    outcome: 'allowed' | 'declined' | 'cancelled'
  ): void {
    turn.publisher.record('permission_decided', {
      requestId: request.requestId,
      toolCallId: request.toolCall.toolCallId,
      optionId,
      outcome,
    });
  }

  /** A turn that ends with approvals still held (Stop, error) settles them as cancelled so no card keeps showing them pending. */
  function releaseHeldPermissions(session: PersistentSession, turn: QueuedTurn): void {
    for (const [requestId, held] of session.heldPermissions) {
      if (held.turn !== turn) continue;
      session.heldPermissions.delete(requestId);
      recordPermissionDecided(turn, held.request, null, 'cancelled');
    }
  }

  async function resolvePermission(runId: string, requestId: string, optionId: string): Promise<boolean> {
    for (const session of sessions.values()) {
      const held = session.heldPermissions.get(requestId);
      if (!held || held.turn.runId !== runId) continue;
      const option = held.request.options.find((o) => o.optionId === optionId);
      if (!option) return false;
      session.heldPermissions.delete(requestId);
      // Recorded before resolving: once the tool runs, the turn can end (and
      // its publisher finish) before the resolve call even returns.
      recordPermissionDecided(
        held.turn,
        held.request,
        optionId,
        option.kind.startsWith('reject') ? 'declined' : 'allowed'
      );
      await deps.acp.resolvePermission(session.conversationId, requestId, optionId);
      return true;
    }
    return false;
  }

  async function ensureSession(
    key: PersistentKey,
    bindingId: string,
    providerId: SessionAgent,
    cwd: string
  ): Promise<Result<PersistentSession, string>> {
    const existing = sessions.get(key);
    if (existing) return ok(existing);

    const conversationId = randomUUID();
    const session: PersistentSession = {
      conversationId,
      providerId,
      cwd,
      pending: [],
      current: null,
      heldPermissions: new Map(),
    };
    // Subscribe BEFORE the session exists so nothing from the very first
    // turn — including its very first raw event/permission request — is
    // missed.
    await deps.acp.subscribeRaw(conversationId, (raw) => forwardRaw(session, raw));
    await deps.acp.subscribePendingPermissions(conversationId, (request) =>
      holdPermission(session, request)
    );

    const started = await deps.acp.startSession({ conversationId, providerId, cwd });
    if (!started.success) return err(started.error);

    sessions.set(key, session);
    return ok(session);
  }

  async function dispatch(request: AgentRequest): Promise<ClaimDispatchResult> {
    const cwd = await deps.resolveWorkspace(request.bindingId);
    if (!cwd) {
      return {
        failed: true,
        reason: `No local workspace on this device is bound to ${request.bindingId}`,
      };
    }

    const key = keyFor(request.bindingId, request.targetOwnerUserId, request.targetAgent);
    const sessionResult = await ensureSession(key, request.bindingId, request.targetAgent, cwd);
    if (!sessionResult.success) {
      return { failed: true, reason: sessionResult.error };
    }
    const session = sessionResult.data;

    // The run must exist on the relay BEFORE this returns — `runId` is a
    // real foreign key the request's own `running` patch depends on.
    const created = await deps.api.createSession(request.bindingId, {
      agent: request.targetAgent,
      title: request.prompt.slice(0, 80) || null,
    });
    if (!created.success) {
      return { failed: true, reason: created.error.message };
    }

    // The session card only appears in the Room when a `kind:'session'`
    // message points at the run, so announce it. Not fatal if it fails:
    // the run still executes and its log is still published.
    const announced = await deps.api.postMessage(request.bindingId, {
      body: request.prompt.slice(0, 8000) || 'Agent session',
      kind: 'session',
      meta: { runId: created.data.id },
    });
    if (!announced.success) {
      log.warn('Rig spaces dispatch: could not post the session message for a run', {
        bindingId: request.bindingId,
        runId: created.data.id,
        error: announced.error.message,
      });
    }

    const publisher = new SessionEventPublisher({
      api: deps.api,
      bindingId: request.bindingId,
      runId: created.data.id,
    });
    const turn: QueuedTurn = {
      requestId: request.id,
      bindingId: request.bindingId,
      runId: created.data.id,
      publisher,
      cancelledByStop: false,
      turnId: null,
    };
    session.pending.push(turn);

    const queued = await deps.acp.queuePrompt(
      session.conversationId,
      request.prompt,
      spacesHiddenContext(request)
    );
    if (!queued.success) {
      const idx = session.pending.indexOf(turn);
      if (idx !== -1) session.pending.splice(idx, 1);
      void finalizeTurn(turn, 'failed');
      return { failed: true, reason: queued.error };
    }
    // Stamp the turnId even if a fast `turn_start` already claimed this
    // entry (see `claimTurn`'s own doc comment) — same value either way,
    // and a no-op in the common case where `queuePrompt` resolves first.
    turn.turnId = queued.data.turnId;

    return { runId: created.data.id };
  }

  async function stopRun(runId: string): Promise<boolean> {
    for (const session of sessions.values()) {
      if (session.current?.runId === runId) {
        session.current.cancelledByStop = true;
        await deps.acp.cancelTurn(session.conversationId);
        return true;
      }
      const idx = session.pending.findIndex((turn) => turn.runId === runId);
      if (idx !== -1) {
        const [turn] = session.pending.splice(idx, 1);
        releaseHeldPermissions(session, turn);
        void finalizeTurn(turn, 'stopped');
        return true;
      }
    }
    return false;
  }

  return { dispatch, stopRun, resolvePermission };
}

/**
 * Mints (and memoizes, per binding, for this process's lifetime) this
 * device's id on a binding — the real `deviceId` resolver
 * `RequestClaimPoller` needs (see `request-claim.ts`'s `DeviceIdResolver`
 * doc comment: a cross-binding poller needs a DIFFERENT device id per
 * request's own `bindingId`, not one fixed id). Concurrent calls for the
 * SAME unminted binding share one in-flight mint rather than minting twice.
 */
export function createDeviceIdResolver(api: SpacesRelayApi): (bindingId: string) => Promise<string> {
  const minted = new Map<string, string>();
  const inFlight = new Map<string, Promise<string>>();

  return async (bindingId: string): Promise<string> => {
    const existing = minted.get(bindingId);
    if (existing) return existing;
    const pending = inFlight.get(bindingId);
    if (pending) return pending;

    const mint = (async () => {
      const result = await api.mintDevice(bindingId);
      if (!result.success) throw new Error(result.error.message);
      minted.set(bindingId, result.data.id);
      return result.data.id;
    })();
    inFlight.set(bindingId, mint);
    try {
      return await mint;
    } finally {
      inFlight.delete(bindingId);
    }
  };
}

// ── the one real SpacesAcpSessions implementation ──────────────────────────

function describeAcpError(error: unknown): string {
  if (error && typeof error === 'object' && 'type' in error) return String((error as { type: unknown }).type);
  return String(error);
}

export function createRuntimeAcpSessions(getClient: () => Promise<AcpRuntimeClient>): SpacesAcpSessions {
  return {
    async startSession({ conversationId, providerId, cwd }) {
      const client = await getClient();
      const result = await client.startSession({
        input: {
          conversationId,
          projectId: 'space',
          taskId: 'space',
          providerId,
          workspaceId: cwd,
          cwd,
          sessionId: null,
          model: null,
        },
      });
      return result.success ? ok(undefined) : err(describeAcpError(result.error));
    },

    async queuePrompt(conversationId, text, hiddenContext) {
      const client = await getClient();
      const result = await client.queuePrompt({
        conversationId,
        prompt: hiddenContext ? { text, hiddenContext } : { text },
      });
      return result.success ? ok({ turnId: result.data.turnId }) : err(describeAcpError(result.error));
    },

    async cancelTurn(conversationId) {
      const client = await getClient();
      const result = await client.cancelTurn({ conversationId });
      if (!result.success) {
        log.warn('Rig spaces dispatch: could not cancel the running turn', {
          conversationId,
          error: describeAcpError(result.error),
        });
      }
    },

    async subscribeRaw(conversationId, onEvent) {
      const client = await getClient();
      const replica = new ReplicaLog(client.sessionRawEvents.handle({ conversationId }));
      await replica.ready;
      const unsubscribe = replica.onAppend((chunk) => {
        for (const line of chunk.split('\n')) {
          if (!line) continue;
          try {
            onEvent(JSON.parse(line) as RawSessionEvent);
          } catch (error) {
            log.warn('Rig spaces dispatch: could not parse a raw session event line', {
              conversationId,
              error: String(error),
            });
          }
        }
      });
      return () => {
        unsubscribe();
        void replica.dispose();
      };
    },

    async subscribePendingPermissions(conversationId, onRequest) {
      const client = await getClient();
      const seen = new Set<string>();
      const replica = new ReplicaState<SessionState>(client.session.state({ conversationId }, 'state'), {
        schema: sessionStateSchema,
        onChange: (state) => {
          for (const request of state.pendingPermissions) {
            if (seen.has(request.requestId)) continue;
            seen.add(request.requestId);
            onRequest(request);
          }
        },
      });
      await replica.ready.catch((error: unknown) => {
        log.warn('Rig spaces dispatch: could not follow pending permission requests', {
          conversationId,
          error: String(error),
        });
      });
      return () => void replica.dispose();
    },

    async resolvePermission(conversationId, requestId, optionId) {
      const client = await getClient();
      const result = await client.resolvePermission({ conversationId, requestId, optionId });
      if (!result.success) {
        log.warn('Rig spaces dispatch: could not resolve a pending permission request', {
          conversationId,
          requestId,
          error: describeAcpError(result.error),
        });
      }
    },
  };
}
