import {
  planStateSchema,
  promptDraftSchema,
  sessionUsageSchema,
  sessionConfigStateSchema,
  sessionStateSchema,
  terminalStateSchema,
  transcriptTurnSchema,
  type AttachmentMimeType,
  type AttachmentRef,
  type AcpRuntimeError,
  type HistoryPage,
  type PromptDraftUpdate,
  type PromptInput,
  type SessionState,
  type TerminalState,
} from '@emdash/core/acp/client';
import type { Result } from '@emdash/shared';
import type { Unsubscribe } from '@emdash/shared';
import { ReplicaLog, ReplicaState, type BlobSource, type LiveClientHandle } from '@emdash/wire';
import { createImmutableMobxStore, createMobxLogStore } from '@emdash/wire/util/mobx';
import { z } from 'zod';
import {
  getAcpRuntimeClient,
  type AcpRuntimeRpcClient,
  type StartSessionInput,
} from './runtime-client';

/**
 * Ported verbatim from emdash-desktop's `renderer/lib/acp/acp-live-session.ts`
 * (see that file's header for the full design note). Same dependency surface
 * as `runtime-client.ts` — no emdash-desktop coupling.
 */

export interface LiveValueSource<T> {
  getSnapshot(): T;
  subscribe(cb: () => void): Unsubscribe;
}

export function asValueSource<T>(replica: ReplicaState<T>): LiveValueSource<T> {
  return {
    getSnapshot: () => replica.current(),
    subscribe: (cb) => replica.onChange(() => cb()),
  };
}

export class AcpStartError extends Error {
  constructor(readonly runtimeError: AcpRuntimeError) {
    super(runtimeError.message ?? runtimeError.cause?.message ?? runtimeError.type);
    this.name = 'AcpStartError';
  }

  get errorType(): AcpRuntimeError['type'] {
    return this.runtimeError.type;
  }
}

export class AcpLiveSession {
  readonly sessionState: ReplicaState<SessionState>;
  readonly config: ReplicaState<z.infer<typeof sessionConfigStateSchema>>;
  readonly usage: ReplicaState<z.infer<typeof sessionUsageSchema> | null>;
  readonly plan: ReplicaState<z.infer<typeof planStateSchema> | null>;
  readonly activeTurn: ReplicaState<z.infer<typeof transcriptTurnSchema> | null>;
  readonly draft: ReplicaState<z.infer<typeof promptDraftSchema> | null>;
  readonly terminals: ReplicaState<TerminalState[]>;
  private readonly terminalLogs = new Map<string, ReplicaLog>();
  private disposed = false;

  private constructor(
    readonly conversationId: string,
    private readonly client: AcpRuntimeRpcClient,
    /**
     * The underlying ACP agent's own session id, from `startSession`'s
     * response — distinct from `conversationId` (this app's own id, the
     * wire live-model key). Null when no `input` was passed to `create()`
     * (attaching to an already-running session rather than starting one).
     * Persisted by `rig-chat-store.ts` as the one thing a genuine
     * `loadSession` resume needs later (Round B).
     */
    readonly acpSessionId: string | null = null
  ) {
    const key = { conversationId };
    this.sessionState = createReplicaState(client.session.state(key, 'state'), sessionStateSchema);
    this.config = createReplicaState(client.session.state(key, 'config'), sessionConfigStateSchema);
    this.usage = createReplicaState(
      client.session.state(key, 'usage'),
      sessionUsageSchema.nullable()
    );
    this.plan = createReplicaState(client.session.state(key, 'plan'), planStateSchema.nullable());
    this.activeTurn = createReplicaState(
      client.session.state(key, 'activeTurn'),
      transcriptTurnSchema.nullable()
    );
    this.draft = createReplicaState(
      client.session.state(key, 'draft'),
      promptDraftSchema.nullable()
    );
    this.terminals = createReplicaState(
      client.session.state(key, 'terminals'),
      z.array(terminalStateSchema)
    );
  }

  static async create(conversationId: string, input?: StartSessionInput): Promise<AcpLiveSession> {
    const client = await getAcpRuntimeClient();
    let acpSessionId: string | null = null;
    if (input) {
      const result = await withTimeout(
        client.startSession({ input }),
        'Timed out starting ACP session'
      );
      if (!result.success) {
        throw new AcpStartError(result.error);
      }
      acpSessionId = result.data.sessionId;
    }
    const session = new AcpLiveSession(conversationId, client, acpSessionId);
    await withTimeout(
      Promise.all([
        session.sessionState.ready,
        session.config.ready,
        session.usage.ready,
        session.plan.ready,
        session.activeTurn.ready,
        session.draft.ready,
        session.terminals.ready,
      ]),
      'Timed out connecting ACP live models'
    );
    return session;
  }

