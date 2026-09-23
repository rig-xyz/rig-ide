/**
 * Spaces (lane 3): `RelayRoomSource`, the live counterpart to lane 2's
 * `FixtureRoomSource` — same `RoomSource` contract (`room-source.ts`),
 * backed by the relay's real `space:<bindingId>` Hocuspocus room
 * (`tap-spaces/packages/relay/SPACES_NOTES.md`) instead of a scripted
 * feed. `RoomView` (and everything under `components/`) should be able to
 * swap one for the other with no changes — that was lane 2's whole point
 * in building the seam.
 *
 * Wire shape, per `SPACES_NOTES.md`: the realtime room only ever carries
 * STATELESS "something changed" notifications (`message_created`,
 * `session_event_appended`, `agent_request_created`) — never the payload
 * itself. This class is exactly the thing lane 2's `NOTES.md` asked for:
 * on each notification it fetches the real body over HTTP and resolves it
 * into the SAME inline-payload `RoomEvent` shape `FixtureRoomSource`
 * produces (via `reduceRoom`, the pure reducer lane 2 already wrote and
 * exported from `fixtures/room-feed.ts`), so `RoomTranscript` and friends
 * never have to know the difference between a live room and a replayed one.
 *
 * SECURITY NOTE (flagged for review, not silently decided): this class
 * takes the relay PAT directly and makes its own `fetch`/WebSocket calls
 * from the renderer, unlike `comments.ts`/`account.ts`/the new
 * `main/rig/spaces/*` modules, which keep every relay call — and the token
 * — in the main process. Lane 2's own contract (`RelayRoomSource`
 * implementing `RoomSource`, tested "against a fake Hocuspocus server or a
 * mocked provider") only makes sense with the Yjs/Hocuspocus client living
 * in the renderer (that's where `@hocuspocus/provider` runs), and threading
 * a live, chatty realtime connection through IPC just to keep the token in
 * main would be a much bigger change than lane 3's remaining budget allows.
 * The token itself is handed to the renderer, once, by a new minimal main
 * RPC (`rig.spaces.getConnectionInfo`, see `main/rig/spaces-connection.ts`)
 * — never persisted renderer-side beyond this instance's lifetime, never
 * logged. This is a deliberate, reviewable tradeoff, not an oversight; see
 * `NOTES.md`'s "Open questions" for the alternative (a main-owned realtime
 * proxy) if this needs to change later.
 */

import type {
  AgentKind,
  MessageKind,
  RoomEvent,
  RoomSnapshot,
  SessionRunMeta,
  SessionStatus,
} from './types';
import { reduceRoom } from './fixtures/room-feed';
import type { RoomSource } from './room-source';

// ────────── the minimal realtime transport this class needs ──────────

/**
 * The slice of `@hocuspocus/provider`'s `HocuspocusProvider` this class
 * actually uses — small and structural on purpose, so a test can hand it a
 * hand-written fake instead of a real WebSocket-backed provider ("a fake
 * Hocuspocus server or a mocked provider", per the lane-3 brief).
 */
export interface RealtimeProvider {
  connect(): void;
  disconnect(): void;
  destroy(): void;
  sendStateless(payload: string): void;
  on(event: 'connect', cb: () => void): void;
  on(event: 'disconnect', cb: () => void): void;
  on(event: 'stateless', cb: (data: { payload: string }) => void): void;
  off(event: 'connect' | 'disconnect' | 'stateless', cb: (...args: never[]) => void): void;
  awareness: { setLocalStateField(field: string, value: unknown): void } | null;
}

export type RealtimeProviderFactory = (options: {
  wsUrl: string;
  documentName: string;
  token: string;
}) => RealtimeProvider;

/**
 * The real factory, built lazily (dynamic import) so nothing in this module
 * pulls in `@hocuspocus/provider`/`yjs` at module-load time for callers
 * (tests, or a `spacesEnabled=false` app) that never construct a
 * `RelayRoomSource` for real.
 */
