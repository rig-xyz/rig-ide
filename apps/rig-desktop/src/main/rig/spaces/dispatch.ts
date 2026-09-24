import { randomUUID } from 'node:crypto';
import { sessionStateSchema, type SessionState } from '@emdash/core/acp';
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
 * `SpacesAcpSessions` is the seam: everything this module needs from the
 * ACP runtime (start/queue/cancel a turn, and observe its raw events plus
 * its busy/idle edges), small enough to fake in tests without a real ACP
 * runtime worker or wire transport. `createRuntimeAcpSessions` (bottom of
 * this file) is the one real implementation, thin and deliberately
 * untested in isolation — same posture `relay-api.ts`'s HTTP implementation
 * takes, exercised indirectly through this module's own tests instead.
 */

export type RawSessionEvent = { sessionId: string; update: { sessionUpdate: string } & Record<string, unknown> };

/** One `isGenerating` sample — fired once immediately (the current value) and again on every flip. */
export type BusyChange = { isGenerating: boolean; lastStopReason: string | null };

export interface SpacesAcpSessions {
  /** Starts a brand-new local ACP session. Resolves once the session exists — never waits for a turn. */
  startSession(input: {
    conversationId: string;
    providerId: SessionAgent;
    cwd: string;
  }): Promise<Result<void, string>>;
  /** Enqueues one prompt; safe whether the session is idle or already busy — never blocks on the turn it starts or joins. */
  queuePrompt(conversationId: string, text: string): Promise<Result<void, string>>;
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
  /** Same ordering requirement as `subscribeRaw`. Returns an unsubscribe function. */
  subscribeBusy(conversationId: string, onChange: (change: BusyChange) => void): Promise<() => void>;
}

type PersistentKey = string;

type QueuedTurn = {
  requestId: string;
  bindingId: string;
  runId: string;
  publisher: SessionEventPublisher;
  cancelledByStop: boolean;
};

type PersistentSession = {
  conversationId: string;
  providerId: SessionAgent;
  cwd: string;
  /** Turns submitted (via `queuePrompt`) but not yet observed to have started. FIFO — the runtime's own prompt queue is FIFO too. */
  pending: QueuedTurn[];
  /** The turn presently between a busy-false→true and a busy-true→false edge, or null while idle. */
  current: QueuedTurn | null;
  wasBusy: boolean;
};

function keyFor(bindingId: string, ownerUserId: string, agent: SessionAgent): PersistentKey {
  return `${bindingId}::${ownerUserId}::${agent}`;
}

/**
 * A turn's terminal status, read off the ONE signal the ACP session machine
 * actually gives a busy→idle edge: `lastStopReason`. On a normal turn it's
 * always a real stop reason (`end_turn`, ...); on an explicit cancel it's
 * exactly `'cancelled'`; on an in-turn error it is — deliberately, per the
 * session machine's own `TurnEnded` handling — left `null`, the one value a
 * normal completion never produces. `cancelledByStop` (set by `stopRun`,
 * below) is checked first because a fast user double-stop could otherwise
 * race a `lastStopReason` that hasn't updated yet.
 */
function statusForEndedTurn(turn: QueuedTurn, lastStopReason: string | null): SessionStatus {
  if (turn.cancelledByStop || lastStopReason === 'cancelled') return 'stopped';
  if (lastStopReason === null) return 'failed';
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
} {
  const sessions = new Map<PersistentKey, PersistentSession>();

  function forwardRaw(session: PersistentSession, raw: RawSessionEvent): void {
    // 19–50KB each and useless in the log — see the goal's own instruction.
    if (raw.update.sessionUpdate === 'available_commands_update') return;
    const turn = session.current;
    if (!turn) return;
    turn.publisher.record(raw.update.sessionUpdate, raw.update);
  }

  async function finalizeTurn(turn: QueuedTurn, status: SessionStatus): Promise<void> {
    await turn.publisher.finish(status);
    await markRequestSettled(
      deps.api,
      { bindingId: turn.bindingId, id: turn.requestId },
      requestStatusFor(status)
    );
  }

  function onBusyChange(session: PersistentSession, change: BusyChange): void {
    if (!session.wasBusy && change.isGenerating) {
      session.wasBusy = true;
      if (!session.current) session.current = session.pending.shift() ?? null;
      return;
    }
    if (session.wasBusy && !change.isGenerating) {
      session.wasBusy = false;
      const turn = session.current;
      session.current = null;
      if (!turn) return;
      void finalizeTurn(turn, statusForEndedTurn(turn, change.lastStopReason));
    }
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
      wasBusy: false,
    };
    // Subscribe BEFORE the session exists so nothing from the very first
    // turn — including its very first raw event — is missed.
    await deps.acp.subscribeRaw(conversationId, (raw) => forwardRaw(session, raw));
    await deps.acp.subscribeBusy(conversationId, (change) => onBusyChange(session, change));

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
      title: null,
    });
    if (!created.success) {
      return { failed: true, reason: created.error.message };
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
    };
    session.pending.push(turn);

    const queued = await deps.acp.queuePrompt(session.conversationId, request.prompt);
    if (!queued.success) {
      const idx = session.pending.indexOf(turn);
      if (idx !== -1) session.pending.splice(idx, 1);
      void finalizeTurn(turn, 'failed');
      return { failed: true, reason: queued.error };
    }

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
        void finalizeTurn(turn, 'stopped');
        return true;
      }
    }
    return false;
  }

  return { dispatch, stopRun };
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

    async queuePrompt(conversationId, text) {
      const client = await getClient();
      const result = await client.queuePrompt({ conversationId, prompt: { text } });
      return result.success ? ok(undefined) : err(describeAcpError(result.error));
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

    async subscribeBusy(conversationId, onChange) {
      const client = await getClient();
      const replica = new ReplicaState<SessionState>(client.session.state({ conversationId }, 'state'), {
        schema: sessionStateSchema,
        onChange: (state) => onChange({ isGenerating: state.isGenerating, lastStopReason: state.lastStopReason }),
      });
      await replica.ready.catch((error: unknown) => {
        log.warn('Rig spaces dispatch: could not follow the session state', {
          conversationId,
          error: String(error),
        });
      });
      return () => void replica.dispose();
    },
  };
}