  /**
   * The dedicated resume path (Round E dedup fix) — `client.resumeSession`
   * is a single call whose response only resolves once the adapter's
   * `loadSession` replay has fully settled server-side *and* already
   * bundles the resulting history in that same response
   * (`runtime.ts`'s `resumeSession` procedure: `manager.start()` →
   * `manager.getHistory()`, both before responding). That makes it the one
   * authoritative post-replay snapshot — this app's replica subscriptions
   * (which is where a live `activeTurn` stream could otherwise double up
   * against a separately-seeded local history) are only constructed
   * *after* this resolves, by which point replay is already over.
   *
   * Deliberately not `create()` + a separate `getHistory()` round trip:
   * two calls would each be liable to observe replay's own live-streamed
   * side effects (the runtime publishes `session.activeTurn` incrementally
   * *during* the underlying `loadSession` call, on the same channel live
   * generation uses) at different moments — this is the one call that
   * settles the question atomically.
   *
   * ROUND F LATENCY INVESTIGATION ("resuming for up to a minute, sometimes
   * timing out"): the number was this call's own `withTimeout` default,
   * 10_000ms — nowhere near what a real `loadSession` can take. Tracing the
   * path (`session-manager.ts`'s `start()`): `await connection.agent.loadSession(...)`
   * is a call INTO the agent CLI's own ACP server (a subprocess — Claude
   * Code, Codex, …), which replays its OWN on-disk session transcript to
   * reconstruct in-memory state before it can accept anything new. That's
   * genuinely proportional to session size and lives entirely outside this
   * runtime's control — nothing in `session-manager.ts` bounds or times out
   * that await itself, so however long the agent's own replay takes is
   * however long `manager.start()` takes, full stop. The 10s client-side
   * timeout was cutting this off mid-flight: the renderer gave up and threw
   * "Timed out resuming ACP session" (the exact string Dylan saw) while
   * `manager.start()` kept running server-side regardless — it's never
   * cancelled, just abandoned from this client's point of view. That's also
   * consistent with the OTHER symptom (loading for up to a minute with no
   * error): whatever finally got a response back (a retry, most likely)
   * could still land once the original replay actually finished.
   *
   * Bumped to `RESUME_TIMEOUT_MS` (120s) — a generous ceiling against a
   * truly hung connection, not a real bound on `loadSession` (there isn't
   * one to size to session length; the agent doesn't report one). Only
   * acceptable now that the room never blanks while this runs (see
   * `RigChatStore._runBootstrap`'s local-history-first paint,
   * `hasSeededHistory`/`resuming`) — before that fix, a long real wait and a
   * timed-out one looked identical to the user (a stuck screen), so a
   * bigger number alone would have just made stuck-looking waits longer.
   */
  static async resume(
    conversationId: string,
    input: StartSessionInput & { sessionId: string }
  ): Promise<{ session: AcpLiveSession; history: HistoryPage }> {
    const client = await getAcpRuntimeClient();
    const result = await withTimeout(
      client.resumeSession({ input }),
      'Timed out resuming ACP session',
      RESUME_TIMEOUT_MS
    );
    if (!result.success) {
      throw new AcpStartError(result.error);
    }
    const session = new AcpLiveSession(conversationId, client, input.sessionId);
    await withTimeout(
      Promise.all([
        session.sessionState.ready,
        session.config.ready,
        session.usage.ready,
        session.plan.ready,
        session.activeTurn.ready,
        session.draft.ready,
        session.terminals.ready,
      ]),
      'Timed out connecting ACP live models'
    );
    return { session, history: { turns: result.data.turns, nextCursor: result.data.nextCursor } };
  }

  async start(input: StartSessionInput): Promise<Result<{ sessionId: string }, unknown>> {
    return this.client.startSession({ input });
  }

  getHistory(before?: number, limit = 50): Promise<Result<HistoryPage, unknown>> {
    return this.client.getHistory({ conversationId: this.conversationId, before, limit });
  }

  exportTranscript(): Promise<Result<string, unknown>> {
    return this.client.exportACPTranscript({ conversationId: this.conversationId });
  }

  exportRawAcpLog(): Promise<Result<string, unknown>> {
    return this.client.exportRawAcpLog({ conversationId: this.conversationId });
  }

  uploadAttachment(input: {
    data?: Uint8Array;
    source?: BlobSource;
    size?: number;
    mimeType: AttachmentMimeType;
    name?: string;
    originalPath?: string;
  }): Promise<Result<AttachmentRef, unknown>> {
    return this.client.uploadAttachment(
      { originalPath: input.originalPath },
      {
        name: input.name ?? 'attachment',
        mimeType: input.mimeType,
        size: input.size ?? input.data?.byteLength,
        source:
          input.source ?? (input.data ? singleChunk(input.data) : singleChunk(new Uint8Array())),
      }
    );
  }

