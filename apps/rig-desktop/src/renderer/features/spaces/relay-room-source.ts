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
 * on each notification it re-fetches the real body and resolves it into the
 * SAME inline-payload `RoomEvent` shape `FixtureRoomSource` produces (via
 * `reduceRoom`, the pure reducer lane 2 already wrote and exported from
 * `fixtures/room-feed.ts`), so `RoomTranscript` and friends never have to
 * know the difference between a live room and a replayed one.
 *
 * SECURITY (this class previously took the relay PAT directly and made its
 * own `fetch`/WebSocket calls from the renderer, flagged for review — see
 * git history for that version's own note on the tradeoff). Every plain
 * HTTP call this class makes is now a thin proxy through `RelayRoomClient`
 * (main's `rig.spacesConnection` RPC surface, backed by the SAME
 * `SpacesRelayApi` the session publisher/dispatcher already use — see
 * `main/rig/spaces-connection.ts`), so the renderer never holds this
 * device's long-lived PAT. The realtime Hocuspocus connection is opened
 * with a short-lived, single-binding ticket (`RelayRoomClient.
 * mintRealtimeTicket`, ~10 minute TTL) instead — minted by main, handed to
 * `@hocuspocus/provider` as a `token` FUNCTION (`ensureFreshTicket` below)
 * rather than a static string, so it's re-minted automatically on every
 * reconnect (Hocuspocus calls that function again each time it opens a new
 * WebSocket) and proactively refreshed once the cached one is close to
 * expiring.
 */

import type { Result } from '@emdash/shared';
import type {
  AgentRequest,
  RelayApiError,
  RoomMemberRow,
  RoomInviteRow,
  RoomMessageRow,
  SessionAgent,
  SessionEventRow,
  SessionRun,
} from '@main/rig/spaces/relay-api';
import type { DraftPreview } from '@main/rig/spaces-connection';
import { connectorById, type ConnectionStatus } from '@shared/spaces/connectors';
import type { LocalRunEvent } from '@shared/spaces/room-sees';
import type { AgentKind, MessageKind, RoomConnector, RoomEvent, RoomReplyRef, RoomSnapshot, SessionRunMeta } from './types';
import { reduceRoom } from './fixtures/room-feed';
import { effectiveRunStatus, projectSessionCard } from './projection';
import type { RoomSource } from './room-source';
import { formatClock } from '@renderer/lib/time-format';

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
  /** Yjs awareness: each connected client's small shared state (who they are, whether they're typing). */
  awareness: {
    setLocalStateField(field: string, value: unknown): void;
    getStates(): Map<number, Record<string, unknown>>;
    on(event: 'change', cb: () => void): void;
    off(event: 'change', cb: () => void): void;
  } | null;
}

export type RealtimeProviderFactory = (options: {
  wsUrl: string;
  documentName: string;
  /** Called by the provider before EVERY connection attempt (initial connect and every automatic reconnect), so a fresh ticket is always supplied — see this file's own header comment. */
  getToken: () => Promise<string>;
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
  getToken: () => Promise<string>;
}): Promise<RealtimeProvider> {
  const { HocuspocusProvider } = await import('@hocuspocus/provider');
  return new HocuspocusProvider({
    url: options.wsUrl,
    name: options.documentName,
    token: options.getToken,
  }) as unknown as RealtimeProvider;
}

// ────────── the relay surface this class needs, proxied through main ──────────

/**
 * Everything `RelayRoomSource` needs from the relay, mirroring
 * `main/rig/spaces-connection.ts`'s `rig.spacesConnection` RPC methods
 * 1:1 — kept as its own small interface, rather than calling `rpc.rig.
 * spacesConnection` directly, so a test can hand this a plain in-memory
 * fake instead of standing up IPC. `RoomView` builds the real one, a
 * trivial pass-through over `rpc.rig.spacesConnection` (see its own
 * `createRelayRoomClient`) — kept out of this file so nothing here needs
 * `@renderer/lib/ipc`'s `rpc` (and, transitively, `window.electronAPI`) at
 * module scope.
 */
