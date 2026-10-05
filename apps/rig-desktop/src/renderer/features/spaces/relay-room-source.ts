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
import type { MessageAttachment } from '@shared/rig/attachments';
import { connectorById, type ConnectionStatus } from '@shared/spaces/connectors';
import { ROOM_CACHE_FORMAT_VERSION, ROOM_CACHE_MAX_BYTES, type CachedRoomBlob } from '@shared/spaces/room-cache';
import type { LocalRunEvent } from '@shared/spaces/room-sees';
import { canonicalEmoji, withReaction, type MessageReaction } from '@shared/spaces/reactions';
import { compareEventIds, type ThemeEventsPage, type ThemesFetch, type ThemesSnapshotWire } from '@shared/spaces/themes';
import type {
  AgentKind,
  MessageKind,
  RoomConnector,
  RoomEvent,
  RoomMessage,
  RoomReplyRef,
  RoomSnapshot,
  SessionRunMeta,
} from './types';
import { parseMessageAttachments } from './attachments';
import { reduceRoom } from './fixtures/room-feed';
import { effectiveRunStatus, runCard, summarizeCard } from './projection';
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
    query: { latest?: number; after?: string; before?: string }
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
  /** Your own reaction on a message, on or off; answers with the message's reactions (reactor ids are Clerk ids). */
  setReaction?(
    bindingId: string,
    input: { messageId: string; emoji: string; on: boolean }
  ): Promise<Result<MessageReaction[], RelayApiError>>;
  /** One message's reactions — re-read on `reactions_changed`. */
  getReactions?(bindingId: string, messageId: string): Promise<Result<MessageReaction[], RelayApiError>>;
  /** Every message after `afterSeq` that has reactions (a message in the window that's missing has none). */
  listReactionsAfter?(bindingId: string, afterSeq: number): Promise<Result<Record<string, MessageReaction[]>, RelayApiError>>;
  /** Room themes (rig/docs/room-themes-spec.md §6): the snapshot. `{ supported: false }` is a relay that has no themes (404). */
  getThemes?(bindingId: string): Promise<Result<ThemesFetch<ThemesSnapshotWire>, RelayApiError>>;
  /** One page of theme events after the cursor (at most 500, oldest first); `nextCursor` is set while more wait. */
  getThemeEvents?(
    bindingId: string,
    after: string
  ): Promise<Result<ThemesFetch<ThemeEventsPage>, RelayApiError>>;
  /** The per-Space switch (editors and owners). */
  setThemesEnabled?(
    bindingId: string,
    enabled: boolean
  ): Promise<Result<ThemesFetch<{ enabled: boolean }>, RelayApiError>>;
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
  | { type: 'reactions_changed'; messageId: string; seq: number }
  | { type: string; [key: string]: unknown };

/**
 * The relay's router thinks one of your messages was probably for your own
 * agent but isn't sure (`dispatch_suggestion`, meant for the sender only).
 */
export type DispatchSuggestion = { messageId: string; agent: AgentKind; agentId: string; confidence: number };

/** A `dispatch_suggestion` notification meant for `selfUserId`, or null (malformed, or someone else's). */
export function parseDispatchSuggestion(raw: Record<string, unknown>, selfUserId: string): DispatchSuggestion | null {
  if (raw.type !== 'dispatch_suggestion') return null;
  if (raw.forUserId !== undefined && raw.forUserId !== selfUserId) return null;
  if (typeof raw.messageId !== 'string' || (raw.agent !== 'claude' && raw.agent !== 'codex')) return null;
  return {
    messageId: raw.messageId,
    agent: raw.agent,
    agentId: typeof raw.agentId === 'string' ? raw.agentId : '',
    confidence: typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? raw.confidence : 0,
  };
}

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
  /** How long after a run is seen finishing its header is re-read for its end time — see `RUN_END_REFRESH_MS`. */
  runEndRefreshMs?: number;
  /** Failures at `warn` (the default); per-stage open and catch-up timings at `info`. Never message bodies or credentials. */
  log?: (message: string, extra?: Record<string, unknown>, level?: 'info' | 'warn') => void;
  /**
   * The disk cache (rig/docs/room-disk-cache-spec.md): `initial` is this
   * space's last saved Room — shown at once, then caught up — and `diskCache`
   * is where this Room saves itself as it changes. Both omitted, it never
   * touches the disk.
   */
  initial?: CachedRoomBlob | null;
  diskCache?: { put(blob: CachedRoomBlob): Promise<unknown> | void };
  /** The relay says the space is gone (410) or no longer yours (404): the view shows it and stops keeping this Room. */
  onGone?: () => void;
  /**
   * Whether to fetch the relay's themes (the `roomThemesEnabled` setting).
   * Off, or omitted, the Room never asks. Switched later with `setThemesEnabled`.
   */
  themesEnabled?: boolean;
};

type Listener = (event: RoomEvent, snapshot: RoomSnapshot) => void;

/** Event pages (500 each) one theme sync follows before it yields; a longer gap carries on in the next pass. */
const THEME_EVENT_PAGES_PER_SYNC = 10;

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
/**
 * A run's status change isn't broadcast to the Room: a run it saw start keeps
 * the header it read then (running, no end time) after its log says it
 * ended. It's re-read this long after that (the relay stamps the end just
 * after the run's last event lands), up to `RUN_END_REFRESH_TRIES` times.
 */
const RUN_END_REFRESH_MS = 1_500;
const RUN_END_REFRESH_TRIES = 3;
/** `?after=` past any real seq: a run's header alone, none of its events. */
const HEADER_ONLY_AFTER = 2_147_483_647;
/** The roster is re-read every Nth poll: joins already arrive as `member_joined` messages; this catches the rest. */
const MEMBER_POLL_EVERY = 5;

/** How many session runs are fetched at once (bootstrap and catch-up) — enough that a history full of runs doesn't trickle in one at a time, capped so it doesn't open dozens of requests at once either. */
const BOOTSTRAP_RUN_CONCURRENCY = 6;

/**
 * Run logs loading behind an open Room land in small batches: listeners
 * hear once every this many runs, or this long after the first unannounced
 * one, whichever comes first — not once per run, not all at the very end.
 */
const RUN_NOTIFY_EVERY = 6;
const RUN_NOTIFY_MS = 32;

/** The disk cache (rig/docs/room-disk-cache-spec.md): saved this long after the Room last changed. */
const DISK_SAVE_SETTLE_MS = 3_000;
/** Scrollback page size: messages per `loadOlder`. */
const OLDER_PAGE = 50;

/** The saved window: what the Room opens with (`bootstrapMessageCount`'s default). */
const DISK_MESSAGE_WINDOW = 50;
/** A saved Room older than this opens cold (message deletions are never signalled). */
const DISK_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
/** An `?after=` catch-up this long (the relay's page) means a gap too big to patch: open cold. */
const DISK_GAP_MESSAGES = 200;
/** A saved answer over this is cut (only when the whole Room is over the size cap). */
const DISK_TRIMMED_ANSWER_CHARS = 4_000;