export async function createHocuspocusProvider(options: {
  wsUrl: string;
  documentName: string;
  token: string;
}): Promise<RealtimeProvider> {
  const { HocuspocusProvider } = await import('@hocuspocus/provider');
  return new HocuspocusProvider({
    url: options.wsUrl,
    name: options.documentName,
    token: options.token,
  }) as unknown as RealtimeProvider;
}

// ────────── HTTP wire shapes (mirrors `SPACES_NOTES.md`) ──────────

type WireAuthor = { userId: string | null; name: string | null; kind: string };
type WireMessage = {
  id: string;
  seq: number;
  author: WireAuthor;
  kind: string;
  body: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
};
type WireRun = {
  id: string;
  agent: AgentKind;
  ownerUserId: string;
  model: string | null;
  status: SessionStatus;
  title: string | null;
  startedAt: string;
  endedAt: string | null;
};
type WireEvent = {
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
  truncated?: boolean;
  originalBytes?: number | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** A statelessly-pushed "something changed" notification — never the payload itself, per `SPACES_NOTES.md`. */
type RoomNotification =
  | { type: 'message_created'; id: string; seq: number; kind: string }
  | { type: 'session_event_appended'; runId: string; seq: number }
  | { type: 'agent_request_created'; id: string; targetOwner: string }
  | { type: string; [key: string]: unknown };

export type RelayRoomSourceOptions = {
  bindingId: string;
  spaceName: string;
  /** e.g. `https://tap-relay.fly.dev` — no trailing slash required. */
  relayUrl: string;
  /** e.g. `wss://tap-relay.fly.dev/v1/realtime`. */
  wsUrl: string;
  token: string;
  selfUserId: string;
  fetchImpl?: typeof fetch;
  createProvider?: (options: {
    wsUrl: string;
    documentName: string;
    token: string;
  }) => RealtimeProvider | Promise<RealtimeProvider>;
  /** How many messages to bootstrap on open — mirrors `?latest=N`. */
  bootstrapMessageCount?: number;
  log?: (message: string, extra?: Record<string, unknown>) => void;
};

type Listener = (event: RoomEvent, snapshot: RoomSnapshot) => void;

function emptySnapshot(name: string): RoomSnapshot {
  return {
    name,
    ready: true,
    members: [],
    agents: [],
    connectors: [],
    skills: [],
    messages: [],
    invitesById: {},
    sessionMetaByRun: {},
    sessionEventsByRun: {},
    typingUserIds: [],
  };
}

/**
 * The live `RoomSource`. `play()`/`pause()` map to connect/disconnect (a
 * live room is always conceptually "playing" — see lane 2's own NOTES.md —
 * these exist so `RoomView`'s existing play/pause affordance, if kept,
 * still has something meaningful to call). `isDone()` is always `false`;
 * `replayAll()` is a no-op — there is no script to fast-forward.
 */
export class RelayRoomSource implements RoomSource {
  private readonly opts: Required<
    Omit<RelayRoomSourceOptions, 'fetchImpl' | 'createProvider' | 'log'>
  >;
  private readonly fetchImpl: typeof fetch;
  private readonly makeProvider: NonNullable<RelayRoomSourceOptions['createProvider']>;
  private readonly log: (message: string, extra?: Record<string, unknown>) => void;

  private snapshot: RoomSnapshot;
  private readonly listeners = new Set<Listener>();
  private provider: RealtimeProvider | null = null;
  private connected = false;
  private disposed = false;

  private lastMessageSeq = 0;
  /** Last-known `session_events.seq` per run, so `?after=` catch-up never re-fetches everything. */
  private readonly lastRunSeq = new Map<string, number>();
  /** Guards against overlapping catch-up fetches from rapid-fire notifications. */
  private catchingUp = false;
  private catchUpAgainRequested = false;

  constructor(options: RelayRoomSourceOptions) {
    this.opts = {
      bindingId: options.bindingId,
      spaceName: options.spaceName,
      relayUrl: options.relayUrl.replace(/\/+$/, ''),
      wsUrl: options.wsUrl,
      token: options.token,
      selfUserId: options.selfUserId,
      bootstrapMessageCount: options.bootstrapMessageCount ?? 50,
    };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.makeProvider = options.createProvider ?? createHocuspocusProvider;
    this.log = options.log ?? (() => {});
    this.snapshot = emptySnapshot(options.spaceName);
  }

  // ── RoomSource ──────────────────────────────────────────────────────────

  getSnapshot(): RoomSnapshot {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isPlaying(): boolean {
    return this.connected;
  }

  isDone(): boolean {
    return false; // a live room never "finishes"
  }

  replayAll(): void {
    // No script to fast-forward — a live room only ever has "now" plus
    // whatever bootstrap/catch-up already fetched.
  }

  play(): void {
    if (this.disposed) return;
    void this.connect();
  }

  pause(): void {
    this.provider?.disconnect();
    this.connected = false;
  }

  dispose(): void {
    this.disposed = true;
    this.provider?.destroy();
    this.provider = null;
    this.listeners.clear();
  }

  // ── connecting ──────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    if (this.provider) {
      this.provider.connect();
      return;
    }
    await this.bootstrap();
    const provider = await this.makeProvider({
      wsUrl: this.opts.wsUrl,
      documentName: `space:${this.opts.bindingId}`,
      token: this.opts.token,
    });
    if (this.disposed) {
      provider.destroy();
      return;
    }
    this.provider = provider;
    provider.on('connect', () => {
      this.connected = true;
      void this.catchUp();
    });
    provider.on('disconnect', () => {
      this.connected = false;
    });
    provider.on('stateless', ({ payload }) => {
      void this.handleNotification(payload);
    });
    provider.connect();
  }

  /** Loads the initial snapshot (member roster + recent messages + each referenced run's full event log) before the realtime connection is ever opened. */
  private async bootstrap(): Promise<void> {
    const [members, messages] = await Promise.all([
      this.getJson<{ members?: unknown }>(`/v1/bindings/${this.opts.bindingId}/members`),
      this.getJson<{ messages?: unknown }>(
        `/v1/me/bindings/${this.opts.bindingId}/messages?latest=${this.opts.bootstrapMessageCount}`
      ),
    ]);

    // `member_joined` (the room-EVENT vocabulary) only flips an EXISTING
    // invited member's status in `reduceRoom` — there's no event for "here
    // is the initial roster." Bootstrap seeds `snapshot.members` directly.
    this.seedMembers(asArray(members?.members));

    for (const row of asArray(messages?.messages)) {
      await this.ingestWireMessage(row as WireMessage);
    }
  }

  private seedMembers(rows: unknown[]): void {
    const seeded = rows
      .map((row) => asRecord(row))
      .filter((row): row is Record<string, unknown> => row !== null && typeof row.userId === 'string')
      .map((row) => ({
        id: row.userId as string,
        name: typeof row.name === 'string' ? row.name : (row.userId as string),
        email: '',
        role: typeof row.role === 'string' ? row.role : 'viewer',
        initial: (typeof row.name === 'string' ? row.name : (row.userId as string))
          .slice(0, 1)
          .toUpperCase(),
        status: 'here' as const,
      }));
    if (seeded.length === 0) return;
    this.snapshot = { ...this.snapshot, members: seeded };
  }

  // ── catch-up / notifications ─────────────────────────────────────────────

  private async handleNotification(raw: string): Promise<void> {
    let notification: RoomNotification;
    try {
      notification = JSON.parse(raw) as RoomNotification;
    } catch {
      this.log('Rig spaces: unparseable room notification', { raw });
      return;
    }

    if (notification.type === 'message_created' || notification.type === 'session_event_appended') {
      await this.catchUp();
      return;
    }
    if (notification.type === 'agent_request_created') {
      const targetOwner = String(notification.targetOwner ?? '');
      // `agent` isn't part of the wire notification (see `SPACES_NOTES.md`'s
      // table) and `reduceRoom` treats this event as a pure no-op today, so
      // a placeholder is harmless — the authoritative claim/dispatch flow
      // lives entirely in `main/rig/spaces/request-claim.ts`, independent
      // of this room projection.
      this.applyLocal({
        type: 'agent_request_created',
        id: String(notification.id ?? ''),
        targetOwner,
        agent: 'claude',
      });
    }
  }

  /** Re-fetches anything new since the last known message/run seq — used on the initial `connect` and after every notification. Coalesces overlapping calls into one re-run rather than one per notification. */
  private async catchUp(): Promise<void> {
    if (this.catchingUp) {
      this.catchUpAgainRequested = true;
      return;
    }
    this.catchingUp = true;
    try {
      do {
        this.catchUpAgainRequested = false;
        await this.catchUpMessages();
        await this.catchUpRuns();
      } while (this.catchUpAgainRequested);
    } finally {
      this.catchingUp = false;
    }
  }

  private async catchUpMessages(): Promise<void> {
    const after = this.lastMessageSeq > 0 ? String(this.lastMessageSeq) : undefined;
    const query = after ? `?after=${after}` : `?latest=${this.opts.bootstrapMessageCount}`;
    const result = await this.getJson<{ messages?: unknown }>(
      `/v1/me/bindings/${this.opts.bindingId}/messages${query}`
    );
    for (const row of asArray(result?.messages)) {
      await this.ingestWireMessage(row as WireMessage);
    }
  }

  private async catchUpRuns(): Promise<void> {
    for (const runId of Object.keys(this.snapshot.sessionMetaByRun)) {
      const after = this.lastRunSeq.get(runId) ?? 0;
      const result = await this.getJson<{ run?: unknown; events?: unknown }>(
        `/v1/me/bindings/${this.opts.bindingId}/sessions/${runId}/events?after=${after}`
      );
      const events = asArray(result?.events) as WireEvent[];
      for (const event of events) {
        this.applyLocal({
          type: 'session_event_appended',
          runId,
          seq: event.seq,
          event: {
            seq: event.seq,
            kind: event.kind,
            payload: event.payload,
            ...(event.truncated ? { truncated: event.truncated } : {}),
            ...(event.originalBytes != null ? { originalBytes: event.originalBytes } : {}),
          },
        });
        this.lastRunSeq.set(runId, event.seq);
      }
    }
  }

  /** Turns one wire message into the right `RoomEvent`(s) — a plain `message_created`, plus a synthesized `session_started` (+ its full event backlog) the FIRST time a `kind:'session'` message names a run this snapshot hasn't seen yet. */
  private async ingestWireMessage(row: WireMessage): Promise<void> {
    if (row.seq <= this.lastMessageSeq && this.snapshot.messages.some((m) => m.id === row.id)) {
      return; // already applied (bootstrap + catch-up overlap window)
    }
    this.lastMessageSeq = Math.max(this.lastMessageSeq, row.seq);

    const authorId = row.author.userId ?? 'unknown';
    const meta = row.meta ?? {};
    const runId = row.kind === 'session' && typeof meta.runId === 'string' ? meta.runId : null;

    if (runId && !this.snapshot.sessionMetaByRun[runId]) {
      await this.ingestRun(runId, authorId);
    }

    this.applyLocal({
      type: 'message_created',
      id: row.id,
      seq: row.seq,
      kind: row.kind as MessageKind,
      message: {
        id: row.id,
        seq: row.seq,
        authorId,
        createdAt: row.createdAt,
        time: formatTime(row.createdAt),
        body: row.body || undefined,
        meta: toMessageMeta(row.kind, meta),
      },
    });
  }

  /** Fetches a run's header + full event backlog (from seq 0) and applies `session_started` followed by every event, once — the first time a room message references it. */
  private async ingestRun(runId: string, ownerFallback: string): Promise<void> {
    const result = await this.getJson<{ run?: unknown; events?: unknown }>(
      `/v1/me/bindings/${this.opts.bindingId}/sessions/${runId}/events?after=0`
    );
    const run = asRecord(result?.run) as unknown as WireRun | null;
    const meta: SessionRunMeta = {
      id: runId,
      agent: run?.agent ?? 'claude',
      owner: run?.ownerUserId ?? ownerFallback,
      model: run?.model ?? 'unknown',
      title: run?.title ?? '',
      status: run?.status ?? 'running',
      startedAt: run?.startedAt ?? new Date().toISOString(),
      endedAt: run?.endedAt ?? null,
    };
    this.applyLocal({ type: 'session_started', runId, meta });

    const events = asArray(result?.events) as WireEvent[];
    for (const event of events) {
      this.applyLocal({
        type: 'session_event_appended',
        runId,
        seq: event.seq,
        event: {
          seq: event.seq,
          kind: event.kind,
          payload: event.payload,
          ...(event.truncated ? { truncated: event.truncated } : {}),
          ...(event.originalBytes != null ? { originalBytes: event.originalBytes } : {}),
        },
      });
      this.lastRunSeq.set(runId, event.seq);
    }
  }

  // ── outgoing ────────────────────────────────────────────────────────────

  /** Posts a plain-text chat message. The room's own realtime notification round-trips it back through `catchUp()` — this never optimistically applies it locally, so the message the UI shows is always exactly what the relay stored. */
  async send(text: string): Promise<void> {
    await this.postJson(`/v1/me/bindings/${this.opts.bindingId}/messages`, {
      body: text,
      kind: 'text',
    });
  }

  /**
   * Files an `@claude`/`@codex` mention as a real agent request targeting
   * the SENDER (per the lane-3 brief: "a message that mentions @claude/
   * @codex (the sender's own agent) also creates an agent request
   * targeting the sender"). `sourceMessageId` links it back to the chat
   * message the composer already sent for the human-visible text.
   */
  async requestOwnAgent(
    targetAgent: AgentKind,
    prompt: string,
    sourceMessageId?: string
  ): Promise<void> {
    await this.postJson(`/v1/me/bindings/${this.opts.bindingId}/agent-requests`, {
      targetOwnerUserId: this.opts.selfUserId,
      targetAgent,
      prompt,
      ...(sourceMessageId ? { sourceMessageId } : {}),
    });
  }

  setTyping(isTyping: boolean): void {
    this.provider?.awareness?.setLocalStateField('typing', isTyping);
  }

  // ── plumbing ────────────────────────────────────────────────────────────

  private applyLocal(event: RoomEvent): void {
    this.snapshot = reduceRoom(this.snapshot, event);
    for (const listener of this.listeners) listener(event, this.snapshot);
  }

  private async getJson<T>(path: string): Promise<T | null> {
    try {
      const response = await this.fetchImpl(`${this.opts.relayUrl}${path}`, {
        headers: { authorization: `Bearer ${this.opts.token}`, accept: 'application/json' },
      });
      if (!response.ok) {
        this.log('Rig spaces: relay request failed', { path, status: response.status });
        return null;
      }
      return (await response.json()) as T;
    } catch (error) {
      this.log('Rig spaces: relay request errored', { path, error: String(error) });
      return null;
    }
  }

  private async postJson(path: string, body: unknown): Promise<void> {
    try {
      const response = await this.fetchImpl(`${this.opts.relayUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.token}`,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        this.log('Rig spaces: relay post failed', { path, status: response.status });
      }
    } catch (error) {
      this.log('Rig spaces: relay post errored', { path, error: String(error) });
    }
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function toMessageMeta(
  kind: string,
  meta: Record<string, unknown>
): import('./types').MessageMeta {
  switch (kind) {
    case 'session':
      return { kind: 'session', runId: String(meta.runId ?? '') };
    case 'invite':
      return { kind: 'invite', inviteId: String(meta.inviteId ?? '') };
    case 'comment_mirror':
      return {
        kind: 'comment_mirror',
        commentId: String(meta.commentId ?? ''),
        path: String(meta.path ?? ''),
        quote: String(meta.quote ?? ''),
        ...(typeof meta.replyFromAgent === 'string'
          ? { replyFromAgent: meta.replyFromAgent as AgentKind }
          : {}),
      };
    case 'system':
      return { kind: 'system', event: String(meta.event ?? '') };
    default:
      return { kind: 'text' };
  }
}