export interface RelayRoomClient {
  mintRealtimeTicket(
    bindingId: string
  ): Promise<Result<{ ticket: string; expiresAt: string }, RelayApiError>>;
  listMembers(bindingId: string): Promise<Result<RoomMemberRow[], RelayApiError>>;
  /** The space's own skills on this device (its folder's `.claude/skills`), for the `/` palette. */
  listSkills?(bindingId: string): Promise<Array<{ cmd: string; name: string; desc: string }>>;
  /** The space's invites, for the Room's invite cards. */
  listInvites?(bindingId: string): Promise<Result<RoomInviteRow[], RelayApiError>>;
  listMessages(
    bindingId: string,
    query: { latest?: number; after?: string }
  ): Promise<Result<RoomMessageRow[], RelayApiError>>;
  getSessionEvents(
    bindingId: string,
    runId: string,
    after?: number
  ): Promise<Result<{ run: SessionRun; events: SessionEventRow[] }, RelayApiError>>;
  postMessage(
    bindingId: string,
    input: { body: string; kind?: string; meta?: Record<string, unknown> }
  ): Promise<Result<RoomMessageRow, RelayApiError>>;
  requestOwnAgent(
    bindingId: string,
    input: {
      targetOwnerUserId: string;
      targetAgent: SessionAgent;
      prompt: string;
      sourceMessageId?: string;
    }
  ): Promise<Result<AgentRequest, RelayApiError>>;
  /** Whether a draft answers one of your own agent's recent turns — `POST /v1/me/bindings/:id/draft-preview`. Never rejects. */
  previewDraft?(bindingId: string, text: string): Promise<DraftPreview>;
  /** The space's connectors (connectors-spec.md) — `GET /v1/me/bindings/:id/connectors`. */
  listConnectors?(
    bindingId: string
  ): Promise<Result<Array<{ connectorId: string; addedBy: string; addedAt: string }>, RelayApiError>>;
  /** `POST /v1/me/bindings/:id/connectors`; 403 when the viewer can't write. */
  addConnector?(
    bindingId: string,
    connectorId: string
  ): Promise<Result<{ connectorId: string; addedBy: string; addedAt: string }, RelayApiError>>;
  /** `DELETE /v1/me/bindings/:id/connectors/:connectorId`. */
  removeConnector?(bindingId: string, connectorId: string): Promise<Result<void, RelayApiError>>;
}

/** This device's own connection states — `connectorsApi.list()`, injected so this file never imports `@renderer/lib/ipc`. */
export interface ConnectionsClient {
  list(): Promise<ConnectionStatus[]>;
}

/**
 * The owner overlay: this computer's own full copy of the runs it runs
 * (`main/rig/spaces/local-runs.ts`), before the "Room sees" filter. Your own
 * runs show from it instead of the relay's filtered copy, so you always see
 * all of your agent's work and answer its approvals with the real command.
 */
export interface LocalRunsClient {
  /** A run's full local copy, or null when this computer doesn't hold one. */
  events(runId: string): Promise<LocalRunEvent[] | null>;
  /** Every event as it's recorded; returns an unsubscribe. */
  subscribe(listener: (update: { bindingId: string; runId: string; event: LocalRunEvent }) => void): () => void;
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
  /** e.g. `wss://tap-relay.fly.dev/v1/realtime`. */
  wsUrl: string;
  selfUserId: string;
  relay: RelayRoomClient;
  /** This device's own connection states, for `RoomConnector.mine` — omitted, `mine` stays undefined everywhere. */
  connections?: ConnectionsClient;
  /** The owner overlay (see `LocalRunsClient`) — omitted, your own runs show from the relay like everyone else's. */
  localRuns?: LocalRunsClient;
  createProvider?: (options: {
    wsUrl: string;
    documentName: string;
    getToken: () => Promise<string>;
  }) => RealtimeProvider | Promise<RealtimeProvider>;
  /** How many messages to bootstrap on open — mirrors `?latest=N`. */
  bootstrapMessageCount?: number;
  /** How often to re-read the relay while the realtime socket is down (see `startPolling`). */
  pollIntervalMs?: number;
  /** How long the first connection gets before the Room stops waiting on it and starts polling. */
  connectGraceMs?: number;
  log?: (message: string, extra?: Record<string, unknown>) => void;
};

type Listener = (event: RoomEvent, snapshot: RoomSnapshot) => void;

/** Re-mint once the cached ticket is within this margin of `expiresAt` (~10 minute TTL). */
const TICKET_REFRESH_MARGIN_MS = 60_000;

/**
 * Without the realtime socket (never connected, e.g. a relay with realtime
 * switched off answering the upgrade with a 404, or dropped mid-session) the
 * Room re-reads the relay itself on this cadence, so it keeps updating —
 * just a little slower — instead of freezing until a reload. Stops the
 * moment the socket is back.
 */
const POLL_INTERVAL_MS = 4_000;
/** How long the first connection gets before polling starts anyway (a failed upgrade may never say so). */
const CONNECT_GRACE_MS = 5_000;
/** The roster is re-read every Nth poll: joins already arrive as `member_joined` messages; this catches the rest. */
const MEMBER_POLL_EVERY = 5;

/** How many session runs `bootstrap()` fetches at once — enough that a history full of runs doesn't trickle in one at a time, capped so it doesn't open dozens of requests at once either. */
const BOOTSTRAP_RUN_CONCURRENCY = 6;

/** One run's header + full event backlog, as fetched by `getSessionEvents(..., 0)` — `run: null` means the fetch failed (logged at the call site). */
type RunFetchResult = { run: SessionRun | null; events: SessionEventRow[] };

/**
 * The viewer's own agents: in the MVP a member can only tag their own
 * `@claude`/`@codex`, which run locally, so these are the only agents the
 * composer needs. If one isn't installed, the dispatch fails and the
 * request settles as failed.
 */