  downloadAttachment(
    id: string
  ): Promise<Result<{ ref: AttachmentRef; data: Uint8Array }, unknown>> {
    return this.client.downloadAttachment({ id }).then(async (result) => {
      if (!result.success) return result;
      return {
        success: true,
        data: {
          ref: result.data.meta,
          data: await result.data.bytes(),
        },
      };
    });
  }

  deleteAttachment(id: string): Promise<Result<void, unknown>> {
    return this.client.deleteAttachment({ id });
  }

  sendPrompt(prompt: PromptInput): Promise<Result<{ queued: boolean }, unknown>> {
    return this.client.sendPrompt({ conversationId: this.conversationId, prompt });
  }

  queuePrompt(prompt: PromptInput): Promise<Result<{ queued: boolean }, unknown>> {
    return this.client.queuePrompt({ conversationId: this.conversationId, prompt });
  }

  editQueuedPrompt(id: string, input: PromptInput): Promise<Result<void, unknown>> {
    return this.client.editQueuedPrompt({ conversationId: this.conversationId, id, input });
  }

  deleteQueuedPrompt(id: string): Promise<Result<void, unknown>> {
    return this.client.deleteQueuedPrompt({ conversationId: this.conversationId, id });
  }

  changeQueuePromptOrder(ids: string[]): Promise<Result<void, unknown>> {
    return this.client.changeQueuePromptOrder({ conversationId: this.conversationId, ids });
  }

  cancelTurn(): Promise<Result<void, unknown>> {
    return this.client.cancelTurn({ conversationId: this.conversationId });
  }

  /**
   * Releases this conversation's lease on the runtime worker's session —
   * the same `stopSession` call `main/rig/comment-agent.ts` makes when a
   * headless turn finishes. Refcounted per (provider, workspaceId): a
   * process shared with another live session (same provider, same rig root)
   * stays up until every holder has also stopped. Distinct from `dispose()`
   * (which only tears down this client's own wire subscriptions) — call
   * both when a session is genuinely done, not detached.
   */
  stopSession(): Promise<Result<void, unknown>> {
    return this.client.stopSession({ conversationId: this.conversationId });
  }

  setPromptDraft(draft: PromptDraftUpdate): Promise<Result<void, unknown>> {
    return this.client.setPromptDraft({ conversationId: this.conversationId, draft });
  }

  setModelOption(dimension: 'model' | 'effort', value: string): Promise<Result<void, unknown>> {
    return this.client.setModelOption({ conversationId: this.conversationId, dimension, value });
  }

  setModeOption(value: string): Promise<Result<void, unknown>> {
    return this.client.setModeOption({ conversationId: this.conversationId, value });
  }

  resolvePermission(requestId: string, optionId: string): Promise<Result<void, unknown>> {
    return this.client.resolvePermission({
      conversationId: this.conversationId,
      requestId,
      optionId,
    });
  }

  async terminalOutput(terminalId: string): Promise<ReplicaLog> {
    const existing = this.terminalLogs.get(terminalId);
    if (existing) return existing;
    const binding = new ReplicaLog(this.client.terminalOutput.handle({ terminalId }), {
      store: createMobxLogStore(),
    });
    this.terminalLogs.set(terminalId, binding);
    await binding.ready;
    if (this.disposed) void binding.dispose();
    return binding;
  }

  dispose(): void {
    this.disposed = true;
    void this.sessionState.dispose();
    void this.config.dispose();
    void this.usage.dispose();
    void this.plan.dispose();
    void this.activeTurn.dispose();
    void this.draft.dispose();
    void this.terminals.dispose();
    for (const binding of this.terminalLogs.values()) {
      void binding.dispose();
    }
    this.terminalLogs.clear();
  }
}

async function* singleChunk(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}

function createReplicaState<T>(handle: LiveClientHandle<T>, schema: z.ZodType<T>): ReplicaState<T> {
  return new ReplicaState(handle, {
    schema,
    store: createImmutableMobxStore(),
  });
}

/**
 * Round F: a real `resumeSession` can legitimately take up to ~a minute (the
 * agent CLI's own on-disk session replay, proportional to session size —
 * see `resume()`'s doc comment). 120s is a safety net against a genuinely
 * hung connection, not a bound sized to session length; nothing on the wire
 * reports one to size it against.
 */
const RESUME_TIMEOUT_MS = 120_000;

function withTimeout<T>(promise: Promise<T>, message: string, ms = 10_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timeout);
        reject(error);
      }
    );
  });
}