/** Wraps the relay client so every call it makes is counted — for the open and catch-up timing lines only. */
function countingRelay(relay: RelayRoomClient, onCall: () => void): RelayRoomClient {
  return new Proxy(relay, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        onCall();
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** One run's header + full event backlog, as fetched by `getSessionEvents(..., 0)` — `run: null` means the fetch failed (logged at the call site). */
type RunFetchResult = { run: SessionRun | null; events: SessionEventRow[] };

/**
 * The viewer's own agents: in the MVP a member can only tag their own
 * `@claude`/`@codex`, which run locally, so these are the only agents the
 * composer needs. If one isn't installed, the dispatch fails and the
 * request settles as failed.
 */
export function emptySnapshot(name: string, selfUserId: string): RoomSnapshot {
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
    loaded: false,
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
    Omit<
      RelayRoomSourceOptions,
      'createProvider' | 'log' | 'connections' | 'localRuns' | 'pollIntervalMs' | 'connectGraceMs' | 'runEndRefreshMs' | 'initial' | 'diskCache' | 'onGone' | 'themesEnabled'
    >
  >;
  private readonly diskCache: RelayRoomSourceOptions['diskCache'];
  private readonly onGone: (() => void) | undefined;
  /** Opened from the disk cache: when that Room was saved (else null — a cold open). */
  private readonly restoredFrom: { savedAt: number } | null = null;
  private diskTimer: ReturnType<typeof setTimeout> | null = null;
  private diskWriting = false;
  private diskQueued: CachedRoomBlob | null = null;
  /** Runs whose log is being fetched because their summary-only card was expanded. */
  private readonly loadingLogs = new Set<string>();
  private readonly pollIntervalMs: number;
  private readonly connectGraceMs: number;
  private readonly makeProvider: NonNullable<RelayRoomSourceOptions['createProvider']>;
  private readonly log: NonNullable<RelayRoomSourceOptions['log']>;
  private readonly connections: ConnectionsClient | undefined;
  private readonly localRuns: LocalRunsClient | undefined;
  /** Your runs shown from this computer's own copy: the relay's catch-up leaves them alone. */
  private readonly localRunIds = new Set<string>();
  /** One local-copy operation per run at a time, in order (a load, then the events pushed meanwhile). */
  private readonly localRunTasks = new Map<string, Promise<unknown>>();
  private unsubscribeLocalRuns: (() => void) | null = null;

  private snapshot: RoomSnapshot;
  private readonly listeners = new Set<Listener>();
  private readonly suggestionListeners = new Set<(suggestion: DispatchSuggestion) => void>();
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
  /** What the next catch-up pass still has to fetch: new messages, and/or these runs' new events — see `catchUp`. */
  private pendingMessages = false;
  private pendingReactions = false;
  private pendingThemes = false;
  private readonly pendingRuns = new Set<string>();
  /** Runs still going when the socket dropped: the reconnect catch-up re-reads them. */
  private readonly liveAtDisconnect = new Set<string>();
  /** Runs the opening messages name whose log is still loading (the open's second phase), with the owner to fall back on. */
  private readonly runsLoading = new Map<string, string>();
  /** A scrollback page is on its way (`loadOlder`): one at a time. */
  private loadingOlder = false;
  /**
   * Loading runs that may have moved on since their fetch went out: a
   * notification named one ('notified'), or the socket came up while it was
   * loading ('ifLive'). Each is re-read, from its last seq, once its log is in.
   */
  private readonly recheckAfterLoad = new Map<string, 'notified' | 'ifLive'>();
  /** The last loaded run not yet announced, and how many runs since the last announcement — see `RUN_NOTIFY_EVERY`. */
  private runNotifyEvent: RoomEvent | null = null;
  private runsSinceNotify = 0;
  private runNotifyTimer: ReturnType<typeof setTimeout> | null = null;
  /** Finished runs whose header has no end time yet, due a re-read, and how many re-reads each has had — see `RUN_END_REFRESH_MS`. */
  private readonly runEndDue = new Set<string>();
  private readonly runEndTries = new Map<string, number>();
  private runEndTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly runEndRefreshMs: number;
  /** Relay calls made so far — only for the timing lines. */
  private requests = 0;
  private readonly createdAtMs = Date.now();
  private everConnected = false;
  /** `connect()` has begun the open (bootstrap, then the socket). */
  private started = false;
  /** On screen — see `setShown`. */
  private shown = true;

  /** Room themes: the flag, whether the relay turned out not to have them (stop asking this session), and the coalescing of overlapping syncs. */
  private themesOn: boolean;
  private themesUnsupported = false;
  private themesBusy = false;
  private themesAgain = false;

  private ticket: { value: string; expiresAtMs: number } | null = null;
  private ticketMint: Promise<string> | null = null;

  constructor(options: RelayRoomSourceOptions) {
    this.opts = {
      bindingId: options.bindingId,
      spaceName: options.spaceName,
      wsUrl: options.wsUrl,
      selfUserId: options.selfUserId,
      relay: countingRelay(options.relay, () => {
        this.requests += 1;
      }),
      bootstrapMessageCount: options.bootstrapMessageCount ?? 50,
    };
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.connectGraceMs = options.connectGraceMs ?? CONNECT_GRACE_MS;
    this.runEndRefreshMs = options.runEndRefreshMs ?? RUN_END_REFRESH_MS;
    this.connections = options.connections;
    this.localRuns = options.localRuns;
    this.makeProvider = options.createProvider ?? createHocuspocusProvider;
    this.log = options.log ?? (() => {});
    this.diskCache = options.diskCache;
    this.onGone = options.onGone;
    this.themesOn = options.themesEnabled === true;
    this.snapshot = emptySnapshot(options.spaceName, options.selfUserId);
    const initial = options.initial;
    if (initial) {
      const ageMs = Date.now() - initial.savedAt;
      if (ageMs > DISK_MAX_AGE_MS) {
        this.log('Rig spaces: room cache discard', { bindingId: options.bindingId, reason: 'age', ageMs }, 'info');
      } else {
        this.restoreFrom(initial);
        this.restoredFrom = { savedAt: initial.savedAt };
      }
    }
  }

  /**
   * Seeds the snapshot from the disk cache, so the very first render shows
   * the Room as it was — `stale` until it has caught up. A finished run
   * comes back as its summary; a run that was still going as a placeholder,
   * fetched in full first thing. Presence, typing and the connection start
   * from nothing, as on any open.
   */
  private restoreFrom(blob: CachedRoomBlob): void {
    const sessionMetaByRun: RoomSnapshot['sessionMetaByRun'] = {};
    const sessionSummaryByRun: NonNullable<RoomSnapshot['sessionSummaryByRun']> = {};
    const staleEnds: string[] = [];
    let agents = this.snapshot.agents;
    for (const [runId, run] of Object.entries(blob.runs)) {
      if (run.live || !run.summary) {
        this.runsLoading.set(runId, run.meta.owner);
        continue;
      }
      sessionMetaByRun[runId] = run.meta;
      sessionSummaryByRun[runId] = run.summary;
      // Saved before its end time was known: re-read it.
      if (isFinished(run.summary.status)) staleEnds.push(runId);
      if (!agents.some((a) => a.agent === run.meta.agent && a.owner === run.meta.owner)) {
        agents = [...agents, { agent: run.meta.agent, owner: run.meta.owner, model: run.meta.model, busy: false }];
      }
    }
    this.lastMessageSeq = blob.lastMessageSeq;
    this.snapshot = {
      ...this.snapshot,
      loaded: true,
      stale: true,
      agents,
      messages: blob.messages as unknown as RoomSnapshot['messages'],
      members: blob.members as unknown as RoomSnapshot['members'],
      invitesById: blob.invitesById as unknown as RoomSnapshot['invitesById'],
      connectors: blob.connectors as unknown as RoomSnapshot['connectors'],
      skills: blob.skills as unknown as RoomSnapshot['skills'],
      sessionMetaByRun,
      sessionSummaryByRun,
      ...(this.runsLoading.size > 0 ? { runsLoading: this.loadingRecord() } : {}),
    };
    for (const runId of staleEnds) this.noteRunEnd(runId);
  }

  private loadingRecord(): Record<string, true> {
    return Object.fromEntries([...this.runsLoading.keys()].map((id) => [id, true as const]));
  }

  // ── RoomSource ──────────────────────────────────────────────────────────

  getSnapshot(): RoomSnapshot {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The router's private "was this for your agent?" about one of your messages (`DispatchSuggestion`). Not part of the snapshot: it's only ever for this viewer, and only for now. */
  onDispatchSuggestion(listener: (suggestion: DispatchSuggestion) => void): () => void {
    this.suggestionListeners.add(listener);
    return () => this.suggestionListeners.delete(listener);
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

  /** Closes the socket (and stops polling), keeping the snapshot; `play()` reconnects and catches up. */
  pause(): void {
    this.paused = true;
    this.stopPolling();
    // What was going now is what the reconnect catch-up has to re-read.
    if (this.connected) for (const runId of this.liveRunIds()) this.liveAtDisconnect.add(runId);
    this.provider?.disconnect();
    this.connected = false;
  }

  /**
   * "Try again": one reconnect attempt and one catch-up now, instead of
   * waiting for the next automatic retry or poll. Resolves once the
   * catch-up is done (a failure just leaves `relayUnreachable` set).
   */
  async retryNow(): Promise<void> {
    if (this.disposed || this.paused) return;
    if (!this.connected) this.provider?.connect();
    await this.catchUp({ messages: true, runs: this.liveRunIds() });
  }

  private setRelayUnreachable(unreachable: boolean): void {
    if (this.disposed || !!this.snapshot.relayUnreachable === unreachable) return;
    this.applyLocal({ type: 'relay_reachability_changed', unreachable });
  }

  /**
   * Whether this Room is on screen (`room-source-cache.ts` keeps a few alive
   * behind other spaces). Hidden, it stops saying you're here or typing, but
   * keeps listening. Shown again: started if it never was, reconnected if its
   * socket was closed for idling (the reconnect catches up), else one
   * catch-up for anything a notification may not have covered.
   */
  setShown(shown: boolean): void {
    if (this.disposed || shown === this.shown) return;
    this.shown = shown;
    if (!shown) {
      this.setTyping(false);
      this.provider?.awareness?.setLocalStateField('user', null);
      this.saveToDisk(); // leaving the space: as it is now is what the next launch opens with
      return;
    }
    this.provider?.awareness?.setLocalStateField('user', { id: this.opts.selfUserId });
    if (!this.started || this.paused) this.play();
    else if (this.snapshot.loaded) void this.catchUp({ messages: true, runs: this.liveRunIds() });
  }

  /** The space was renamed: the Room's own name follows. */
  rename(name: string): void {
    if (name !== this.snapshot.name) this.applyLocal({ type: 'room_renamed', name });
  }

  dispose(): void {
    // Anything still loading (bootstrap, a catch-up) checks this and stops:
    // an abandoned open never keeps fetching, applying or notifying.
    // Nothing is saved here: a disposed Room was evicted (saved when hidden),
    // or forgotten — deleted, left, signed out — and must not be written back.
    this.disposed = true;
    this.pendingMessages = false;
    this.pendingRuns.clear();
    if (this.runNotifyTimer) clearTimeout(this.runNotifyTimer);
    this.runNotifyTimer = null;
    if (this.runEndTimer) clearTimeout(this.runEndTimer);
    this.runEndTimer = null;
    this.runEndDue.clear();
    if (this.diskTimer) clearTimeout(this.diskTimer);
    this.diskTimer = null;
    this.diskQueued = null;
    this.unsubscribeLocalRuns?.();
    this.unsubscribeLocalRuns = null;
    this.stopPolling();
    this.provider?.destroy();
    this.provider = null;
    this.listeners.clear();
    this.suggestionListeners.clear();
  }

  // ── connecting ──────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    if (this.provider) {
      this.provider.connect();
      return;
    }
    // Already opening: that open connects when it's done (unless paused meanwhile).
    if (this.started) return;
    this.started = true;
    if (this.localRuns && !this.unsubscribeLocalRuns) {
      this.unsubscribeLocalRuns = this.localRuns.subscribe((update) => void this.onLocalRunEvent(update));
    }
    // Shown from disk already: only catch up. Else the two-phase cold open.
    await (this.restoredFrom ? this.resume(this.restoredFrom.savedAt) : this.bootstrap());
    if (this.disposed) return;
    // Themes never hold up the open: asked once the messages are in, and never awaited.
    void this.refreshThemes();
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
    // Presence: announce who this client is (while it's on screen);
    // everyone's states give who's here and who's typing.
    provider.awareness?.setLocalStateField('user', this.shown ? { id: this.opts.selfUserId } : null);
    provider.awareness?.on('change', () => this.syncPresence());
    provider.on('connect', () => {
      // A reconnect may have missed reactions to messages already shown (the first connect just loaded them).
      const reconnect = this.everConnected;
      this.connected = true;
      this.stopPolling();
      this.log(
        'Rig spaces: room socket connected',
        { bindingId: this.opts.bindingId, ms: Date.now() - this.createdAtMs, reconnect: this.everConnected },
        'info'
      );
      this.everConnected = true;
      this.setRelayUnreachable(false);
      this.applyLocal({ type: 'connection_changed', connection: 'online' });
      // New messages, plus only the runs that could have moved on: the ones
      // still going now, and the ones that were going when the socket
      // dropped. A finished run's log can't grow, so a long history of
      // settled runs costs nothing here.
      const runs = [...this.liveRunIds(), ...this.liveAtDisconnect];
      this.liveAtDisconnect.clear();
      // A log still loading may miss what happened before the socket could say so.
      for (const runId of this.runsLoading.keys()) {
        if (!this.recheckAfterLoad.has(runId)) this.recheckAfterLoad.set(runId, 'ifLive');
      }
      void this.catchUp({ messages: true, runs, reactions: reconnect });
    });
    provider.on('disconnect', () => {
      if (this.connected) for (const runId of this.liveRunIds()) this.liveAtDisconnect.add(runId);
      this.connected = false;
      this.goOffline();
    });
    provider.on('stateless', ({ payload }) => {
      void this.handleNotification(payload);
    });
    // Paused while it was opening (e.g. it idled behind other spaces): stays
    // closed until `play()`, which connects this provider.
    if (this.paused) return;
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
      const everyFew = this.pollTicks % MEMBER_POLL_EVERY === 0;
      if (everyFew) await this.pollMembers();
      // Without the socket nothing says which run moved: re-read the live ones
      // (and, every few polls, the reactions on what's shown).
      await this.catchUp({ messages: true, runs: this.liveRunIds(), reactions: everyFew });
    } finally {
      this.pollInFlight = false;
    }
  }

  /** Re-reads the roster (and with it the invite cards), telling listeners only when someone joined, left or changed. */
  private async pollMembers(): Promise<void> {
    const result = await this.opts.relay.listMembers(this.opts.bindingId);
    if (!result.success || this.disposed) return;
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
    return effectiveRunStatus(meta.status, runCard(this.snapshot, runId)) === 'running';
  }

  /** The runs the relay could still have news for: live, and not shown from this computer's own copy. */
  private liveRunIds(): string[] {
    return Object.keys(this.snapshot.sessionMetaByRun).filter((runId) => !this.localRunIds.has(runId) && this.isRunLive(runId));
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
   * Opens the Room in two phases. First, everything but the agent runs'
   * logs — roster, recent messages, skills, invites, connectors, all asked
   * at once — folded in silently (`apply` below) and announced ONCE, so the
   * transcript shows whole, with a placeholder for each run still loading
   * (`snapshot.runsLoading`). Then, in the background (`loadRuns`), each
   * run's log, newest first — the view opens at the bottom — announced in
   * small batches. The realtime connection opens between the two.
   */
  private async bootstrap(): Promise<void> {
    const startedMs = Date.now();
    const { bindingId } = this.opts;
    const relay = this.opts.relay;
    const [members, messages, skills, invites, connectors] = await Promise.all([
      relay.listMembers(bindingId),
      relay.listMessages(bindingId, { latest: this.opts.bootstrapMessageCount }),
      // Skills are files in the space, so every member has the same list.
      relay.listSkills?.(bindingId).catch(() => []),
      this.fetchInvites(),
      this.loadConnectors(),
    ]);
    if (this.disposed) return;

    // `member_joined` (the room-EVENT vocabulary) only flips an EXISTING
    // invited member's status in `reduceRoom` — there's no event for "here
    // is the initial roster." Bootstrap seeds `snapshot.members` directly.
    if (members.success) this.seedMembers(members.data);
    else this.log('Rig spaces: could not load room members', { error: members.error.message });

    if (skills?.length) {
      this.snapshot = { ...this.snapshot, skills: skills.map((skill) => ({ ...skill, addedBy: '' })) };
    }
    // After the roster: an invite reads as joined once a member has its email.
    if (invites) this.applyInvites(invites);

    let lastEvent: RoomEvent | null = null;
    const apply = (event: RoomEvent): void => {
      this.reduceLocal(event);
      lastEvent = event;
    };

    if (connectors) apply({ type: 'connectors_synced', connectors });

    if (!messages.success) {
      this.log('Rig spaces: could not load room messages', { error: messages.error.message });
      if (isGone(messages.error)) return this.gone();
      apply({ type: 'relay_reachability_changed', unreachable: true });
    } else {
      apply({ type: 'room_loaded' });
      for (const row of messages.data) {
        if (this.disposed) return;
        await this.ingestWireMessage(row, apply, { bootstrap: true });
      }
      // A full opening page may have more above it (scrollback, `loadOlder`).
      this.snapshot = {
        ...this.snapshot,
        olderMessages: messages.data.length >= this.opts.bootstrapMessageCount ? 'more' : 'none',
      };
      if (this.runsLoading.size > 0) {
        this.snapshot = { ...this.snapshot, runsLoading: Object.fromEntries([...this.runsLoading.keys()].map((id) => [id, true])) };
      }
    }
    if (this.disposed) return;

    if (lastEvent) this.notifyListeners(lastEvent);
    this.log(
      'Rig spaces: room first paint',
      {
        bindingId,
        source: 'network',
        ms: Date.now() - startedMs,
        calls: this.requests,
        messages: messages.success ? messages.data.length : null,
        runsLoading: this.runsLoading.size,
      },
      'info'
    );
    // Newest first: the bottom of the transcript, where the view opens and
    // where a run still going (or waiting on an approval) almost always is.
    if (messages.success) void this.loadRuns(this.loadingNewestFirst(), startedMs);
  }

  /**
   * The open from the disk cache (rig/docs/room-disk-cache-spec.md): the
   * snapshot is already on screen (`restoreFrom`), so this only catches up —
   * messages after the last one kept, the roster, invites and connectors
   * (changes to those aren't all announced by messages), then the runs still
   * loading: the ones that were going when it was saved, and any the new
   * messages name. Finished runs are not fetched at all. A gap too big to
   * patch (a full page of new messages) opens the message window cold.
   */
  private async resume(savedAt: number): Promise<void> {
    const startedMs = Date.now();
    const { bindingId } = this.opts;
    const relay = this.opts.relay;
    this.log(
      'Rig spaces: room first paint',
      {
        bindingId,
        source: 'disk',
        ageMs: startedMs - savedAt,
        messages: this.snapshot.messages.length,
        runs: Object.keys(this.snapshot.sessionSummaryByRun ?? {}).length,
        runsLoading: this.runsLoading.size,
      },
      'info'
    );
    const [members, messages, invites, connectors, skills] = await Promise.all([
      relay.listMembers(bindingId),
      relay.listMessages(bindingId, { after: String(this.lastMessageSeq) }),
      this.fetchInvites(),
      this.loadConnectors(),
      // The space's own files on this computer, not the relay: cheap, and they may have changed.
      relay.listSkills?.(bindingId).catch(() => null),
    ]);
    if (this.disposed) return;
    if (!messages.success && isGone(messages.error)) return this.gone();

    if (skills) this.snapshot = { ...this.snapshot, skills: skills.map((skill) => ({ ...skill, addedBy: '' })) };
    // The roster first: new messages' authors are mapped through it.
    if (members.success) this.seedMembers(members.data);
    if (invites) this.applyInvites(invites);
    let lastEvent: RoomEvent = { type: 'members_synced', members: this.snapshot.members };
    const apply = (event: RoomEvent): void => {
      this.reduceLocal(event);
      lastEvent = event;
    };
    if (connectors) apply({ type: 'connectors_synced', connectors });

    let caughtUp = 0;
    let gap = false;
    if (!messages.success) {
      this.log('Rig spaces: could not catch up on room messages', { error: messages.error.message });
      apply({ type: 'relay_reachability_changed', unreachable: true });
    } else {
      let rows = messages.data;
      if (rows.length >= DISK_GAP_MESSAGES) {
        gap = true;
        this.log('Rig spaces: room cache discard', { bindingId, reason: 'gap' }, 'info');
        const latest = await relay.listMessages(bindingId, { latest: this.opts.bootstrapMessageCount });
        if (this.disposed) return;
        this.lastMessageSeq = 0;
        this.snapshot = { ...this.snapshot, messages: [] };
        rows = latest.success ? latest.data : [];
      }
      for (const row of rows) {
        if (this.disposed) return;
        await this.ingestWireMessage(row, apply, { bootstrap: true });
      }
      caughtUp = rows.length;
      // Shown from disk: whether anything precedes the saved window is
      // unknown until a look back finds out (`loadOlder`).
      this.snapshot = { ...this.snapshot, runsLoading: this.loadingRecord(), olderMessages: 'more' };
      // Reactions to messages kept on disk may have changed meanwhile.
      if (!gap) {
        const reactions = await this.reactionsSince();
        if (this.disposed) return;
        if (reactions) apply({ type: 'reactions_changed', reactions });
      }
      apply({ type: 'room_caught_up' });
    }
    if (this.disposed) return;
    this.notifyListeners(lastEvent);
    this.log(
      'Rig spaces: room catch-up',
      { bindingId, source: 'disk', ms: Date.now() - startedMs, calls: this.requests, messages: caughtUp, gap },
      'info'
    );
    void this.loadRuns(this.loadingNewestFirst(), startedMs);
  }

  /** The runs still loading, bottom of the transcript first. */
  private loadingNewestFirst(): string[] {
    const order: string[] = [];
    const seen = new Set<string>();
    for (let i = this.snapshot.messages.length - 1; i >= 0; i -= 1) {
      const meta = this.snapshot.messages[i]!.meta;
      if (meta.kind !== 'session' || seen.has(meta.runId) || !this.runsLoading.has(meta.runId)) continue;
      seen.add(meta.runId);
      order.push(meta.runId);
    }
    for (const runId of this.runsLoading.keys()) if (!seen.has(runId)) order.push(runId);
    return order;
  }

  /** The relay says the space is gone or no longer yours: stop here, and let the view say so. */
  private gone(): void {
    this.log('Rig spaces: room gone', { bindingId: this.opts.bindingId }, 'info');
    this.onGone?.();
  }

  /**
   * The open's second phase: each run's log, up to `BOOTSTRAP_RUN_CONCURRENCY`
   * at once, in `runIds` order. Each lands in one reducer step, silently;
   * listeners hear in batches (`noteRunLoaded`), and once more at the end.
   */
  private async loadRuns(runIds: readonly string[], openedMs: number): Promise<void> {
    const startedMs = Date.now();
    const callsBefore = this.requests;
    let eventBytes = 0;
    await this.eachBounded(runIds, async (runId) => {
      const fetched = await this.fetchRun(runId);
      const ownerFallback = this.runsLoading.get(runId);
      if (this.disposed || ownerFallback === undefined) return;
      for (const event of fetched.events) eventBytes += event.bytes;
      let lastEvent: RoomEvent | null = null;
      await this.ingestRun(runId, ownerFallback, (event) => {
        this.reduceLocal(event);
        lastEvent = event;
      }, fetched);
      this.runsLoading.delete(runId);
      if (this.disposed) return;
      if (lastEvent) this.noteRunLoaded(lastEvent);
      const recheck = this.recheckAfterLoad.get(runId);
      this.recheckAfterLoad.delete(runId);
      if (recheck === 'notified' || (recheck === 'ifLive' && this.isRunLive(runId))) void this.catchUp({ runs: [runId] });
    });
    if (this.disposed) return;
    this.flushRunNotify();
    this.log(
      'Rig spaces: room runs loaded',
      {
        bindingId: this.opts.bindingId,
        ms: Date.now() - startedMs,
        sinceOpenMs: Date.now() - openedMs,
        runs: runIds.length,
        calls: this.requests - callsBefore,
        eventBytes,
      },
      'info'
    );
  }

  /** A run's log just landed (silently): tell listeners every `RUN_NOTIFY_EVERY` runs, or `RUN_NOTIFY_MS` after the first one nobody has heard about. */
  private noteRunLoaded(event: RoomEvent): void {
    this.runNotifyEvent = event;
    this.runsSinceNotify += 1;
    if (this.runsSinceNotify >= RUN_NOTIFY_EVERY) this.flushRunNotify();
    else if (!this.runNotifyTimer) this.runNotifyTimer = setTimeout(() => this.flushRunNotify(), RUN_NOTIFY_MS);
  }

  private flushRunNotify(): void {
    if (this.runNotifyTimer) clearTimeout(this.runNotifyTimer);
    this.runNotifyTimer = null;
    this.runsSinceNotify = 0;
    const event = this.runNotifyEvent;
    this.runNotifyEvent = null;
    if (event && !this.disposed) this.notifyListeners(event);
  }

  /** Runs `task` over `items`, up to `BOOTSTRAP_RUN_CONCURRENCY` at once; stops taking new items once disposed. */
  private async eachBounded<T>(items: readonly T[], task: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < items.length && !this.disposed) {
        const item = items[next]!;
        next += 1;
        await task(item);
      }
    };
    const workerCount = Math.min(BOOTSTRAP_RUN_CONCURRENCY, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
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
    if (this.disposed) return;
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

    if (notification.type === 'message_created') {
      // New messages only; a run a new message names is fetched as it's ingested.
      await this.catchUp({ messages: true });
      return;
    }
    if (notification.type === 'reactions_changed') {
      const messageId = typeof notification.messageId === 'string' ? notification.messageId : null;
      if (messageId) await this.refreshReactions(messageId);
      return;
    }
    if (notification.type === 'themes_changed') {
      // `upTo` is the newest event id the relay has: nothing to fetch when we already hold it.
      const upTo = typeof notification.upTo === 'string' ? notification.upTo : null;
      const have = this.snapshot.themes?.cursor;
      if (
        upTo !== null &&
        have !== undefined &&
        /^\d{1,19}$/.test(upTo) &&
        compareEventIds(upTo, have) <= 0
      )
        return;
      if (this.themesActive()) await this.catchUp({ themes: true });
      return;
    }
    if (notification.type === 'session_event_appended') {
      // Just the run that moved (hide-details says so the same way). A
      // notification naming no run falls back to every live one.
      const runId = typeof notification.runId === 'string' ? notification.runId : null;
      await this.catchUp({ runs: runId ? [runId] : this.liveRunIds() });
      return;
    }
    if (notification.type === 'dispatch_suggestion') {
      const suggestion = parseDispatchSuggestion(notification, this.opts.selfUserId);
      if (suggestion) for (const listener of this.suggestionListeners) listener(suggestion);
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

  /**
   * Re-fetches what `work` names since the last known seq: new messages
   * (`?after=`), and/or these runs' new events. Called on connect, on every
   * notification and on each poll. Overlapping calls coalesce: work asked
   * for mid-pass is queued and picked up by the pass already running, never
   * a second concurrent one.
   */
  private async catchUp(work: { messages?: boolean; runs?: Iterable<string>; reactions?: boolean; themes?: boolean }): Promise<void> {
    if (this.disposed) return;
    if (work.messages) this.pendingMessages = true;
    if (work.reactions) this.pendingReactions = true;
    if (work.themes) this.pendingThemes = true;
    for (const runId of work.runs ?? []) this.pendingRuns.add(runId);
    if (this.catchingUp) return;
    this.catchingUp = true;
    try {
      while (!this.disposed && (this.pendingMessages || this.pendingRuns.size > 0 || this.pendingReactions || this.pendingThemes)) {
        const startedMs = Date.now();
        const callsBefore = this.requests;
        const messages = this.pendingMessages;
        const reactions = this.pendingReactions;
        const themes = this.pendingThemes;
        const runs = [...this.pendingRuns];
        this.pendingMessages = false;
        this.pendingReactions = false;
        this.pendingThemes = false;
        this.pendingRuns.clear();
        if (messages) await this.catchUpMessages();
        if (reactions) await this.catchUpReactions();
        await this.catchUpRuns(runs);
        // At the end of every catch-up that looks at messages (connect, poll, shown again), and on a themes notice.
        // A pass about one run's steps alone leaves themes be.
        if (themes || messages) await this.refreshThemes();
        this.log(
          'Rig spaces: room catch-up',
          {
            bindingId: this.opts.bindingId,
            ms: Date.now() - startedMs,
            calls: this.requests - callsBefore,
            messages,
            runs: runs.length,
          },
          'info'
        );
      }
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
    if (this.disposed) return;
    if (!result.success) {
      this.log('Rig spaces: could not catch up on room messages', { error: result.error.message });
      if (isGone(result.error)) this.gone();
      else this.setRelayUnreachable(true);
      return;
    }
    this.setRelayUnreachable(false);
    // A listing that came back is the Room's first load, if bootstrap's failed.
    if (this.snapshot.loaded === false) this.applyLocal({ type: 'room_loaded' });
    for (const row of result.data) {
      if (this.disposed) return;
      await this.ingestWireMessage(row);
    }
    // Shown from disk, and the relay couldn't be reached then: caught up now.
    if (this.snapshot.stale) this.applyLocal({ type: 'room_caught_up' });
  }

  /** Fetches the new events of each run in `runIds` the Room knows and the relay speaks for, in parallel (bounded). */
  private async catchUpRuns(runIds: readonly string[]): Promise<void> {
    // A run whose log is still loading: its fetch may have left before this
    // news, so it's re-read once that log is in (see `loadRuns`).
    for (const runId of runIds) if (this.runsLoading.has(runId)) this.recheckAfterLoad.set(runId, 'notified');
    // Your runs shown from this computer's own copy get their news from it.
    const due = [...new Set(runIds)].filter((runId) => this.snapshot.sessionMetaByRun[runId] && !this.localRunIds.has(runId));
    await this.eachBounded(due, async (runId) => {
      const after = this.lastRunSeq.get(runId) ?? 0;
      const result = await this.opts.relay.getSessionEvents(this.opts.bindingId, runId, after);
      // Switched to the local copy meanwhile: that copy already has these.
      if (this.disposed || this.localRunIds.has(runId)) return;
      if (!result.success) {
        this.log('Rig spaces: could not catch up on session events', {
          runId,
          error: result.error.message,
        });
        return;
      }
      for (const event of result.data.events) {
        if (event.seq <= (this.lastRunSeq.get(runId) ?? 0)) continue;
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
    });
  }

  /**
   * Turns one already-shaped relay message row into the right `RoomEvent`(s)
   * — a plain `message_created`, plus a synthesized `session_started` (+ its
   * full event backlog) the FIRST time a `kind:'session'` message names a
   * run this snapshot hasn't seen yet. `apply` is how each event reaches the
   * snapshot: defaults to `applyLocal` (mutate + notify, the realtime/
   * catch-up path, unchanged), but `bootstrap()` passes a silent variant so
   * nothing notifies until the whole initial batch is in. With `bootstrap`,
   * a run the message names isn't fetched here — it's marked loading, and
   * the open's second phase (`loadRuns`) fetches it — and the roster,
   * invites and connectors were just loaded whole, so the per-message
   * re-reads a live message triggers are skipped.
   */
  private async ingestWireMessage(
    row: RoomMessageRow,
    apply: (event: RoomEvent) => void = (event) => this.applyLocal(event),
    { bootstrap = false }: { bootstrap?: boolean } = {}
  ): Promise<void> {
    const built = await this.toRoomMessage(row, apply, { bootstrap });
    if (!built) return;
    apply({ type: 'message_created', id: row.id, seq: row.seq, kind: built.kind, message: built.message });
  }

  /**
   * One wire row as a Room message, with its side effects (a run it names
   * starts loading, a roster or connector refresh). `null` when it's
   * already here or the source went away. `older` (scrollback) leaves the
   * catch-up cursor alone and looks up thread parents in `peers` too, the
   * page being built.
   */
  private async toRoomMessage(
    row: RoomMessageRow,
    apply: (event: RoomEvent) => void,
    { bootstrap = false, older = false, peers = [] }: { bootstrap?: boolean; older?: boolean; peers?: RoomMessage[] } = {}
  ): Promise<{ kind: MessageKind; message: RoomMessage } | null> {
    if (row.seq <= this.lastMessageSeq && this.snapshot.messages.some((m) => m.id === row.id)) {
      return null; // already applied (bootstrap + catch-up overlap window)
    }
    if (!older) this.lastMessageSeq = Math.max(this.lastMessageSeq, row.seq);

    // Someone new accepted an invite: re-read the roster BEFORE resolving
    // the author below, so "Sam joined" maps to Sam (not a raw Clerk id)
    // and an emailed invite's card flips to "Joined".
    if (!bootstrap && row.kind === 'system' && row.meta?.event === 'member_joined') {
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
      if (bootstrap) {
        if (!this.runsLoading.has(runId)) this.runsLoading.set(runId, authorId);
      } else if (!this.runsLoading.has(runId)) {
        // (Still loading from the open: its own fetch lands it.)
        await this.ingestRun(runId, authorId, apply);
      }
    }

    if (!bootstrap && row.kind === 'invite' && typeof meta.inviteId === 'string' && !this.snapshot.invitesById[meta.inviteId]) {
      await this.refreshInvites();
    }

    if (!bootstrap && row.kind === 'system' && (meta.event === 'connectors_added' || meta.event === 'connectors_removed')) {
      await this.refreshConnectors(apply);
    }
    if (this.disposed) return null;

    // Doc comments share the message table (they carry a `path`). Keep them
    // in the room, rendered as comment lines tied to their file and passage.
    // A reply in a doc comment thread carries no path of its own; it takes
    // its thread's.
    const parent = row.parentId
      ? (this.snapshot.messages.find((m) => m.id === row.parentId) ?? peers.find((m) => m.id === row.parentId))
      : undefined;
    const threadPath = row.path ?? (parent?.meta.kind === 'comment_mirror' ? parent.meta.path : null);
    const comment = threadPath ? this.commentMeta({ ...row, path: threadPath }) : null;
    const kind = (comment ? 'comment_mirror' : row.kind) as MessageKind;

    return {
      kind,
      message: {
        id: row.id,
        seq: row.seq,
        authorId,
        createdAt: row.createdAt,
        time: formatClock(row.createdAt),
        body: row.body || undefined,
        meta: comment ?? toMessageMeta(row.kind, meta),
        ...(row.reactions?.length ? { reactions: this.memberReactions(row.reactions) } : {}),
        ...(typeof meta.clientId === 'string' && meta.clientId ? { clientId: meta.clientId } : {}),
        ...(comment
          ? { threadId: row.parentId ?? row.id }
          : runId && typeof meta.threadId === 'string'
            ? { threadId: meta.threadId }
            : {}),
      },
    };
  }

  /**
   * Scrollback: the page before the oldest message here
   * (`?before=<seq>&latest=<n>`), prepended in one step. Runs those
   * messages name load in the background, like on open. One page at a time;
   * a failure leaves `olderMessages` at 'more' so scrolling up tries again.
   */
  async loadOlder(): Promise<void> {
    if (this.disposed || this.loadingOlder || this.snapshot.olderMessages !== 'more') return;
    const seqs = this.snapshot.messages.map((m) => m.seq);
    if (seqs.length === 0) return;
    this.loadingOlder = true;
    this.applyLocal({ type: 'older_messages_loading' });
    try {
      const page = await this.opts.relay.listMessages(this.opts.bindingId, {
        before: String(Math.min(...seqs)),
        latest: OLDER_PAGE,
      });
      if (this.disposed) return;
      if (!page.success) {
        this.log('Rig spaces: could not load earlier messages', { error: page.error.message });
        this.applyLocal({ type: 'older_messages_loaded', messages: [], more: true });
        return;
      }
      const loadingBefore = new Set(this.runsLoading.keys());
      const built: RoomMessage[] = [];
      for (const row of page.data) {
        const message = await this.toRoomMessage(row, () => {}, { bootstrap: true, older: true, peers: built });
        if (this.disposed) return;
        if (message) built.push(message.message);
      }
      const newRuns = [...this.runsLoading.keys()].filter((id) => !loadingBefore.has(id));
      if (newRuns.length > 0) this.snapshot = { ...this.snapshot, runsLoading: this.loadingRecord() };
      this.applyLocal({ type: 'older_messages_loaded', messages: built, more: page.data.length >= OLDER_PAGE });
      // Newest first, like the open: the cards nearest where the reader is.
      if (newRuns.length > 0) void this.loadRuns(newRuns.reverse(), Date.now());
    } finally {
      this.loadingOlder = false;
    }
  }

  /** Lands a run's header and full backlog in one step (`session_log_loaded`), once — the first time a room message references it. Uses `prefetched` (the open's `loadRuns`) when given, else fetches it itself (the realtime path). */
  private async ingestRun(
    runId: string,
    ownerFallback: string,
    apply: (event: RoomEvent) => void,
    prefetched?: RunFetchResult
  ): Promise<void> {
    const { run, events } = prefetched ?? (await this.fetchRun(runId));
    if (this.disposed) return;
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
    // Yours, run on this computer: shown from its own full copy instead.
    if (meta.owner === this.opts.selfUserId && this.localRuns) {
      if (await this.withLocalRun(runId, () => this.loadLocalRun(runId, apply, meta))) return;
    }

    apply({
      type: 'session_log_loaded',
      runId,
      meta,
      events: events.map((event) => ({
        seq: event.seq,
        kind: event.kind,
        payload: event.payload,
        ...(event.truncated ? { truncated: event.truncated } : {}),
        ...(event.originalBytes != null ? { originalBytes: event.originalBytes } : {}),
      })),
    });
    for (const event of events) this.lastRunSeq.set(runId, Math.max(this.lastRunSeq.get(runId) ?? 0, event.seq));
  }

  // ── the owner overlay ───────────────────────────────────────────────────

  /** Runs `task` after any earlier local-copy operation on the same run, so a load and the events pushed meanwhile never interleave. */
  private withLocalRun<T>(runId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.localRunTasks.get(runId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.localRunTasks.set(runId, next.catch(() => undefined));
    return next;
  }

  /** Replaces a run's events with this computer's full copy of it, in one step. False (nothing changed) when there's no copy here. `meta` is for a run not in the snapshot yet (its first load). */
  private async loadLocalRun(runId: string, apply: (event: RoomEvent) => void, meta = this.snapshot.sessionMetaByRun[runId]): Promise<boolean> {
    if (!meta || !this.localRuns) return false;
    const events = await this.localRuns.events(runId).catch(() => null);
    if (!events || this.disposed) return false;
    this.localRunIds.add(runId);
    apply({ type: 'session_log_loaded', runId, meta, events });
    this.lastRunSeq.set(runId, events.at(-1)?.seq ?? 0);
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
   * dispatcher doesn't run the same ask a second time. `clientId` names the
   * app's own sending copy; the relay's copy carries it back, so the two are
   * matched whichever of the post's answer and the realtime echo comes first.
   */
  async send(
    text: string,
    replyTo?: RoomReplyRef,
    asks?: AgentKind,
    extra?: {
      attachments?: MessageAttachment[];
      autoBody?: boolean;
      clientId?: string;
      alsoInChannel?: boolean;
      /** You chose to just send it: the relay's router leaves it alone. */
      route?: 'none';
    }
  ): Promise<string | null> {
    const meta = {
      ...(replyTo ? { replyTo } : {}),
      ...(asks ? { asks } : {}),
      ...(extra?.attachments && extra.attachments.length > 0
        ? { attachments: extra.attachments, ...(extra.autoBody ? { autoBody: true } : {}) }
        : {}),
      ...(extra?.clientId ? { clientId: extra.clientId } : {}),
      // A thread reply that also shows in the main column (Threads view); text meta is free-form on the relay.
      ...(extra?.alsoInChannel ? { alsoInChannel: true } : {}),
      ...(extra?.route ? { route: extra.route } : {}),
    };
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
   * message the composer already sent for the human-visible text. Resolves
   * to whether the relay filed it.
   */
  async requestOwnAgent(
    targetAgent: AgentKind,
    prompt: string,
    sourceMessageId?: string
  ): Promise<boolean> {
    const result = await this.opts.relay.requestOwnAgent(this.opts.bindingId, {
      targetOwnerUserId: this.opts.selfUserId,
      targetAgent,
      prompt,
      ...(sourceMessageId ? { sourceMessageId } : {}),
    });
    return result.success;
  }

  // ── reactions ────────────────────────────────────────────────────────────

  /**
   * Your reaction on a message, on or off: shown at once, then settled to
   * what the relay answers (or put back, if it refused). Never a message:
   * nothing is posted and no agent is asked. Resolves to whether the relay
   * took it.
   */
  async react(messageId: string, emoji: string, on: boolean): Promise<boolean> {
    const spelled = canonicalEmoji(emoji);
    const message = this.snapshot.messages.find((m) => m.id === messageId);
    if (!spelled || !message || message.sending || !this.opts.relay.setReaction) return false;
    const before = message.reactions ?? [];
    const self = { userId: this.opts.selfUserId, agent: null };
    this.applyLocal({ type: 'reactions_changed', reactions: { [messageId]: withReaction(before, spelled, self, on) } });
    const result = await this.opts.relay.setReaction(this.opts.bindingId, { messageId, emoji: spelled, on });
    if (this.disposed) return result.success;
    if (result.success) {
      this.applyLocal({ type: 'reactions_changed', reactions: { [messageId]: this.memberReactions(result.data) } });
      return true;
    }
    this.log('Rig spaces: could not change a reaction', { error: result.error.message });
    // Put it back as it was, unless something else changed it meanwhile.
    const now = this.snapshot.messages.find((m) => m.id === messageId)?.reactions ?? [];
    const undone = withReaction(now, spelled, self, !on);
    this.applyLocal({ type: 'reactions_changed', reactions: { [messageId]: undone } });
    return false;
  }

  /** Re-reads one message's reactions (a `reactions_changed` notification). */
  private async refreshReactions(messageId: string): Promise<void> {
    if (!this.opts.relay.getReactions || !this.snapshot.messages.some((m) => m.id === messageId)) return;
    const result = await this.opts.relay.getReactions(this.opts.bindingId, messageId);
    if (this.disposed || !result.success) return;
    this.applyLocal({ type: 'reactions_changed', reactions: { [messageId]: this.memberReactions(result.data) } });
  }

  /** The reactions on every shown message that changed since they were read, or null when nothing did (or the relay can't say). */
  private async reactionsSince(): Promise<Record<string, MessageReaction[]> | null> {
    const shown = this.snapshot.messages.filter((m) => !m.sending);
    if (!this.opts.relay.listReactionsAfter || shown.length === 0) return null;
    const oldest = shown.reduce((min, m) => Math.min(min, m.seq), Number.POSITIVE_INFINITY);
    const result = await this.opts.relay.listReactionsAfter(this.opts.bindingId, oldest - 1);
    if (this.disposed || !result.success) return null;
    const changed: Record<string, MessageReaction[]> = {};
    for (const message of this.snapshot.messages) {
      if (message.sending || message.seq < oldest) continue;
      const next = this.memberReactions(result.data[message.id] ?? []);
      if (JSON.stringify(next) !== JSON.stringify(message.reactions ?? [])) changed[message.id] = next;
    }
    return Object.keys(changed).length > 0 ? changed : null;
  }

  // ── room themes ─────────────────────────────────────────────────────────

  /** Switches theme fetching live (the setting changed, or a Room was shown with it on). On: asks the relay now if the Room is open; off: the themes go. */
  setThemesEnabled(enabled: boolean): void {
    if (this.disposed || enabled === this.themesOn) return;
    this.themesOn = enabled;
    if (!enabled) {
      if (this.snapshot.themes) this.applyLocal({ type: 'themes_cleared' });
      return;
    }
    // A new choice: a relay that had no themes may have gained them since.
    this.themesUnsupported = false;
    if (this.started) void this.refreshThemes();
  }

  private themesActive(): boolean {
    return (
      this.themesOn &&
      !this.themesUnsupported &&
      !this.disposed &&
      !!this.opts.relay.getThemes &&
      !!this.opts.relay.getThemeEvents
    );
  }

  /** Brings the Room's themes up to date: the snapshot the first time, then the events after its cursor. Never throws; overlapping calls coalesce into one more pass. */
  private async refreshThemes(): Promise<void> {
    if (!this.themesActive()) return;
    if (this.themesBusy) {
      this.themesAgain = true;
      return;
    }
    this.themesBusy = true;
    try {
      do {
        this.themesAgain = false;
        await this.syncThemes();
      } while (this.themesAgain && this.themesActive());
    } catch (error) {
      // Themes are an extra: whatever went wrong, messages, runs and reactions carry on.
      this.log('Rig spaces: could not sync room themes', { error: String(error) });
    } finally {
      this.themesBusy = false;
    }
  }

  private async syncThemes(): Promise<void> {
    const { bindingId, relay } = this.opts;
    if (!this.snapshot.themes) {
      const result = await relay.getThemes!(bindingId);
      if (!this.themesActive()) return;
      if (!result.success) {
        this.log('Rig spaces: could not load room themes', { error: result.error.message });
        return;
      }
      if (!result.data.supported) return this.themesNotSupported();
      this.applyLocal({ type: 'themes_synced', snapshot: result.data.data });
      return;
    }
    // One page per request (500 events); a long gap takes a few, then yields and goes on in the pass after.
    for (let page = 0; page < THEME_EVENT_PAGES_PER_SYNC; page += 1) {
      const cursor = this.snapshot.themes?.cursor;
      if (cursor === undefined) return;
      const result = await relay.getThemeEvents!(bindingId, cursor);
      if (!this.themesActive() || !this.snapshot.themes) return;
      if (!result.success) {
        this.log('Rig spaces: could not load room theme changes', { error: result.error.message });
        return;
      }
      if (!result.data.supported) return this.themesNotSupported();
      const { events, lastId, nextCursor } = result.data.data;
      if (events.length > 0 || lastId !== null)
        this.applyLocal({ type: 'themes_applied', events, upTo: lastId });
      // Done, or no progress (a relay that keeps saying "more" without moving on must not hold this loop).
      if (nextCursor === null || lastId === null || compareEventIds(lastId, cursor) <= 0) return;
    }
    this.themesAgain = true;
  }

  /** The relay has no themes: the Room shows none and stops asking this session. */
  private themesNotSupported(): void {
    this.themesUnsupported = true;
    if (this.snapshot.themes !== undefined && this.snapshot.themes !== null)
      this.applyLocal({ type: 'themes_cleared' });
  }

  private async catchUpReactions(): Promise<void> {
    const reactions = await this.reactionsSince();
    if (reactions && !this.disposed) this.applyLocal({ type: 'reactions_changed', reactions });
  }

  /** The relay names reactors by Clerk id; the Room by member id (as it does message authors). */
  private memberReactions(reactions: readonly MessageReaction[]): MessageReaction[] {
    return reactions.map((r) => ({
      ...r,
      reactors: r.reactors.map((x) => ({ ...x, userId: x.userId ? (this.userIdByClerkId.get(x.userId) ?? x.userId) : null })),
    }));
  }

  /** Loads the space's invites into `invitesById`; an invite counts as joined once a member has its email. */
  private async refreshInvites(): Promise<void> {
    const rows = await this.fetchInvites();
    if (rows && !this.disposed) this.applyInvites(rows);
  }

  /** The space's invites, or null when there's no client for them or the read failed. */
  private async fetchInvites(): Promise<RoomInviteRow[] | null> {
    const result = await this.opts.relay.listInvites?.(this.opts.bindingId).catch(() => null);
    return result?.success ? result.data : null;
  }

  private applyInvites(rows: readonly RoomInviteRow[]): void {
    const memberEmails = new Set(this.snapshot.members.map((m) => m.email.toLowerCase()).filter(Boolean));
    const invitesById: RoomSnapshot['invitesById'] = { ...this.snapshot.invitesById };
    for (const invite of rows) {
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
    const connectors = await this.loadConnectors();
    if (connectors && !this.disposed) apply({ type: 'connectors_synced', connectors });
  }

  /** The space's connector list with this device's own state on each, both read at once; null when there's no client for it or the read failed. */
  private async loadConnectors(): Promise<RoomConnector[] | null> {
    const listFn = this.opts.relay.listConnectors;
    if (!listFn) return null;
    const [result, mineById] = await Promise.all([listFn(this.opts.bindingId), this.connectionStates()]);
    if (!result.success) {
      this.log('Rig spaces: could not load the space’s connectors', { error: result.error.message });
      return null;
    }
    return result.data.map((row) => {
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
    // A reply shows its thread's number, saved on the thread's first comment.
    const pin = pinOf(row.meta) ?? (parent?.meta.kind === 'comment_mirror' ? parent.meta.pin : undefined);
    return {
      kind: 'comment_mirror',
      commentId: row.parentId ?? row.id,
      path: row.path ?? '',
      quote: row.quote ?? parentQuote,
      ...(row.parentId ? { isReply: true } : {}),
      ...(agent === 'claude' || agent === 'codex' ? { replyFromAgent: agent } : {}),
      ...(typeof row.meta?.pageTitle === 'string' && row.meta.pageTitle ? { pageTitle: row.meta.pageTitle } : {}),
      ...(pin !== undefined ? { pin } : {}),
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
    // Never "typing" in a Room that isn't on screen.
    this.provider?.awareness?.setLocalStateField('typing', isTyping && this.shown);
  }

  // ── plumbing ────────────────────────────────────────────────────────────

  /** Folds an event into the snapshot AND notifies every listener — the realtime/catch-up path, and anything bootstrap wants to announce immediately. */
  private applyLocal(event: RoomEvent): void {
    if (this.disposed) return;
    this.reduceLocal(event);
    this.notifyListeners(event);
  }

  /** Folds an event into the snapshot without notifying anyone — `bootstrap()`'s own silent `apply`, so the initial batch never trickles out one event at a time. */
  private reduceLocal(event: RoomEvent): void {
    if (this.disposed) return;
    this.snapshot = reduceRoom(this.snapshot, event);
    // Every way a run's log lands (bootstrap, catch-up, the owner's own copy) passes here.
    if (event.type === 'session_event_appended' && event.event.kind === 'turn_ended') this.noteRunEnd(event.runId);
    if (event.type === 'session_log_loaded' && event.events.some((e) => e.kind === 'turn_ended')) this.noteRunEnd(event.runId);
  }

  // ── a finished run's end time ─────────────────────────────────────────

  /** A run whose log ended while its header (read as it ran) has no end time: queued for a re-read — see `RUN_END_REFRESH_MS`. */
  private noteRunEnd(runId: string): void {
    const meta = this.snapshot.sessionMetaByRun[runId];
    if (this.disposed || !meta || meta.endedAt || isFinished(meta.status)) return;
    if ((this.runEndTries.get(runId) ?? 0) >= RUN_END_REFRESH_TRIES) return;
    this.runEndDue.add(runId);
    this.runEndTimer ??= setTimeout(() => {
      this.runEndTimer = null;
      void this.refreshRunEnds();
    }, this.runEndRefreshMs);
  }

  /** Re-reads the due runs' headers (header only, no events); one still without an end time goes back in the queue while it has tries left. */
  private async refreshRunEnds(): Promise<void> {
    const due = [...this.runEndDue];
    this.runEndDue.clear();
    await this.eachBounded(due, async (runId) => {
      this.runEndTries.set(runId, (this.runEndTries.get(runId) ?? 0) + 1);
      const result = await this.opts.relay.getSessionEvents(this.opts.bindingId, runId, HEADER_ONLY_AFTER);
      if (this.disposed) return;
      const header = result.success ? result.data.run : null;
      if (header?.endedAt && this.snapshot.sessionMetaByRun[runId]) {
        this.applyLocal({ type: 'session_meta_updated', runId, meta: { status: header.status, endedAt: header.endedAt } });
        return;
      }
      this.noteRunEnd(runId);
    });
  }

  private notifyListeners(event: RoomEvent): void {
    for (const listener of this.listeners) listener(event, this.snapshot);
    this.scheduleDiskSave();
  }

  // ── the disk cache (rig/docs/room-disk-cache-spec.md) ──────────────────

  /** Saves the Room `DISK_SAVE_SETTLE_MS` after it last changed. */
  private scheduleDiskSave(): void {
    if (!this.diskCache || this.disposed) return;
    if (this.diskTimer) clearTimeout(this.diskTimer);
    this.diskTimer = setTimeout(() => {
      this.diskTimer = null;
      this.saveToDisk();
    }, DISK_SAVE_SETTLE_MS);
  }

  /**
   * Saves the Room now, if it's in a state worth opening with (see
   * `toCached`) — on leaving it, on quitting, and after it settles. One
   * write at a time; a newer Room replaces one still waiting.
   */
  saveToDisk(): void {
    if (!this.diskCache || this.disposed) return;
    if (this.diskTimer) clearTimeout(this.diskTimer);
    this.diskTimer = null;
    const blob = this.toCached();
    if (!blob) return;
    if (this.diskWriting) {
      this.diskQueued = blob;
      return;
    }
    const write = (next: CachedRoomBlob): void => {
      this.diskWriting = true;
      const startedMs = Date.now();
      void Promise.resolve(this.diskCache?.put(next))
        .catch(() => undefined)
        .finally(() => {
          this.diskWriting = false;
          this.log(
            'Rig spaces: room cache write',
            { bindingId: this.opts.bindingId, bytes: blobBytes(next), ms: Date.now() - startedMs },
            'info'
          );
          const queued = this.diskQueued;
          this.diskQueued = null;
          if (queued && !this.disposed) write(queued);
        });
    };
    write(blob);
  }

  /**
   * The Room as the disk cache keeps it, or null when it isn't worth saving
   * yet: not loaded, still catching up from an earlier save, or run logs
   * still loading. The latest `DISK_MESSAGE_WINDOW` messages; the runs they
   * name as their header plus — finished — their hide-safe summary, or —
   * still going — the header alone. Never a run's steps, thinking or tool
   * output (nor this computer's own full copy of your runs), presence,
   * typing, the connection, or your own connection state per connector.
   */
  toCached(): CachedRoomBlob | null {
    const s = this.snapshot;
    if (!s.loaded || s.stale || this.runsLoading.size > 0) return null;
    const messages = s.messages.slice(-DISK_MESSAGE_WINDOW);
    const blob: CachedRoomBlob = {
      v: ROOM_CACHE_FORMAT_VERSION,
      relayHost: '', // main stamps the relay it's signed in to
      savedAt: Date.now(),
      lastMessageSeq: Math.max(this.lastMessageSeq, ...messages.map((m) => m.seq)),
      messages: messages as unknown as CachedRoomBlob['messages'],
      members: s.members.map(({ online: _online, ...member }) => member) as unknown as CachedRoomBlob['members'],
      invitesById: s.invitesById as unknown as CachedRoomBlob['invitesById'],
      connectors: s.connectors.map(({ mine: _mine, account: _account, ...connector }) => connector),
      skills: s.skills as unknown as CachedRoomBlob['skills'],
      runs: this.cachedRuns(messages),
    };
    return this.fitToCap(blob);
  }

  private cachedRuns(messages: RoomSnapshot['messages']): CachedRoomBlob['runs'] {
    const runs: CachedRoomBlob['runs'] = {};
    for (const message of messages) {
      if (message.meta.kind !== 'session' || runs[message.meta.runId]) continue;
      const runId = message.meta.runId;
      const meta = this.snapshot.sessionMetaByRun[runId];
      if (!meta) continue;
      const card = runCard(this.snapshot, runId);
      const status = effectiveRunStatus(meta.status, card);
      const live = status === 'running' || status === 'waiting' || card.permissions.pending.length > 0;
      runs[runId] = live ? { meta, live: true } : { meta, summary: summarizeCard(card) };
    }
    return runs;
  }

  /** Within `ROOM_CACHE_MAX_BYTES`: oldest messages go first, then long answers are cut; null if it still won't fit. */
  private fitToCap(blob: CachedRoomBlob): CachedRoomBlob | null {
    let fitted = blob;
    while (blobBytes(fitted) > ROOM_CACHE_MAX_BYTES && fitted.messages.length > 1) {
      const messages = fitted.messages.slice(Math.max(1, Math.floor(fitted.messages.length / 10)));
      const named = new Set(messages.map((m) => (m.meta as { runId?: unknown }).runId).filter((id) => typeof id === 'string'));
      const runs = Object.fromEntries(Object.entries(fitted.runs).filter(([runId]) => named.has(runId)));
      fitted = { ...fitted, messages, runs };
    }
    if (blobBytes(fitted) > ROOM_CACHE_MAX_BYTES) {
      const runs = Object.fromEntries(
        Object.entries(fitted.runs).map(([runId, run]) => [
          runId,
          run.summary ? { ...run, summary: { ...run.summary, answer: run.summary.answer.slice(0, DISK_TRIMMED_ANSWER_CHARS) } } : run,
        ])
      );
      fitted = { ...fitted, runs };
    }
    return blobBytes(fitted) > ROOM_CACHE_MAX_BYTES ? null : fitted;
  }

  /**
   * A run shown from the disk cache is a summary only; expanding its card
   * fetches the log (the same one-run path a new run's message uses), which
   * replaces the summary. A failed fetch leaves the summary as it was.
   */
  async loadRunLog(runId: string): Promise<void> {
    if (this.disposed || !this.snapshot.sessionSummaryByRun?.[runId] || this.loadingLogs.has(runId)) return;
    this.loadingLogs.add(runId);
    try {
      const fetched = await this.fetchRun(runId);
      if (this.disposed || !fetched.run) return;
      const owner = this.snapshot.sessionMetaByRun[runId]?.owner ?? fetched.run.ownerUserId;
      await this.ingestRun(runId, owner, (event) => this.applyLocal(event), fetched);
    } finally {
      this.loadingLogs.delete(runId);
    }
  }
}

function isFinished(status: string): boolean {
  return status === 'done' || status === 'failed' || status === 'stopped';
}

/** The run a `kind:'session'` message names, or `null` for any other message. */
function sessionRunIdOf(row: RoomMessageRow): string | null {
  const meta = row.meta ?? {};
  return row.kind === 'session' && typeof meta.runId === 'string' ? meta.runId : null;
}

/** A relay answer meaning the space is gone (410) or no longer yours (404). */
function isGone(error: RelayApiError): boolean {
  return error.kind === 'relay' && (error.status === 404 || error.status === 410);
}

/** Bytes of a blob as it would be written. */
function blobBytes(blob: CachedRoomBlob): number {
  return new TextEncoder().encode(JSON.stringify(blob)).length;
}


/** Which agent wrote an agent-authored post: `meta.agent` when set, else inferred from `meta.model`. */
/** A comment's saved pin number (`meta.pin`), when it has one. */
function pinOf(meta: Record<string, unknown> | null): number | undefined {
  const pin = meta?.pin;
  return typeof pin === 'number' && Number.isInteger(pin) && pin > 0 ? pin : undefined;
}

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
      return {
        kind: 'session',
        runId: String(meta.runId ?? ''),
        ...(typeof meta.sourceMessageId === 'string' && meta.sourceMessageId ? { sourceMessageId: meta.sourceMessageId } : {}),
      };
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
      const attachments = parseMessageAttachments(meta.attachments);
      return {
        kind: 'text',
        ...(reply &&
        typeof reply === 'object' &&
        typeof reply.id === 'string' &&
        typeof reply.authorId === 'string' &&
        typeof reply.excerpt === 'string'
          ? {
              replyTo: {
                id: reply.id,
                authorId: reply.authorId,
                label: typeof reply.label === 'string' ? reply.label : '',
                excerpt: reply.excerpt,
              },
            }
          : {}),
        ...(attachments ? { attachments, ...(meta.autoBody === true ? { autoBody: true } : {}) } : {}),
        ...(meta.alsoInChannel === true ? { alsoInChannel: true } : {}),
      };
    }
  }
}