function emptySnapshot(name: string, selfUserId: string): RoomSnapshot {
  return {
    name,
    ready: true,
    members: [],
    agents: [
      { agent: 'claude', owner: selfUserId, model: '', busy: false },
      { agent: 'codex', owner: selfUserId, model: '', busy: false },
    ],
    connectors: [],
    skills: [],
    messages: [],
    invitesById: {},
    sessionMetaByRun: {},
    sessionEventsByRun: {},
    typingUserIds: [],
    connection: 'connecting',
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
    Omit<RelayRoomSourceOptions, 'createProvider' | 'log' | 'connections' | 'localRuns' | 'pollIntervalMs' | 'connectGraceMs'>
  >;
  private readonly pollIntervalMs: number;
  private readonly connectGraceMs: number;
  private readonly makeProvider: NonNullable<RelayRoomSourceOptions['createProvider']>;
  private readonly log: (message: string, extra?: Record<string, unknown>) => void;
  private readonly connections: ConnectionsClient | undefined;
  private readonly localRuns: LocalRunsClient | undefined;
  /** Your runs shown from this computer's own copy: the relay's catch-up leaves them alone. */
  private readonly localRunIds = new Set<string>();
  /** One local-copy operation per run at a time, in order (a load, then the events pushed meanwhile). */
  private readonly localRunTasks = new Map<string, Promise<unknown>>();
  private unsubscribeLocalRuns: (() => void) | null = null;

  private snapshot: RoomSnapshot;
  private readonly listeners = new Set<Listener>();
  private provider: RealtimeProvider | null = null;
  private connected = false;
  private disposed = false;
  private paused = false;

  /** The fallback poll while the socket is down — see `POLL_INTERVAL_MS`. */
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTicks = 0;
  private pollInFlight = false;

  private lastMessageSeq = 0;
  private readonly userIdByClerkId = new Map<string, string>();
  /** Last-known `session_events.seq` per run, so `?after=` catch-up never re-fetches everything. */
  private readonly lastRunSeq = new Map<string, number>();
  /** Guards against overlapping catch-up fetches from rapid-fire notifications. */
  private catchingUp = false;
  private catchUpAgainRequested = false;

  private ticket: { value: string; expiresAtMs: number } | null = null;
  private ticketMint: Promise<string> | null = null;

  constructor(options: RelayRoomSourceOptions) {
    this.opts = {
      bindingId: options.bindingId,
      spaceName: options.spaceName,
      wsUrl: options.wsUrl,
      selfUserId: options.selfUserId,
      relay: options.relay,
      bootstrapMessageCount: options.bootstrapMessageCount ?? 50,
    };
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.connectGraceMs = options.connectGraceMs ?? CONNECT_GRACE_MS;
    this.connections = options.connections;
    this.localRuns = options.localRuns;
    this.makeProvider = options.createProvider ?? createHocuspocusProvider;
    this.log = options.log ?? (() => {});
    this.snapshot = emptySnapshot(options.spaceName, options.selfUserId);
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
    this.paused = false;
    void this.connect();
  }

  pause(): void {
    this.paused = true;
    this.stopPolling();
    this.provider?.disconnect();
    this.connected = false;
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeLocalRuns?.();
    this.unsubscribeLocalRuns = null;
    this.stopPolling();
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
    if (this.localRuns && !this.unsubscribeLocalRuns) {
      this.unsubscribeLocalRuns = this.localRuns.subscribe((update) => void this.onLocalRunEvent(update));
    }
    await this.bootstrap();
    let provider: RealtimeProvider;
    try {
      provider = await this.makeProvider({
        wsUrl: this.opts.wsUrl,
        documentName: `space:${this.opts.bindingId}`,
        getToken: () => this.ensureFreshTicket(),
      });
    } catch (error) {
      this.log('Rig spaces: could not open the realtime connection', { error: String(error) });
      this.goOffline();
      return;
    }
    if (this.disposed) {
      provider.destroy();
      return;
    }
    this.provider = provider;
    // Presence: announce who this client is; everyone's states give who's
    // here and who's typing.
    provider.awareness?.setLocalStateField('user', { id: this.opts.selfUserId });
    provider.awareness?.on('change', () => this.syncPresence());
    provider.on('connect', () => {
      this.connected = true;
      this.stopPolling();
      this.applyLocal({ type: 'connection_changed', connection: 'online' });
      void this.catchUp();
    });
    provider.on('disconnect', () => {
      this.connected = false;
      this.goOffline();
    });
    provider.on('stateless', ({ payload }) => {
      void this.handleNotification(payload);
    });
    provider.connect();
    // A failed upgrade (a relay with realtime off answers it with a 404)
    // usually shows up as `disconnect`, but nothing guarantees one — a
    // ticket that can't be minted, say. Don't wait on it forever.
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (!this.connected) this.goOffline();
    }, this.connectGraceMs);
  }

  // ── without the socket: poll ────────────────────────────────────────────

  /**
   * The socket is down (or never came up): say so quietly and keep the
   * Room current by polling. Called on every failed reconnect attempt, so
   * it only acts the first time. Anyone "typing" is dropped — with no
   * awareness updates, a stale indicator would never clear.
   */
  private goOffline(): void {
    if (this.disposed || this.paused || this.connected) return;
    this.startPolling();
    for (const id of this.snapshot.typingUserIds) this.applyLocal({ type: 'typing_stopped', personId: id });
    if (this.snapshot.connection !== 'offline') this.applyLocal({ type: 'connection_changed', connection: 'offline' });
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTicks = 0;
    this.pollTimer = setInterval(() => void this.pollOnce(), this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** One poll: new messages and live runs' events, and every few polls the roster. A slow relay never stacks polls up. */
  private async pollOnce(): Promise<void> {
    if (this.pollInFlight || this.disposed) return;
    this.pollInFlight = true;
    try {
      this.pollTicks += 1;
      if (this.pollTicks % MEMBER_POLL_EVERY === 0) await this.pollMembers();
      await this.catchUp();
    } finally {
      this.pollInFlight = false;
    }
  }

  /** Re-reads the roster (and with it the invite cards), telling listeners only when someone joined, left or changed. */
  private async pollMembers(): Promise<void> {
    const result = await this.opts.relay.listMembers(this.opts.bindingId);
    if (!result.success) return;
    const rosterKey = (): string =>
      this.snapshot.members.map((m) => `${m.id}:${m.name}:${m.role}:${m.avatarUrl ?? ''}`).join('|');
    const before = rosterKey();
    this.seedMembers(result.data);
    if (rosterKey() === before) return;
    await this.refreshInvites();
    this.notifyListeners({ type: 'members_synced', members: this.snapshot.members });
  }

  /** Whether a run can still gain events — polling skips the settled ones, which is almost all of a long history. */
  private isRunLive(runId: string): boolean {
    const meta = this.snapshot.sessionMetaByRun[runId];
    if (!meta) return false;
    return effectiveRunStatus(meta.status, projectSessionCard(this.snapshot.sessionEventsByRun[runId] ?? [])) === 'running';
  }

  /**
   * Returns the cached realtime ticket if it's not close to expiring, or
   * mints a fresh one — called by the Hocuspocus provider itself before
   * every connection attempt (initial connect AND every automatic
   * reconnect, since `onAuthenticate` runs once per document open), so a
   * long-lived Room session never opens a new connection on a stale
   * credential. Concurrent callers share one in-flight mint.
   */
  private async ensureFreshTicket(): Promise<string> {
    const now = Date.now();
    if (this.ticket && this.ticket.expiresAtMs - now > TICKET_REFRESH_MARGIN_MS) {
      return this.ticket.value;
    }
    if (this.ticketMint) return this.ticketMint;

    this.ticketMint = (async () => {
      const result = await this.opts.relay.mintRealtimeTicket(this.opts.bindingId);
      if (!result.success) {
        this.log('Rig spaces: could not mint a realtime ticket', { error: result.error.message });
        throw new Error(result.error.message);
      }
      const expiresAtMs = Date.parse(result.data.expiresAt);
      this.ticket = {
        value: result.data.ticket,
        expiresAtMs: Number.isNaN(expiresAtMs) ? now + TICKET_REFRESH_MARGIN_MS : expiresAtMs,
      };
      return this.ticket.value;
    })();
    try {
      return await this.ticketMint;
    } finally {
      this.ticketMint = null;
    }
  }

  /**
   * Loads the initial snapshot (member roster + recent messages + each
   * referenced run's full event log) before the realtime connection is ever
   * opened — and before any listener hears about it. Runs referenced by the
   * message history are fetched in parallel (bounded), and every event this
   * produces is folded into `this.snapshot` silently (`apply` below); the
   * Room only finds out once, at the very end, with the whole thing built —
   * never message by message, run by run (that trickle is what made the
   * Room's open feel jumpy; see this file's own header).
   */
  private async bootstrap(): Promise<void> {
    const [members, messages] = await Promise.all([
      this.opts.relay.listMembers(this.opts.bindingId),
      this.opts.relay.listMessages(this.opts.bindingId, { latest: this.opts.bootstrapMessageCount }),
    ]);

    // `member_joined` (the room-EVENT vocabulary) only flips an EXISTING
    // invited member's status in `reduceRoom` — there's no event for "here
    // is the initial roster." Bootstrap seeds `snapshot.members` directly.
    if (members.success) this.seedMembers(members.data);
    else this.log('Rig spaces: could not load room members', { error: members.error.message });

    // Skills are files in the space, so every member has the same list.
    const skills = await this.opts.relay.listSkills?.(this.opts.bindingId).catch(() => []);
    if (skills?.length) {
      this.snapshot = { ...this.snapshot, skills: skills.map((skill) => ({ ...skill, addedBy: '' })) };
    }
    await this.refreshInvites();

    let lastEvent: RoomEvent | null = null;
    const apply = (event: RoomEvent): void => {
      this.reduceLocal(event);
      lastEvent = event;
    };

    await this.refreshConnectors(apply);

    if (!messages.success) {
      this.log('Rig spaces: could not load room messages', { error: messages.error.message });
    } else {
      // Every run a `kind:'session'` message names, fetched together — not
      // one `await` per message the way the realtime catch-up path still
      // does (that part is unchanged; see `ingestWireMessage`/`ingestRun`).
      const runIds: string[] = [];
      const seenRunIds = new Set<string>();
      for (const row of messages.data) {
        const runId = sessionRunIdOf(row);
        if (runId && !seenRunIds.has(runId)) {
          seenRunIds.add(runId);
          runIds.push(runId);
        }
      }
      const prefetchedRuns = await this.fetchRunsBounded(runIds);
      for (const row of messages.data) await this.ingestWireMessage(row, apply, prefetchedRuns);
    }

    if (lastEvent) this.notifyListeners(lastEvent);
  }

  /** Fetches every run in `runIds` via `getSessionEvents(..., 0)`, up to `BOOTSTRAP_RUN_CONCURRENCY` at once, rather than one after another. */
  private async fetchRunsBounded(runIds: readonly string[]): Promise<Map<string, RunFetchResult>> {
    const results = new Map<string, RunFetchResult>();
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < runIds.length) {
        const runId = runIds[next]!;
        next += 1;
        results.set(runId, await this.fetchRun(runId));
      }
    };
    const workerCount = Math.min(BOOTSTRAP_RUN_CONCURRENCY, runIds.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }

  private async fetchRun(runId: string): Promise<RunFetchResult> {
    const result = await this.opts.relay.getSessionEvents(this.opts.bindingId, runId, 0);
    if (!result.success) {
      this.log('Rig spaces: could not load a referenced session run', {
        runId,
        error: result.error.message,
      });
      return { run: null, events: [] };
    }
    return { run: result.data.run, events: result.data.events };
  }

  /** Re-lists the roster when `userId` (a `member_joined` message's joiner) isn't in it yet — a no-op during bootstrap, whose roster already has everyone. */
  private async refreshMembersFor(userId: unknown): Promise<void> {
    if (typeof userId === 'string' && this.snapshot.members.some((m) => m.id === userId)) return;
    const members = await this.opts.relay.listMembers(this.opts.bindingId);
    if (!members.success) {
      this.log('Rig spaces: could not refresh room members', { error: members.error.message });
      return;
    }
    this.seedMembers(members.data);
    await this.refreshInvites();
  }

  private seedMembers(rows: RoomMemberRow[]): void {
    for (const row of rows) {
      if (row.clerkUserId) this.userIdByClerkId.set(row.clerkUserId, row.userId);
    }
    const seeded = rows.map((row) => {
      // No profile name yet: the email's local part reads better than an id.
      const name = row.name ?? row.email?.split('@')[0] ?? row.userId;
      return {
        id: row.userId,
        name,
        email: row.email ?? '',
        role: row.role,
        initial: name.slice(0, 1).toUpperCase(),
        avatarUrl: row.avatarUrl ?? null,
        status: 'here' as const,
      };
    });
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
    const query =
      this.lastMessageSeq > 0
        ? { after: String(this.lastMessageSeq) }
        : { latest: this.opts.bootstrapMessageCount };
    const result = await this.opts.relay.listMessages(this.opts.bindingId, query);
    if (!result.success) {
      this.log('Rig spaces: could not catch up on room messages', { error: result.error.message });
      return;
    }
    for (const row of result.data) await this.ingestWireMessage(row);
  }

  private async catchUpRuns(): Promise<void> {
    for (const runId of Object.keys(this.snapshot.sessionMetaByRun)) {
      // Your runs shown from this computer's own copy get their news from it.
      if (this.localRunIds.has(runId)) continue;
      // Polling (no socket): only runs that are still going can have news.
      if (!this.connected && !this.isRunLive(runId)) continue;
      const after = this.lastRunSeq.get(runId) ?? 0;
      const result = await this.opts.relay.getSessionEvents(this.opts.bindingId, runId, after);
      if (!result.success) {
        this.log('Rig spaces: could not catch up on session events', {
          runId,
          error: result.error.message,
        });
        continue;
      }
      for (const event of result.data.events) {
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

  /**
   * Turns one already-shaped relay message row into the right `RoomEvent`(s)
   * — a plain `message_created`, plus a synthesized `session_started` (+ its
   * full event backlog) the FIRST time a `kind:'session'` message names a
   * run this snapshot hasn't seen yet. `apply` is how each event reaches the
   * snapshot: defaults to `applyLocal` (mutate + notify, the realtime/
   * catch-up path, unchanged), but `bootstrap()` passes a silent variant so
   * nothing notifies until the whole initial batch is in. `prefetchedRuns`
   * is `bootstrap()`'s own bounded-parallel fetch, keyed by run id — when a
   * run isn't in it (the realtime path never passes one), `ingestRun` fetches
   * it itself, same as before.
   */
  private async ingestWireMessage(
    row: RoomMessageRow,
    apply: (event: RoomEvent) => void = (event) => this.applyLocal(event),
    prefetchedRuns?: ReadonlyMap<string, RunFetchResult>
  ): Promise<void> {
    if (row.seq <= this.lastMessageSeq && this.snapshot.messages.some((m) => m.id === row.id)) {
      return; // already applied (bootstrap + catch-up overlap window)
    }
    this.lastMessageSeq = Math.max(this.lastMessageSeq, row.seq);

    // Someone new accepted an invite: re-read the roster BEFORE resolving
    // the author below, so "Sam joined" maps to Sam (not a raw Clerk id)
    // and an emailed invite's card flips to "Joined".
    if (row.kind === 'system' && row.meta?.event === 'member_joined') {
      await this.refreshMembersFor(row.meta.userId);
    }

    // The relay identifies message authors by Clerk id while members, runs
    // and `/v1/me` use the user id — map back so "mine" and ownership
    // checks (Stop, approvals) line up.
    const rawAuthorId = row.author.userId ?? 'unknown';
    const authorId = this.userIdByClerkId.get(rawAuthorId) ?? rawAuthorId;
    const meta = row.meta ?? {};
    const runId = sessionRunIdOf(row);

    if (runId && !this.snapshot.sessionMetaByRun[runId]) {
      await this.ingestRun(runId, authorId, apply, prefetchedRuns?.get(runId));
    }

    if (row.kind === 'invite' && typeof meta.inviteId === 'string' && !this.snapshot.invitesById[meta.inviteId]) {
      await this.refreshInvites();
    }

    if (row.kind === 'system' && (meta.event === 'connectors_added' || meta.event === 'connectors_removed')) {
      await this.refreshConnectors(apply);
    }

    // Doc comments share the message table (they carry a `path`). Keep them
    // in the room, rendered as comment lines tied to their file and passage.
    // A reply in a doc comment thread carries no path of its own; it takes
    // its thread's.
    const parent = row.parentId ? this.snapshot.messages.find((m) => m.id === row.parentId) : undefined;
    const threadPath = row.path ?? (parent?.meta.kind === 'comment_mirror' ? parent.meta.path : null);
    const comment = threadPath ? this.commentMeta({ ...row, path: threadPath }) : null;
    const kind = (comment ? 'comment_mirror' : row.kind) as MessageKind;

    apply({
      type: 'message_created',
      id: row.id,
      seq: row.seq,
      kind,
      message: {
        id: row.id,
        seq: row.seq,
        authorId,
        createdAt: row.createdAt,
        time: formatClock(row.createdAt),
        body: row.body || undefined,
        meta: comment ?? toMessageMeta(row.kind, meta),
        ...(comment
          ? { threadId: row.parentId ?? row.id }
          : runId && typeof meta.threadId === 'string'
            ? { threadId: meta.threadId }
            : {}),
      },
    });
  }

  /** Applies `session_started` followed by every event of a run's full backlog, once — the first time a room message references it. Uses `prefetched` (bootstrap's own bounded-parallel fetch) when given, else fetches it itself (the realtime path). */
  private async ingestRun(
    runId: string,
    ownerFallback: string,
    apply: (event: RoomEvent) => void,
    prefetched?: RunFetchResult
  ): Promise<void> {
    const { run, events } = prefetched ?? (await this.fetchRun(runId));
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
    apply({ type: 'session_started', runId, meta });
    // Yours, run on this computer: shown from its own full copy instead.
    if (meta.owner === this.opts.selfUserId && this.localRuns) {
      if (await this.withLocalRun(runId, () => this.loadLocalRun(runId, apply))) return;
    }

    for (const event of events) {
      apply({
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

  // ── the owner overlay ───────────────────────────────────────────────────

  /** Runs `task` after any earlier local-copy operation on the same run, so a load and the events pushed meanwhile never interleave. */
  private withLocalRun<T>(runId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.localRunTasks.get(runId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.localRunTasks.set(runId, next.catch(() => undefined));
    return next;
  }

  /** Replaces a run's events with this computer's full copy of it. False (nothing changed) when there's no copy here. */
  private async loadLocalRun(runId: string, apply: (event: RoomEvent) => void): Promise<boolean> {
    const meta = this.snapshot.sessionMetaByRun[runId];
    if (!meta || !this.localRuns) return false;
    const events = await this.localRuns.events(runId).catch(() => null);
    if (!events || this.disposed) return false;
    this.localRunIds.add(runId);
    // `session_started` starts the run's events over.
    apply({ type: 'session_started', runId, meta });
    for (const event of events) {
      apply({ type: 'session_event_appended', runId, seq: event.seq, event });
      this.lastRunSeq.set(runId, event.seq);
    }
    if (events.length === 0) this.lastRunSeq.set(runId, 0);
    return true;
  }

  /**
   * An event of one of your runs, pushed as this computer records it. The
   * next one in order is appended; a run still showing the relay's copy (its
   * card came up before its first local event), or a gap, loads the whole
   * local copy instead. A run not in the Room yet is left to its session
   * message, whose `ingestRun` reads the local copy.
   */
  private onLocalRunEvent(update: { bindingId: string; runId: string; event: LocalRunEvent }): Promise<void> {
    const { runId, event } = update;
    if (update.bindingId !== this.opts.bindingId || this.disposed) return Promise.resolve();
    return this.withLocalRun(runId, async () => {
      const meta = this.snapshot.sessionMetaByRun[runId];
      if (!meta || meta.owner !== this.opts.selfUserId) return;
      if (this.localRunIds.has(runId)) {
        const last = this.lastRunSeq.get(runId) ?? 0;
        if (event.seq <= last) return;
        if (event.seq === last + 1) {
          this.applyLocal({ type: 'session_event_appended', runId, seq: event.seq, event });
          this.lastRunSeq.set(runId, event.seq);
          return;
        }
      }
      let lastEvent: RoomEvent | null = null;
      const loaded = await this.loadLocalRun(runId, (e) => {
        this.reduceLocal(e);
        lastEvent = e;
      });
      if (loaded && lastEvent) this.notifyListeners(lastEvent);
    });
  }

  // ── outgoing ────────────────────────────────────────────────────────────

  /**
   * Posts a plain-text chat message. The room's own realtime notification
   * round-trips it back through `catchUp()` — this never optimistically
   * applies it locally, so the message the UI shows is always exactly what
   * the relay stored. Returns the new message's id (for `requestOwnAgent`'s
   * `sourceMessageId`), or `null` if the post failed. `asks` marks a message
   * this app is about to hand to your own agent itself, so the relay's
   * dispatcher doesn't run the same ask a second time.
   */
  async send(text: string, replyTo?: RoomReplyRef, asks?: AgentKind): Promise<string | null> {
    const meta = { ...(replyTo ? { replyTo } : {}), ...(asks ? { asks } : {}) };
    const result = await this.opts.relay.postMessage(this.opts.bindingId, {
      body: text,
      kind: 'text',
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    });
    return result.success ? result.data.id : null;
  }

  /** Whether `text` answers one of your own agent's recent turns (the relay asks Jev); "none" when it can't tell. */
  async previewDraft(text: string): Promise<DraftPreview> {
    const none: DraftPreview = { answersTo: null, agent: null, confidence: 0 };
    if (!this.opts.relay.previewDraft) return none;
    return this.opts.relay.previewDraft(this.opts.bindingId, text).catch(() => none);
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
    await this.opts.relay.requestOwnAgent(this.opts.bindingId, {
      targetOwnerUserId: this.opts.selfUserId,
      targetAgent,
      prompt,
      ...(sourceMessageId ? { sourceMessageId } : {}),
    });
  }

  /** Loads the space's invites into `invitesById`; an invite counts as joined once a member has its email. */
  private async refreshInvites(): Promise<void> {
    const result = await this.opts.relay.listInvites?.(this.opts.bindingId).catch(() => null);
    if (!result?.success) return;
    const memberEmails = new Set(this.snapshot.members.map((m) => m.email.toLowerCase()).filter(Boolean));
    const invitesById: RoomSnapshot['invitesById'] = { ...this.snapshot.invitesById };
    for (const invite of result.data) {
      invitesById[invite.id] = {
        id: invite.id,
        by: invite.inviterUserId ?? '',
        who: invite.email ?? '',
        email: invite.email,
        role: invite.role,
        status: invite.email && memberEmails.has(invite.email.toLowerCase()) ? 'joined' : 'sent',
      };
    }
    this.snapshot = { ...this.snapshot, invitesById };
  }

  // ── connectors (connectors-spec.md) ────────────────────────────────────

  /** Re-fetches the space's connector list from the relay, enriched with this device's own connection state — bootstrap, and every `connectors_added`/`connectors_removed` system message. `apply` defaults to `applyLocal` (mutate + notify); `bootstrap()` passes its own silent variant so this never notifies mid-batch. */
  private async refreshConnectors(apply: (event: RoomEvent) => void = (event) => this.applyLocal(event)): Promise<void> {
    const listFn = this.opts.relay.listConnectors;
    if (!listFn) return;
    const result = await listFn(this.opts.bindingId);
    if (!result.success) {
      this.log('Rig spaces: could not load the space’s connectors', { error: result.error.message });
      return;
    }
    const mineById = await this.connectionStates();
    const connectors: RoomConnector[] = result.data.map((row) => {
      const def = connectorById(row.connectorId);
      const status = mineById.get(row.connectorId);
      return {
        id: row.connectorId,
        name: def?.name ?? row.connectorId,
        addedBy: row.addedBy,
        mine: status?.state,
        account: status?.account,
      };
    });
    apply({ type: 'connectors_synced', connectors });
  }

  /** Just this device's own connection states, re-merged into the existing connector list — cheaper than `refreshConnectors()` for after a local connect/disconnect, which never changes the space's list itself. */
  async refreshConnections(): Promise<void> {
    if (!this.connections || this.snapshot.connectors.length === 0) return;
    const mineById = await this.connectionStates();
    const connectors = this.snapshot.connectors.map((c) => {
      const status = mineById.get(c.id);
      return { ...c, mine: status?.state ?? c.mine, account: status?.account ?? c.account };
    });
    this.applyLocal({ type: 'connectors_synced', connectors });
  }

  private async connectionStates(): Promise<Map<string, ConnectionStatus>> {
    if (!this.connections) return new Map();
    const list = await this.connections.list().catch(() => []);
    return new Map(list.map((s) => [s.id, s]));
  }

  /** Adds a connector to the space (editors/owners only — the relay 403s otherwise). */
  async addConnector(connectorId: string): Promise<{ ok: true } | { ok: false; message?: string }> {
    const addFn = this.opts.relay.addConnector;
    if (!addFn) return { ok: false, message: 'Not available yet.' };
    const result = await addFn(this.opts.bindingId, connectorId);
    if (!result.success) return { ok: false, message: result.error.message };
    await this.refreshConnectors();
    return { ok: true };
  }

  /** Removes a connector from the space for everyone (editors/owners only); connections stay on each person's machine. */
  async removeConnector(connectorId: string): Promise<{ ok: true } | { ok: false; message?: string }> {
    const removeFn = this.opts.relay.removeConnector;
    if (!removeFn) return { ok: false, message: 'Not available yet.' };
    const result = await removeFn(this.opts.bindingId, connectorId);
    if (!result.success) return { ok: false, message: result.error.message };
    await this.refreshConnectors();
    return { ok: true };
  }

  private commentMeta(row: RoomMessageRow): import('./types').MessageMeta {
    const parent = row.parentId ? this.snapshot.messages.find((m) => m.id === row.parentId) : undefined;
    const parentQuote = parent?.meta.kind === 'comment_mirror' ? parent.meta.quote : '';
    const agent = row.author.kind === 'agent' ? agentOfPost(row.meta) : undefined;
    return {
      kind: 'comment_mirror',
      commentId: row.parentId ?? row.id,
      path: row.path ?? '',
      quote: row.quote ?? parentQuote,
      ...(row.parentId ? { isReply: true } : {}),
      ...(agent === 'claude' || agent === 'codex' ? { replyFromAgent: agent } : {}),
    };
  }

  private onlineIds: string[] = [];

  /** Folds every connected client's awareness state into presence and typing events. */
  private syncPresence(): void {
    const states = this.provider?.awareness?.getStates();
    if (!states) return;
    const online = new Set<string>([this.opts.selfUserId]);
    const typing = new Set<string>();
    for (const state of states.values()) {
      const user = state.user as { id?: unknown } | undefined;
      if (typeof user?.id !== 'string') continue;
      online.add(user.id);
      if (state.typing === true && user.id !== this.opts.selfUserId) typing.add(user.id);
    }
    const onlineIds = [...online].sort();
    if (onlineIds.join() !== this.onlineIds.join()) {
      this.onlineIds = onlineIds;
      this.applyLocal({ type: 'presence_changed', onlineIds });
    }
    for (const id of this.snapshot.typingUserIds) {
      if (!typing.has(id)) this.applyLocal({ type: 'typing_stopped', personId: id });
    }
    for (const id of typing) {
      if (!this.snapshot.typingUserIds.includes(id)) this.applyLocal({ type: 'typing_started', personId: id });
    }
  }

  setTyping(isTyping: boolean): void {
    this.provider?.awareness?.setLocalStateField('typing', isTyping);
  }

  // ── plumbing ────────────────────────────────────────────────────────────

  /** Folds an event into the snapshot AND notifies every listener — the realtime/catch-up path, and anything bootstrap wants to announce immediately. */
  private applyLocal(event: RoomEvent): void {
    this.reduceLocal(event);
    this.notifyListeners(event);
  }

  /** Folds an event into the snapshot without notifying anyone — `bootstrap()`'s own silent `apply`, so the initial batch never trickles out one event at a time. */
  private reduceLocal(event: RoomEvent): void {
    this.snapshot = reduceRoom(this.snapshot, event);
  }

  private notifyListeners(event: RoomEvent): void {
    for (const listener of this.listeners) listener(event, this.snapshot);
  }
}

/** The run a `kind:'session'` message names, or `null` for any other message. */
function sessionRunIdOf(row: RoomMessageRow): string | null {
  const meta = row.meta ?? {};
  return row.kind === 'session' && typeof meta.runId === 'string' ? meta.runId : null;
}


/** Which agent wrote an agent-authored post: `meta.agent` when set, else inferred from `meta.model`. */
function agentOfPost(meta: Record<string, unknown> | null): AgentKind | undefined {
  // `agent` may be a provider id ("claude") or a display label ("Claude Code").
  const agent = typeof meta?.agent === 'string' ? meta.agent.toLowerCase() : '';
  if (agent.includes('claude')) return 'claude';
  if (agent.includes('codex')) return 'codex';
  const model = typeof meta?.model === 'string' ? meta.model.toLowerCase() : '';
  if (/claude|sonnet|opus|haiku/.test(model)) return 'claude';
  return model ? 'codex' : undefined;
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
      return {
        kind: 'system',
        event: String(meta.event ?? ''),
        ...(Array.isArray(meta.connectorIds) ? { connectorIds: meta.connectorIds.map(String) } : {}),
      };
    default: {
      const reply = meta.replyTo as Record<string, unknown> | undefined;
      return reply &&
        typeof reply === 'object' &&
        typeof reply.id === 'string' &&
        typeof reply.authorId === 'string' &&
        typeof reply.excerpt === 'string'
        ? {
            kind: 'text',
            replyTo: {
              id: reply.id,
              authorId: reply.authorId,
              label: typeof reply.label === 'string' ? reply.label : '',
              excerpt: reply.excerpt,
            },
          }
        : { kind: 'text' };
    }
  }
}
