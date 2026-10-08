import { AtSign, Hash, Pause, Play, RadioTower, Sparkles, UserPlus } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { type ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { deriveRoomConnection } from '@renderer/features/home/home-connection';
import { cmdFTarget, CmdFRouteContext, focusOf, isCmdF } from '@renderer/features/shell/cmd-f-target';
import { ConnectionBanner } from '@renderer/features/shell/connection-banner';
import { useAutoReconnect, useNavigatorOnline } from '@renderer/features/shell/use-connection';
import { toast } from '@renderer/lib/hooks/use-toast';
import { events, rpc } from '@renderer/lib/ipc';
import { cn } from '@renderer/lib/utils';
import type { ConnectorId, GlobalServer } from '@shared/spaces/connectors';
import type { RigNotification } from '@shared/rig/notifications';
import { rigSettingsChangedChannel } from '@shared/rig/settings';
import { spacesAgentConfigChangedChannel } from '@shared/spaces/agent-settings';
import { roomSeesFor, spacesLocalRunEventChannel } from '@shared/spaces/room-sees';
import { connectorsApi } from '../connectors-api';
import { buildRoomFeed } from '../fixtures/room-feed';
import {
  emptySnapshot,
  RelayRoomSource,
  type DispatchSuggestion,
  type LocalRunsClient,
  type RelayRoomClient,
} from '../relay-room-source';
import { FixtureRoomSource, type RoomSource } from '../room-source';
import { roomSourceCache, type RoomConnectionInfo, type RoomLease } from '../room-source-cache';
import type { CachedRoomBlob } from '@shared/spaces/room-cache';
import { readLastSeen, writeOpenedAt } from '../room-read-marker';
import { reportSpaceRead, windowIsLooking } from '@renderer/features/notifications/space-read-sync';
import { useRefreshMemberReadsOnRosterChange } from '../roster-refresh';
import { resolveSpaceLink } from '../space-link';
import { effectiveRunStatus, runCard } from '../projection';
import type { AgentKind, MessageMention, RoomMessage, RoomReplyRef, RoomSnapshot } from '../types';
import { mentionPeople } from '../mentions';
import type { RigPerson } from '@shared/rig/rig-share';
import type { MessageAttachment } from '@shared/rig/attachments';
import { fallbackBody, toMessageAttachments, type ComposerAttachment } from '../attachments';
import { useComposerAttachments } from '../use-composer-attachments';
import { useDockFocus } from '../use-dock-focus';
import { useChatSearch } from '../use-chat-search';
import { ChatSearchBar } from './chat-search-bar';
import { useRoomThemeRequest } from '../room-theme-request';
import type { ForYouState } from '../use-for-you';
import { useRoomThemesEnabled } from '../use-room-themes-enabled';
import { ForYouFeeder } from './for-you-feeder';
import { ThemeDock } from './theme-dock';
import { AttachmentSpaceContext, type AttachmentSpace } from './attachment-cards';
import { Composer, keepUnsentAsDraft, type ComposerPreview, type ComposerSendContext } from './composer';
import { ownTurnSuggestion } from '../own-turn-suggestion';
import { routeFromPreview } from '../send-decision';
import { useAvailableAgents } from '../use-available-agents';
import { settlePendingSends, withPendingSends, type PendingSend } from '../pending-sends';
import {
  isContinuation,
  renderItem,
  RoomTranscript,
  type RoomJumpRequest,
  type TranscriptSearch,
  type TranscriptThreads,
} from './room-transcript';
import { AskSuggestionContext, OpenPageContext, type AskSuggestion } from './transcript-items';
import { AGENT_NAME } from './identity';
import { replyRefFor, THREAD_PANEL_PX, ThreadPanel } from './thread-panel';
import { buildThreads, focusForThreads, newestSeq, summarizeThread, threadRootFor, type ThreadSummary } from '../threads';
import { readThreadSeen, writeThreadSeen } from '../thread-seen';
import { useSpacesChatView } from '../use-chat-view';
import { ReactionsContext, type ReactionsApi } from './reactions';
import { AgentSetupDialog } from '@renderer/features/agents/agent-install';
import { AgentRows, SpaceChipSummary } from './agent-rows';
import { AgentSignInRow } from './agent-sign-in-row';
import { SpaceRail } from './space-rail';
import { AgentSettingsContext, type AgentSettingsApi } from './agent-settings';
import { ConnectorGallery } from './connector-gallery';
import { ConnectorsSection } from './connectors-panel';
import { SpaceCard } from './space-card';
import { SpaceSetupState, type RoomSetup } from './space-setup-state';
import { SyncHealthNotice } from './sync-health-notice';
import { ProjectServersNotice } from './project-servers-notice';
import { setupDraftKey } from '../space-setup-store';
import { moveComposerDraft } from './composer';
import { SPACE_SETUP_PENDING_REASON } from '@shared/rig/space-setup';

/**
 * A thin 1:1 pass-through over `rpc.rig.spacesConnection` — see
 * `relay-room-source.ts`'s `RelayRoomClient` for why this lives here
 * instead of in that file (keeps it free of any `window.electronAPI`
 * dependency at module scope, for tests that never call this function).
 */
function createRelayRoomClient(): RelayRoomClient {
  const client = rpc.rig.spacesConnection;
  return {
    mintRealtimeTicket: (bindingId) => client.mintRealtimeTicket({ bindingId }),
    listMembers: (bindingId) => client.listMembers({ bindingId }),
    listSkills: (bindingId) => client.listSkills({ bindingId }),
    listInvites: (bindingId) => client.listInvites({ bindingId }),
    listMessages: (bindingId, query) => client.listMessages({ bindingId, query }),
    searchMessages: (bindingId, query) => client.searchMessages({ bindingId, query }),
    getSessionEvents: (bindingId, runId, after) => client.getSessionEvents({ bindingId, runId, after }),
    postMessage: (bindingId, input) => client.postMessage({ bindingId, ...input }),
    requestOwnAgent: (bindingId, input) => client.requestOwnAgent({ bindingId, ...input }),
    previewDraft: (bindingId, text) => client.previewDraft({ bindingId, text }),
    listConnectors: (bindingId) => client.listConnectors({ bindingId }),
    addConnector: (bindingId, connectorId) => client.addConnector({ bindingId, connectorId }),
    removeConnector: (bindingId, connectorId) => client.removeConnector({ bindingId, connectorId }),
    setReaction: (bindingId, input) => client.setReaction({ bindingId, ...input }),
    getReactions: (bindingId, messageId) => client.getReactions({ bindingId, messageId }),
    listReactionsAfter: (bindingId, afterSeq) => client.listReactionsAfter({ bindingId, afterSeq }),
    getThemes: (bindingId) => client.getThemes({ bindingId }),
    getThemeEvents: (bindingId, after) => client.getThemeEvents({ bindingId, after }),
    setThemesEnabled: (bindingId, enabled) => client.setThemesEnabled({ bindingId, enabled }),
  };
}

/** The Room's log lines into main's log (timings at info, failures at warn); never throws. */
function roomLog(message: string, extra?: Record<string, unknown>, level: 'info' | 'warn' = 'warn'): void {
  try {
    void rpc.rig.spacesConnection.log({ level, message, ...(extra ? { extra } : {}) }).catch(() => {});
  } catch {
    // Logging never gets in the Room's way.
  }
}

/** This space's Room from the disk cache, when the setting is on (rig/docs/room-disk-cache-spec.md). Never throws. */
type DiskRoom = { enabled: boolean; blob: CachedRoomBlob | null };
async function readDiskRoom(bindingId: string): Promise<DiskRoom> {
  try {
    const settings = await rpc.rig.settings.get();
    if (!settings.spacesRoomDiskCache) return { enabled: false, blob: null };
    const blob = await rpc.rig.roomCache.get({ bindingId }).catch(() => null);
    return { enabled: true, blob };
  } catch {
    return { enabled: false, blob: null };
  }
}

/** The owner overlay: this computer's own full copy of your runs (see `LocalRunsClient`). */
function createLocalRunsClient(): LocalRunsClient {
  return {
    events: async (runId) => (await rpc.rig.spacesDispatch.localRunEvents({ runId }).catch(() => null))?.events ?? null,
    subscribe: (listener) => events.on(spacesLocalRunEventChannel, listener),
  };
}

/**
 * Spaces: the Room view, mounted only when `spacesEnabled` is on (see
 * `normalizeSettings`, always on since 0.4.3, and the topbar's "Room
 * (preview)" entry point). Owns exactly one `RoomSource` for its lifetime
 * — `RelayRoomSource` against the real relay by default, or
 * `FixtureRoomSource` replaying the scripted Bob/Alice/Carol feed via the
 * dev toggle below (kept for demoing/debugging the Room UI with no relay
 * dependency, same as lane 2 built it) — and re-renders on every event.
 *
 * Play/pause is meaningful only for the fixture (a live room is always
 * "playing"; `RelayRoomSource.play()`/`.pause()` map to connect/disconnect
 * — see its own header comment) — the button is hidden for the relay
 * source.
 */

/** Room width below which the floating panel would cover the transcript. */
const ROOM_WIDE_PX = 1080;
/** How long before asking again to settle a run this device couldn't settle yet. */
const SETTLE_RETRY_MS = 20_000;
/** How long to wait for an agent's settings before offering Retry. */
const AGENT_CONFIG_TIMEOUT_MS = 20_000;
/** The transcript's centered column (44rem plus its side padding). */
const TRANSCRIPT_COLUMN_PX = 728;
/** The floating panel's lane at the right edge: its 304px plus a margin. */
const PANEL_LANE_PX = 320;

/** Narrower than this, an open thread takes the chat column's place instead of sitting beside it. */
const THREAD_BESIDE_MIN_PX = THREAD_PANEL_PX + 400;

/** How long a Room shown from disk may take to catch up before it says so. */
const CATCHING_UP_AFTER_MS = 600;
/** How long the router's "Ask Claude?" stays under your message. */
const ASK_SUGGESTION_MS = 5 * 60_000;

const NO_DEMO_ROWS: RigNotification[] = [];
const NO_MESSAGES: RoomMessage[] = [];
const FALLBACK_OWN_ID = 'bob'; // fixture-only identity; the relay source uses the signed-in user's real id

/**
 * Calm Room open: while `bootstrap()` is still loading the room whole (see
 * `RelayRoomSource`'s own header), three faint message-shaped rows stand in
 * for the transcript — a shape, not a spinner, so nothing seems to be
 * "thinking." `animate-pulse` is already reduced-motion-gated globally
 * (tokens.css), so this needs no gate of its own.
 */
export function RoomLoadingSkeleton() {
  const widths = ['w-2/3', 'w-1/2', 'w-5/6'];
  return (
    <div
      className="flex min-h-0 flex-1 flex-col justify-end gap-5 px-3 pb-6"
      data-testid="room-loading-skeleton"
      aria-hidden="true"
    >
      {widths.map((width, i) => (
        <div key={i} className="mx-auto flex w-full max-w-[44rem] items-start gap-3 px-3" style={{ opacity: 1 - i * 0.22 }}>
          <span className="bg-bg-2 size-7 shrink-0 animate-pulse rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-1">
            <span className="bg-bg-2 h-2 w-20 animate-pulse rounded-full" />
            <span className={cn('bg-bg-2 h-2 animate-pulse rounded-full', width)} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** A space with nothing in it yet: what it is, and three ways in. While the Room is still opening, the loading skeleton. */
function RoomWelcome({
  spaceName,
  connecting,
  hasSkills,
  onPrefill,
}: {
  spaceName: string;
  connecting: boolean;
  hasSkills: boolean;
  onPrefill: (text: string) => void;
}) {
  if (connecting) {
    return <RoomLoadingSkeleton />;
  }
  const action =
    'border-border-hairline bg-bg-1 hover:bg-bg-2 flex h-8 items-center gap-2 rounded-chip border px-3 text-sm text-text-primary transition-colors';
  return (
    <div
      className="card-pop-in flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-6 text-center"
      data-testid="room-welcome"
    >
      <span className="bg-bg-2 flex size-11 items-center justify-center rounded-card text-text-secondary">
        <Hash className="size-5" strokeWidth={1.5} />
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-xl text-text-primary">This is {spaceName}</h2>
        <p className="text-sm text-text-secondary">A space for you, your team and your agents.</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <button type="button" className={action} onClick={() => onPrefill('@claude invite ')}>
          <UserPlus className="size-3.5 text-text-muted" strokeWidth={1.5} />
          Invite someone
        </button>
        <button type="button" className={action} onClick={() => onPrefill('@claude ')}>
          <AtSign className="size-3.5 text-text-muted" strokeWidth={1.5} />
          Ask @claude
        </button>
        {hasSkills && (
          <button type="button" className={action} onClick={() => onPrefill('/')}>
            <Sparkles className="size-3.5 text-text-muted" strokeWidth={1.5} />
            Use a skill
          </button>
        )}
      </div>
    </div>
  );
}

/** The model each of your agents last ran here, for its composer pill. */
function lastModels(snapshot: RoomSnapshot, selfUserId: string): Partial<Record<AgentKind, string | null>> {
  const models: Partial<Record<AgentKind, string | null>> = {};
  const runs = Object.values(snapshot.sessionMetaByRun)
    .filter((m) => m.owner === selfUserId)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  for (const meta of runs) {
    const model = runCard(snapshot, meta.id).model;
    if (model) models[meta.agent] = model;
  }
  return models;
}

/** The viewer's own agents that are mid-turn, so the composer can say a new @mention will queue. */
function busyOwnAgents(snapshot: RoomSnapshot, selfUserId: string): AgentKind[] {
  const busy = new Set<AgentKind>();
  for (const meta of Object.values(snapshot.sessionMetaByRun)) {
    if (meta.owner !== selfUserId) continue;
    const status = effectiveRunStatus(meta.status, runCard(snapshot, meta.id));
    if (status === 'running') busy.add(meta.agent);
  }
  return [...busy];
}

export { withPendingSends };

/**
 * Sends what the composer understood: the message, then — when the pill
 * named one of your own agents (you tagged it, called it by name, or the
 * draft read as your answer to it, and you kept the pill) — an agent
 * request for it, linked to the message. The message is marked as asked
 * (`meta.asks`) so the relay's dispatcher doesn't run the same ask again.
 * A reply target rides on the message, so your agent's next turn follows
 * its own question. The request carries no settings: the turn runs in your
 * agent's persistent session for this space, as its last turn did (only
 * the @-pill's pickers change them, and they do it on the session itself).
 * The send button's menu and the relay's routing ask the same way; a plain
 * send you chose over the routing carries `meta.route: 'none'`.
 * Resolves to the message's id, or null when it wasn't sent.
 */
export async function sendFromComposer(
  source: Pick<RelayRoomSource, 'send' | 'requestOwnAgent'>,
  ownAgents: readonly AgentKind[],
  text: string,
  { replyTo, agent, attach, alsoInChannel, route, mentions }: ComposerSendContext,
  wake: () => void,
  attachments: readonly MessageAttachment[] = [],
  clientId?: string
): Promise<string | null> {
  const asks = agent && ownAgents.includes(agent) ? agent : null;
  // Files only: the relay needs words, and older apps show them; the cards say it here.
  const body = text || (attachments.length > 0 ? fallbackBody(attachments) : '');
  const extra = {
    ...(attachments.length > 0 ? { attachments: [...attachments], autoBody: !text } : {}),
    ...(clientId ? { clientId } : {}),
    ...(alsoInChannel ? { alsoInChannel: true } : {}),
    ...(route ? { route } : {}),
    ...(mentions && mentions.length > 0 ? { mentions } : {}),
  };
  const sourceMessageId =
    Object.keys(extra).length > 0
      ? await source.send(body, replyTo, asks ?? undefined, extra)
      : await source.send(body, replyTo, asks ?? undefined);
  if (!asks) return sourceMessageId;
  const prompt = attach ? `${text}\n\n(Open beside the chat: ${attach})` : text;
  await source.requestOwnAgent(asks, prompt, sourceMessageId ?? undefined);
  wake();
  return sourceMessageId;
}

/** A drag carrying files (not text or a link dragged within the page). */
function hasDraggedFiles(data: DataTransfer): boolean {
  return Array.from(data.types).includes('Files');
}

/** Cards for files still being copied: what the chips knew about them, no path yet. */
function pendingCards(files: readonly ComposerAttachment[]): MessageAttachment[] {
  return files.map((f) => ({
    name: f.verdict?.storedName ?? f.name ?? f.source.split('/').pop() ?? 'file',
    size: f.verdict?.size ?? 0,
    mime: f.verdict?.mime ?? 'application/octet-stream',
    kind: f.verdict?.disposition === 'localOnly' ? 'local-only' : 'copied',
    ...(f.verdict?.pageCount ? { pages: f.verdict.pageCount } : {}),
  }));
}

export function RoomView({
  bindingId,
  spaceName,
  onOpenFile,
  onOpenPage,
  openDoc = null,
  renderPanel,
  collapsed = false,
  onExpand: onExpandCollapsed,
  setup = null,
  jump = null,
  onJumpMissed,
  topBar,
  split = false,
}: {
  /** Empty while `setup` is still making the space (it has no binding yet). */
  bindingId: string;
  spaceName: string;
  /** Opens a space file (relative path) in the editor. */
  onOpenFile?: (relPath: string) => void;
  /** Opens a web page (a Claude artifact, a Google Doc) beside the Room. */
  onOpenPage?: (url: string, title: string) => void;
  /** The doc open beside the Room (its path in the space), if any. */
  openDoc?: string | null;
  /** Renders the live space panel (the rig's pinned card), given the Room's own rows to add to it. */
  renderPanel?: (
    extraRows: ReactNode,
    onlineUserIds: ReadonlySet<string>,
    options: {
      startCollapsed: boolean;
      chipSummary: (ctx: { unseenCount: number }) => ReactNode;
      /** Room themes: the dock, drawn in place of the chip, and under the panel (its shape grows into it). Absent with themes off. */
      collapsedDock?: (ctx: {
        onExpand: (section?: 'people') => void;
        onFold: () => void;
        open: boolean;
        card: ReactNode;
      }) => ReactNode;
    }
  ) => ReactNode;
  /**
   * Room chrome round: the doc-focus layout (the doc at full width) folds
   * the Room down to a small floating chip instead of unmounting it — the
   * connection and its live state stay up, only the transcript/composer
   * stop being drawn. See the `collapsed` early return below.
   */
  collapsed?: boolean;
  /** Brings the Room back beside the doc (the chip's own click target). */
  onExpand?: () => void;
  /**
   * Instant new space: the space is still being set up in the background.
   * The Room shows at once under its name with a calm "Setting up…" body;
   * the composer works (a message sent now waits and goes once the space
   * is live), Attach waits. Once App hands over the real `bindingId`, this
   * same Room becomes the live one — no remount, the waiting message sends.
   */
  setup?: RoomSetup | null;
  /** Notifications: scroll to this message or run once it's loaded (a banner or Activity click). */
  jump?: RoomJumpRequest | null;
  /** That message is further back than the Room loads. */
  onJumpMissed?: () => void;
  /** The app's bare top bar overlays the 40px above the Room: the transcript scrolls up beneath it and says when it has (see `RoomTranscript`'s own `topBar`). */
  topBar?: { onScrolled: (scrolled: boolean) => void };
  /** A doc or page is open beside the Room (the split layout): an open thread takes the chat column's place. */
  split?: boolean;
}) {
  const [useFixtures, setUseFixtures] = useState(false);
  /** The scripted demo's inbox rows (it has no inbox); set with its source. */
  const [demoNotifications, setDemoNotifications] = useState<RigNotification[] | undefined>(undefined);
  const [connectError, setConnectError] = useState<string | null>(null);
  /** The relay says this space is gone or no longer yours (its Room is forgotten, memory and disk). */
  const [gone, setGone] = useState(false);
  // A space kept alive behind others (`room-source-cache.ts`) shows its
  // snapshot on the very first render — no skeleton, no blank frame.
  const [source, setSource] = useState<RoomSource | null>(() => roomSourceCache.peek(bindingId));
  const [selfUserId, setSelfUserId] = useState(() =>
    roomSourceCache.peek(bindingId) ? (roomSourceCache.connection?.selfUserId ?? FALLBACK_OWN_ID) : FALLBACK_OWN_ID
  );
  const [snapshot, setSnapshot] = useState(() => source?.getSnapshot() ?? null);
  const [playing, setPlaying] = useState(false);
  const [replyTo, setReplyTo] = useState<RoomReplyRef | null>(null);
  const [gallery, setGallery] = useState<{
    open: boolean;
    focus: ConnectorId | null;
    initialScope: 'all' | 'installed' | 'available';
    initialSection: 'global-setup' | null;
  }>({ open: false, focus: null, initialScope: 'all', initialSection: null });
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const [pendingSends, setPendingSends] = useState<PendingSend[]>([]);
  // Instant new space: from the first setup frame until the live Room has
  // loaded, the Room shows the setup body and holds sends back (so a
  // message typed meanwhile goes to the real space with your real agents).
  const [cameFromSetup, setCameFromSetup] = useState(!!setup);
  const setupIdRef = useRef<string | null>(setup?.id ?? null);
  if (setup) setupIdRef.current = setup.id;
  const liveLoaded = source instanceof RelayRoomSource && !!snapshot && snapshot.loaded !== false;
  useEffect(() => {
    if (setup) setCameFromSetup(true);
    else if (liveLoaded || !bindingId) setCameFromSetup(false);
  }, [setup, liveLoaded, bindingId]);
  const awaitingLive = !!setup || (cameFromSetup && !liveLoaded);
  // The composer's draft lives under the setup's key until the space has
  // a binding id, then under that id (moved here in case the store's own
  // move on the live event hasn't happened yet).
  const draftKey = useMemo(() => {
    const setupId = setupIdRef.current;
    if (bindingId && setupId) moveComposerDraft(setupDraftKey(setupId), bindingId);
    return bindingId || (setupId ? setupDraftKey(setupId) : undefined);
  }, [bindingId]);
  const attachments = useComposerAttachments(bindingId, source instanceof RelayRoomSource);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  // Attaching needs the live space: said, not hidden, while it's set up.
  const composerAttachments = useMemo(
    () => (awaitingLive ? { ...attachments, disabledReason: SPACE_SETUP_PENDING_REASON } : attachments),
    [awaitingLive, attachments]
  );
  // Which space the composer shows now: a send that fails after you've moved on never puts its files in another space's box.
  const shownBindingRef = useRef(bindingId);
  shownBindingRef.current = bindingId;
  // Dragging files over the chat column: the whole column is the drop target.
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  // The body only exists once the Room has a snapshot (and isn't folded into
  // the doc-focus rail), so it's tracked as state: the observer attaches when
  // the element appears, not at mount — a mount-time `[]` effect missed it
  // and left `bodyWidth` at 0, which shoved the transcript left.
  const [bodyEl, bodyRef] = useState<HTMLDivElement | null>(null);
  const [bodyWidth, setBodyWidth] = useState(0);
  // Measured before the first paint: with messages showing at once, a first
  // frame laid out at width 0 (full panel clearance) visibly jumped the
  // transcript left, then back once the observer below reported.
  useLayoutEffect(() => {
    if (bodyEl) setBodyWidth(bodyEl.getBoundingClientRect().width);
  }, [bodyEl]);
  // rAF-throttled: a live window/split drag can report a new `contentRect`
  // faster than the screen paints, and each one used to re-render the whole
  // Room once per raw resize notification instead of once per painted frame.
  useEffect(() => {
    const el = bodyEl;
    if (!el) return;
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      if (frame) cancelAnimationFrame(frame);
      const width = entry!.contentRect.width;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setBodyWidth(width);
      });
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [bodyEl]);
  // Room for a ~44rem transcript beside the 304px panel.
  const narrow = bodyWidth > 0 && bodyWidth < ROOM_WIDE_PX;
  const hasPanel = !!renderPanel;
  const live = source instanceof RelayRoomSource;
  // Offline round: the same banner Home shows, when there's no network or
  // the relay's reads fail. Socket-down-but-polling stays the quiet note
  // below. The source keeps polling on its own; "Try again" (and the
  // network coming back) just does it now.
  const navigatorOnline = useNavigatorOnline();
  // Who `@` can tag besides the members: people invited here, and your people (rig/docs/people-management-scope.md).
  // Read on opening a space (main keeps it a minute); no list on an older relay or offline.
  const [yourPeople, setYourPeople] = useState<RigPerson[]>([]);
  useEffect(() => {
    if (!live) return;
    let alive = true;
    void Promise.resolve()
      .then(() => rpc.rig.share.people())
      .then(
        (result) => alive && result.success && setYourPeople(result.data.people),
        () => undefined
      );
    return () => {
      alive = false;
    };
  }, [live, bindingId]);
  const members = snapshot?.members;
  const invites = snapshot?.invitesById;
  const mentionable = useMemo(
    () =>
      members && invites
        ? mentionPeople(Object.values(invites), new Set(members.map((m) => m.id)), yourPeople)
        : [],
    [members, invites, yourPeople]
  );
  // "Invite and send": an invite aimed at that person, Can edit; the bell tells them.
  const invitePerson = useCallback(
    async (person: MessageMention): Promise<boolean> => {
      if (!live || !bindingId) return false;
      const result = await rpc.rig.share
        .inviteToSpace({ bindingId, targetUserId: person.id, role: 'editor' })
        .catch(() => null);
      if (result?.success) return true;
      toast({
        title: `Rig couldn’t invite ${person.name}`,
        description: result?.error.message ?? 'Try again in a moment.',
      });
      return false;
    },
    [live, bindingId]
  );
  const roomConnection = live
    ? deriveRoomConnection({
        navigatorOnline,
        connection: snapshot?.connection,
        relayUnreachable: snapshot?.relayUnreachable,
      })
    : null;
  const { retrying: reconnecting, tryAgain: reconnectNow } = useAutoReconnect({
    down: roomConnection !== null,
    autoRetry: false,
    retry: () => (source instanceof RelayRoomSource ? source.retryNow() : Promise.resolve()),
  });
  // The panel floats over the Room. The centered transcript only moves left
  // by as much as it takes to clear it, and not at all in a wide window.
  const panelClearance =
    hasPanel && !narrow ? Math.max(0, TRANSCRIPT_COLUMN_PX + 2 * PANEL_LANE_PX - bodyWidth) : 0;
  // The scripted-demo switch is a dev tool for the Room preview on plain
  // rigs; a real space (#name) never shows it.
  const showDemoToggle = !spaceName.startsWith('#');

  // Notifications: main stays quiet about the space on screen, and the relay
  // hears it's been seen (clears its run and request rows) on entering and
  // whenever the window comes back to it. Folded to the doc-focus rail, the
  // Room isn't on screen.
  useEffect(() => {
    if (!live || collapsed || !bindingId) return;
    const look = () => {
      if (!windowIsLooking()) return;
      void rpc.rig.notifications.setViewing({ bindingId }).catch(() => {});
      // What the transcript marked while the window was in the background
      // (`markReadThrough` holds it back from the relay until now).
      const seq = readLastSeen(bindingId);
      reportSpaceRead(bindingId, { ...(seq !== null ? { seq } : {}), seen: true }, true);
    };
    const away = () => void rpc.rig.notifications.setViewing({ bindingId: null }).catch(() => {});
    look();
    window.addEventListener('focus', look);
    document.addEventListener('visibilitychange', look);
    return () => {
      window.removeEventListener('focus', look);
      document.removeEventListener('visibilitychange', look);
      away();
    };
  }, [live, collapsed, bindingId]);

  // "Last opened" for Home's what-you-missed tiles (`room-read-marker.ts`):
  // stamped on entering the space and again on leaving it (or quitting from
  // inside it), so a run that ended while you were here reads as seen.
  useEffect(() => {
    if (!live) return;
    const stamp = () => writeOpenedAt(bindingId, Date.now());
    stamp();
    window.addEventListener('beforeunload', stamp);
    return () => {
      window.removeEventListener('beforeunload', stamp);
      stamp();
    };
  }, [live, bindingId]);

  // Quitting from inside a space: it's saved as it is (the disk cache, when on).
  useEffect(() => {
    if (!(source instanceof RelayRoomSource)) return;
    const save = () => source.saveToDisk();
    window.addEventListener('beforeunload', save);
    return () => window.removeEventListener('beforeunload', save);
  }, [source]);

  // Shown from disk and still catching up: said quietly, and only if it takes
  // a moment — a quick catch-up never flashes a line.
  const stale = snapshot?.stale === true;
  const [catchingUp, setCatchingUp] = useState(false);
  useEffect(() => {
    if (!stale) {
      setCatchingUp(false);
      return;
    }
    const id = setTimeout(() => setCatchingUp(true), CATCHING_UP_AFTER_MS);
    return () => clearTimeout(id);
  }, [stale]);

  // Your agents' own global MCP setup (connectors-spec.md's Surface) — this
  // device only, never part of the relay snapshot. Loaded once per Room;
  // main caches it (~5s the first time for Claude, instant after), so a
  // refresh on panel expand / gallery open is cheap.
  const [globalSetup, setGlobalSetup] = useState<GlobalServer[]>([]);
  const refreshGlobalSetup = () => {
    void connectorsApi.globalSetup(bindingId).then(setGlobalSetup).catch(() => {});
  };
  useEffect(() => {
    if (!live) return;
    refreshGlobalSetup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, bindingId]);

  const spaceNameRef = useRef(spaceName);
  spaceNameRef.current = spaceName;
  // Room themes: fetched only while the setting is on, switched live on the open Room.
  const themesEnabled = useRoomThemesEnabled();
  const themesEnabledRef = useRef(themesEnabled);
  themesEnabledRef.current = themesEnabled;
  // A send still out when you leave finishes in the background (its message
  // shows when you're back — the Room is kept alive); a failure is kept as a draft.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setConnectError(null);
    setGone(false);

    if (useFixtures) {
      const script = buildRoomFeed({ dock: themesEnabledRef.current });
      const fixtureSource = new FixtureRoomSource(script);
      setDemoNotifications(script.notifications?.(bindingId));
      setSource(fixtureSource);
      setSelfUserId(FALLBACK_OWN_ID);
      return () => fixtureSource.dispose();
    }

    // Still being set up: there's no space on the relay to connect to yet.
    if (!bindingId) {
      setSource(null);
      return;
    }

    // The live Room comes from the cache: kept alive behind other spaces,
    // it's shown again as it was and catches up; else it opens fresh. This
    // view only borrows it — leaving hands it back, it isn't torn down.
    let lease: RoomLease | null = null;
    const take = (info: RoomConnectionInfo, disk: DiskRoom | null) => {
      lease = roomSourceCache.acquire(info.selfUserId, bindingId, () =>
        new RelayRoomSource({
          bindingId,
          spaceName: spaceNameRef.current,
          wsUrl: info.wsUrl,
          selfUserId: info.selfUserId,
          relay: createRelayRoomClient(),
          themesEnabled: themesEnabledRef.current,
          connections: connectorsApi,
          localRuns: createLocalRunsClient(),
          log: roomLog,
          // The disk cache (`spacesRoomDiskCache`): opened from it, and saved to it.
          initial: disk?.blob ?? null,
          ...(disk?.enabled
            ? { diskCache: { put: (blob) => rpc.rig.roomCache.put({ bindingId, selfUserId: info.selfUserId, blob }) } }
            : {}),
          onGone: () => {
            roomSourceCache.forget(bindingId);
            if (!cancelled) setGone(true);
          },
        })
      );
      if (lease.reused) roomLog('Rig spaces: room first paint', { bindingId, source: 'memory', hiddenMs: lease.hiddenMs }, 'info');
      setSelfUserId(info.selfUserId);
      setSource(lease.source);
    };
    const known = roomSourceCache.connection;
    const kept = !!(known && roomSourceCache.peek(bindingId));
    if (known && kept) take(known, null);
    else setSource(null);

    // Still asked every time: who you are may have changed (another account).
    // Not kept in memory: the disk cache is read alongside (both are local).
    const startedMs = Date.now();
    void Promise.all([rpc.rig.spacesConnection.getConnectionInfo(), kept ? null : readDiskRoom(bindingId)]).then(
      ([result, disk]) => {
        if (cancelled) return;
        roomLog('Rig spaces: room connection info', { bindingId, ms: Date.now() - startedMs, ok: result.success }, 'info');
        if (!result.success) {
          // A kept-alive Room carries on (it polls without its socket); only a fresh open fails.
          if (!lease) setConnectError(result.error.message);
          return;
        }
        roomSourceCache.rememberConnection(result.data);
        if (lease?.selfUserId === result.data.selfUserId) return;
        lease?.release();
        take(result.data, disk);
      }
    );

    return () => {
      cancelled = true;
      (lease as RoomLease | null)?.release();
    };
  }, [useFixtures, bindingId]);

  // Renamed (by you, or by an agent): the Room's own name follows.
  useEffect(() => {
    if (source instanceof RelayRoomSource) source.rename(spaceName);
  }, [source, spaceName]);

  useEffect(() => {
    if (source instanceof RelayRoomSource) source.setThemesEnabled(themesEnabled);
  }, [source, themesEnabled]);

  useEffect(() => {
    if (!source) return;
    setSnapshot(source.getSnapshot());
    const unsubscribe = source.subscribe((_event, next) => setSnapshot(next));
    // The cache starts (and resumes) the live Room; only the scripted demo is played here.
    if (!(source instanceof RelayRoomSource)) source.play();
    setPlaying(true);
    return () => {
      unsubscribe();
      // `useFixtures`'s own effect disposes the source when it changes/
      // unmounts; this effect only owns the subscription + play/pause state.
    };
  }, [source]);

  // Your own runs the relay still shows running but no process here is
  // running (their end was lost): ask this device to close them out, once
  // each, so nobody's card spins forever.
  const settleTriedRef = useRef(new Set<string>());
  useEffect(() => {
    if (!(source instanceof RelayRoomSource) || !snapshot) return;
    for (const meta of Object.values(snapshot.sessionMetaByRun)) {
      if (meta.owner !== selfUserId || settleTriedRef.current.has(meta.id)) continue;
      const card = runCard(snapshot, meta.id);
      if (effectiveRunStatus(meta.status, card) !== 'running') continue;
      settleTriedRef.current.add(meta.id);
      // A "no" can just mean this device's dispatcher hasn't started yet
      // (right after launch): try that run again a little later.
      void rpc.rig.spacesDispatch
        .settleStaleRun({ runId: meta.id, bindingId })
        .catch(() => ({ settled: false }))
        .then(({ settled }) => {
          if (!settled) setTimeout(() => settleTriedRef.current.delete(meta.id), SETTLE_RETRY_MS);
        });
    }
  }, [source, snapshot, selfUserId, bindingId]);

  // The top bar's faces, the Details panel's People row and the share
  // popover read the members from the relay on their own; keep them in step
  // with the Room's live roster.
  useRefreshMemberReadsOnRosterChange(snapshot?.members ?? null, bindingId, live);

  // File links in the Room are written by agents: absolute paths (on the
  // machine that ran them), `file://` URLs, relative paths. The editor opens
  // only paths relative to the space's folder, so resolve each against it
  // first (`space-link.ts`) and refuse, with a word, only what's outside.
  const [spaceRoot, setSpaceRoot] = useState<string | null>(null);
  useEffect(() => {
    setSpaceRoot(null);
    if (!live) return;
    let alive = true;
    void rpc.rig.recent
      .resolveLocalPaths({ bindingIds: [bindingId] })
      .then((paths) => {
        if (alive) setSpaceRoot(paths[bindingId] ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [live, bindingId]);
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const openLink = useCallback(
    (link: string) => {
      const open = onOpenFileRef.current;
      if (!open) return;
      // Folder not known (yet): hand it over as before.
      if (!spaceRoot) return open(link);
      const resolved = resolveSpaceLink(link, spaceRoot);
      if (resolved.kind === 'inside') {
        // Made on someone else's computer and not synced here yet: say so,
        // instead of opening an editor that can only fail.
        void Promise.resolve()
          .then(() => rpc.rig.attachments.status({ bindingId, files: [{ path: resolved.relPath }], withRelay: false }))
          .catch(() => null)
          .then((result) => {
            if (result && result[0] && !result[0].exists) {
              toast({ title: 'Not on this computer yet', description: 'It will open once it syncs.' });
              return;
            }
            open(resolved.relPath);
          });
        return;
      }
      if (resolved.kind === 'external') return void rpc.app.openExternal(link).catch(() => {});
      toast({
        title: 'That file isn’t in this space',
        description: `${resolved.path} is outside ${spaceName}’s folder, so it can’t open here.`,
      });
    },
    [spaceRoot, spaceName, bindingId]
  );
  const handleOpenFile = onOpenFile ? openLink : undefined;
  // The composer's `+` file suggestions: the space's files as the Files navigator shows them.
  const listSpaceFiles = useCallback(() => rpc.rig.attachments.listFiles({ bindingId }), [bindingId]);
  const attachmentSpace = useMemo<AttachmentSpace | null>(
    () =>
      live
        ? {
            bindingId,
            spaceRoot,
            selfUserId,
            onOpenFile,
            status: (files, withRelay) => rpc.rig.attachments.status({ bindingId, files, withRelay }),
            thumbnail: (path) => rpc.rig.attachments.thumbnail({ bindingId, path }),
            reveal: (absPath) => void rpc.app.showItemInFolder(absPath).catch(() => {}),
            copyText: (text) => void rpc.app.clipboardWriteText(text).catch(() => {}),
          }
        : null,
    [live, bindingId, spaceRoot, selfUserId, onOpenFile]
  );

  // Every hook sits above the early returns below: React needs the same
  // hooks in the same order on every render.
  const configCache = useRef(new Map<AgentKind, ReturnType<AgentSettingsApi['load']>>());
  // Reactions: yours, on the live Room only (the scripted demo shows them but can't change them).
  const reactionsApi = useMemo<ReactionsApi | null>(
    () => (source instanceof RelayRoomSource ? { react: (messageId, emoji, on) => void source.react(messageId, emoji, on) } : null),
    [source]
  );
  const agentSettingsApi = useMemo<AgentSettingsApi | null>(
    () =>
      source instanceof RelayRoomSource
        ? {
            // One fetch per agent, shared by every menu and pill in the Room;
            // a failed fetch isn't cached, so the next open tries again.
            load: (agent) => {
              const cached = configCache.current.get(agent);
              if (cached) return cached;
              // Reaching the agent can hang (a session that won't start): give up after a while.
              const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), AGENT_CONFIG_TIMEOUT_MS));
              const pending = Promise.race([rpc.rig.spacesDispatch.agentConfig({ bindingId, agent }).catch(() => null), timeout])
                .then((result) => {
                  if (!result) return { error: `Couldn't reach your ${agent === 'claude' ? 'Claude' : 'Codex'}'s settings.` };
                  return result.success ? result.data : { error: result.error };
                })
                .then((loaded) => {
                  if ('error' in loaded) configCache.current.delete(agent);
                  return loaded;
                });
              configCache.current.set(agent, pending);
              return pending;
            },
            remember: (agent, change) => {
              void rpc.rig.settings
                .set({
                  ...(change.model ? { lastModelByHarness: { [agent]: change.model } } : {}),
                  ...(change.effort ? { lastEffortByHarness: { [agent]: change.effort } } : {}),
                  ...(change.mode ? { lastModeByHarness: { [agent]: change.mode } } : {}),
                })
                .catch(() => {});
            },
            change: async (agent, change) => {
              const result = await rpc.rig.spacesDispatch
                .setAgentConfig({ bindingId, agent, change })
                .catch(() => null);
              if (!result) return { error: "Couldn't change this agent's settings." };
              if (result.success) configCache.current.set(agent, Promise.resolve(result.data));
              return result.success ? result.data : { error: result.error };
            },
            // Your agent changed its own settings (rig_update_settings).
            watch: (agent, onChange) =>
              events.on(spacesAgentConfigChangedChannel, (changed) => {
                if (changed.bindingId !== bindingId || changed.agent !== agent) return;
                configCache.current.set(agent, Promise.resolve(changed.config));
                onChange(changed.config);
              }),
            // "Room sees" is this space's, on this computer: every agent of yours here shares it.
            roomSees: {
              load: async () => {
                const settings = await rpc.rig.settings.get();
                return roomSeesFor(settings.spacesRoomSees, bindingId, settings.spacesRoomSeesDefault);
              },
              change: async (level) =>
                rpc.rig.settings
                  .set({ spacesRoomSees: { [bindingId]: level } })
                  .then(() => true)
                  .catch(() => false),
              watch: (onChange) =>
                events.on(rigSettingsChangedChannel, (settings) =>
                  onChange(roomSeesFor(settings.spacesRoomSees, bindingId, settings.spacesRoomSeesDefault))
                ),
            },
          }
        : null,
    [source, bindingId]
  );

  // A plain draft that reads as your answer to one of your own agent's
  // turns: the relay asks Jev, and only a finished turn of YOUR agent that
  // this Room shows comes back as the composer's pills.
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const suggestReply = useCallback(
    async (draft: string): Promise<ComposerPreview | null> => {
      if (!(source instanceof RelayRoomSource)) return null;
      const preview = await source.previewDraft(draft);
      return {
        reply: ownTurnSuggestion(snapshotRef.current, selfUserId, preview),
        route: routeFromPreview(preview, selfUserId),
      };
    },
    [source, selfUserId]
  );
  const availableAgents = useAvailableAgents();
  // "Set up" from the composer's notice: the install offer for that agent.
  const [setUpAgent, setSetUpAgent] = useState<AgentKind | null>(null);

  // The router's private "was this for your agent?" about one of your
  // messages: one quiet button under it, until you use it, send something
  // else, or a few minutes pass.
  const [dispatchSuggestion, setDispatchSuggestion] = useState<DispatchSuggestion | null>(null);
  useEffect(() => {
    setDispatchSuggestion(null);
    if (!(source instanceof RelayRoomSource)) return;
    return source.onDispatchSuggestion(setDispatchSuggestion);
  }, [source]);
  useEffect(() => {
    if (!dispatchSuggestion) return;
    const timer = setTimeout(() => setDispatchSuggestion(null), ASK_SUGGESTION_MS);
    return () => clearTimeout(timer);
  }, [dispatchSuggestion]);
  const askSuggestion = useMemo((): AskSuggestion | null => {
    if (!dispatchSuggestion || !(source instanceof RelayRoomSource)) return null;
    const { messageId, agent } = dispatchSuggestion;
    // Never offer to ask an agent this Mac can't run.
    if (availableAgents && !availableAgents.includes(agent)) return null;
    return {
      messageId,
      agent,
      // The same ask an @mention files, with this message as its source.
      ask: () => {
        setDispatchSuggestion(null);
        const message = snapshotRef.current?.messages.find((m) => m.id === messageId);
        if (!message?.body) return;
        void source
          .requestOwnAgent(agent, message.body, messageId)
          .catch(() => false)
          .then((filed) => {
            if (filed) void rpc.rig.spacesDispatch.checkNow();
            else toast({ title: `Rig couldn’t ask ${AGENT_NAME[agent]}`, description: 'Try again in a moment.' });
          });
      },
    };
  }, [dispatchSuggestion, source, availableAgents]);

  const togglePlay = () => {
    if (!source || source.isDone()) return;
    if (source.isPlaying()) {
      source.pause();
      setPlaying(false);
    } else {
      source.play();
      setPlaying(true);
    }
  };

  /** `restore`: where an unsent message goes back to (the main box, or the open thread's). */
  const handleSend = (
    text: string,
    context: ComposerSendContext,
    restore: (text: string) => void = (unsent) => setPrefill({ text: unsent, nonce: Date.now() })
  ) => {
    if (!(source instanceof RelayRoomSource) || !snapshot) return;
    setDispatchSuggestion(null);
    // Only agents this Mac can run get a request: one it can't would wait forever.
    const ownAgents = snapshot.agents
      .filter((a) => a.owner === selfUserId && (!availableAgents || availableAgents.includes(a.agent)))
      .map((a) => a.agent);
    const localId = `sending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const files = context.files ?? [];
    setPendingSends((current) => [
      ...current,
      {
        localId,
        text,
        ...(context.replyTo ? { replyTo: context.replyTo } : {}),
        ...(context.alsoInChannel ? { alsoInChannel: true } : {}),
        createdAt: new Date().toISOString(),
        id: null,
        ...(files.length > 0 ? { attachments: pendingCards(files) } : {}),
      },
    ]);
    // Not sent: it leaves the transcript and goes back in the composer (text and files), so nothing is lost.
    const failed = (reason?: { source?: string; message: string }) => {
      // You'd left the space meanwhile: the text waits in that space's message box instead.
      if (!mountedRef.current) keepUnsentAsDraft(bindingId, text);
      setPendingSends((current) => current.filter((send) => send.localId !== localId));
      if (text) restore(text);
      if (files.length > 0 && mountedRef.current && shownBindingRef.current === bindingId) {
        attachmentsRef.current.restore(files, reason);
      }
      toast({
        title: 'Your message wasn’t sent',
        description: reason
          ? `${reason.message} It’s back in the message box.`
          : 'It’s back in the message box. Try sending it again.',
      });
    };
    const post = (attachments: MessageAttachment[]) =>
      // Wake this device's claim poller rather than waiting for its next tick.
      sendFromComposer(source, ownAgents, text, context, () => void rpc.rig.spacesDispatch.checkNow(), attachments, localId).then(
        (id) =>
          id === null
            ? failed()
            : setPendingSends((current) => current.map((send) => (send.localId === localId ? { ...send, id } : send))),
        () => failed()
      );
    if (files.length === 0) {
      void post([]);
      return;
    }
    // Copy on send: the files go into the space first; a failed post leaves them there (they sync) and a retry reuses them.
    void rpc.rig.attachments
      .commit({ bindingId, files: files.map((f) => ({ source: f.source, ...(f.name ? { name: f.name } : {}), ...(f.shareAnyway ? { shareAnyway: true } : {}) })) })
      .then(
        (result) => {
          if (!result.success) return failed({ source: result.error.source, message: result.error.message });
          const verdicts = new Map(files.map((f) => [f.source, f.verdict]));
          return post(toMessageAttachments(result.data, verdicts));
        },
        () => failed({ message: 'Rig couldn’t copy the files into the space.' })
      );
  };

  // A pending message is done once the real one (same client id, or id) is in the snapshot.
  useEffect(() => {
    if (!snapshot) return;
    setPendingSends((current) => settlePendingSends(current, snapshot));
  }, [snapshot]);
  const shownSnapshot = useMemo(
    () => (snapshot ? withPendingSends(snapshot, pendingSends, selfUserId) : snapshot),
    [snapshot, pendingSends, selfUserId]
  );

  // Room themes: the dock, For you, and what the transcript is focused on.
  // The per-Space switch (`themes.enabled`) turns the dock off for the Room.
  const dockOn = themesEnabled && snapshot?.themes?.enabled !== false;
  const [forYouState, setForYouState] = useState<ForYouState | null>(null);
  const dockForYou = dockOn ? forYouState : null;
  const dockFocus = useDockFocus({
    enabled: dockOn,
    themes: snapshot?.themes,
    forYou: dockForYou?.forYou ?? null,
    dismiss: dockForYou?.dismiss ?? null,
  });
  // Another Space: nothing stays focused (the dock itself is keyed by the Space, so its open panel and list close).
  const clearDockFocus = dockFocus.clear;
  useEffect(() => clearDockFocus(), [bindingId, clearDockFocus]);
  // Opened from Home on a theme: its pill is focused once the themes are in.
  useRoomThemeRequest({ bindingId, enabled: dockOn, themes: snapshot?.themes, focusOn: dockFocus.focusOn });
  // The messages the hovered pill holds: the transcript dims the rest.
  const [dockPreview, setDockPreview] = useState<ReadonlySet<string> | null>(null);
  // How far the dock's pills reach from the right edge, which the transcript keeps clear of.
  const [dockGutter, setDockGutter] = useState(0);
  const [gutterMoving, setGutterMoving] = useState(false);
  const onDockGutter = useCallback((px: number) => {
    setGutterMoving(true);
    setDockGutter(px);
  }, []);
  useEffect(() => {
    if (!gutterMoving) return;
    const timer = setTimeout(() => setGutterMoving(false), 600);
    return () => clearTimeout(timer);
  }, [gutterMoving, dockGutter]);
  // Threads view (Settings › Spaces › Chat view): the main column shows the
  // roots, and one thread at a time opens beside it, or in its place beside
  // a doc. Flow leaves everything as it was.
  const chatView = useSpacesChatView();
  const threadsOn = chatView === 'threads';
  const shownMessages = shownSnapshot?.messages;
  const threadsLayout = useMemo(
    () => (threadsOn && shownMessages ? buildThreads(shownMessages) : null),
    [threadsOn, shownMessages]
  );
  const [openThread, setOpenThread] = useState<{
    rootId: string;
    /** A reply to scroll to and ring once (a notification's jump). */
    focus: { messageId: string; nonce: number } | null;
  } | null>(null);
  const [threadReplyTo, setThreadReplyTo] = useState<RoomReplyRef | null>(null);
  const [alsoInChannel, setAlsoInChannel] = useState(false);
  const [threadPrefill, setThreadPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const openRootIdRef = useRef<string | null>(null);
  openRootIdRef.current = openThread?.rootId ?? null;
  const openThreadOn = useCallback(
    (rootId: string, options: { focusId?: string; replyTo?: RoomReplyRef | null } = {}) => {
      if (openRootIdRef.current !== rootId) {
        setAlsoInChannel(false);
        setThreadPrefill(null);
      }
      setOpenThread({ rootId, focus: options.focusId ? { messageId: options.focusId, nonce: Date.now() } : null });
      setThreadReplyTo(options.replyTo ?? null);
    },
    []
  );
  const closeThread = useCallback(() => {
    setOpenThread(null);
    setThreadReplyTo(null);
    setAlsoInChannel(false);
    setThreadPrefill(null);
  }, []);
  // Another space, or back to Flow: no thread stays open.
  useEffect(() => closeThread(), [bindingId, closeThread]);
  useEffect(() => {
    if (!threadsOn) closeThread();
  }, [threadsOn, closeThread]);
  const openRoot = openThread && shownMessages ? shownMessages.find((m) => m.id === openThread.rootId) : undefined;
  const openReplies = (openThread && threadsLayout?.threads.get(openThread.rootId)?.replies) || NO_MESSAGES;
  useEffect(() => {
    if (openThread && shownMessages && !openRoot) closeThread();
  }, [openThread, shownMessages, openRoot, closeThread]);

  // Unread replies: a thread you open is seen up to its newest reply; one you
  // never opened here counts from where you'd read the space when you came in.
  const seenBaselineRef = useRef<{ bindingId: string; seq: number | null } | null>(null);
  if (seenBaselineRef.current?.bindingId !== bindingId) {
    seenBaselineRef.current = { bindingId, seq: readLastSeen(bindingId) };
  }
  const [seenVersion, setSeenVersion] = useState(0);
  const openNewest = openRoot ? newestSeq({ root: openRoot, replies: openReplies }) : null;
  useEffect(() => {
    if (!openRoot || openNewest === null || !bindingId) return;
    if (writeThreadSeen(bindingId, openRoot.id, openNewest)) setSeenVersion((v) => v + 1);
  }, [bindingId, openRoot, openNewest]);
  const threadSummaries = useMemo(() => {
    void seenVersion; // a thread just marked seen re-reads its marker
    if (!threadsLayout || !shownSnapshot) return null;
    const baseline = seenBaselineRef.current?.seq ?? null;
    const running = (runId: string) => {
      const meta = shownSnapshot.sessionMetaByRun[runId];
      return !!meta && effectiveRunStatus(meta.status, runCard(shownSnapshot, runId)) === 'running';
    };
    const summaries = new Map<string, ThreadSummary>();
    for (const [rootId, thread] of threadsLayout.threads) {
      const seen = readThreadSeen(bindingId, rootId) ?? baseline;
      summaries.set(rootId, summarizeThread(thread, shownSnapshot, selfUserId, seen, running));
    }
    return summaries;
  }, [threadsLayout, shownSnapshot, selfUserId, bindingId, seenVersion]);
  const openRootId = openThread?.rootId ?? null;
  const transcriptThreads = useMemo<TranscriptThreads | undefined>(
    () =>
      threadSummaries
        ? { summaries: threadSummaries, openRootId, onOpen: (rootId) => openThreadOn(rootId) }
        : undefined,
    [threadSummaries, openRootId, openThreadOn]
  );
  // The main column's own messages; reading it to the bottom still reads the replies folded away.
  const transcriptSnapshot = useMemo(
    () => (shownSnapshot && threadsLayout ? { ...shownSnapshot, messages: threadsLayout.main } : shownSnapshot),
    [shownSnapshot, threadsLayout]
  );
  const readThroughSeq = useMemo(
    () => (threadsLayout && shownMessages?.length ? Math.max(...shownMessages.map((m) => m.seq)) : undefined),
    [threadsLayout, shownMessages]
  );
  const transcriptFocus = useMemo(
    () => (threadsLayout ? focusForThreads(dockFocus.transcriptFocus, threadsLayout) : dockFocus.transcriptFocus),
    [threadsLayout, dockFocus.transcriptFocus]
  );

  // Search (Cmd-F): while a query is in, the matches are drawn over the chat,
  // which stays where it was underneath, so closing the search puts the
  // reader back at the same place. Search wins over a focused theme while
  // it's on (the theme's view is what comes back). In Threads view the
  // matches are flat, a reply saying it's in a thread.
  const chatSearch = useChatSearch({ bindingId, source, snapshot: shownSnapshot });
  const searchActive = chatSearch.open && chatSearch.plan !== null;
  // "Show in chat": a jump of the Room's own, the same way a notification's goes (paging back if it must).
  const [localJump, setLocalJump] = useState<RoomJumpRequest | null>(null);
  useEffect(() => setLocalJump(null), [bindingId]);
  const activeJump = useMemo(
    () => (!localJump ? jump : !jump || localJump.nonce > jump.nonce ? localJump : jump),
    [jump, localJump]
  );
  const closeSearch = chatSearch.close;
  const showInChat = useCallback(
    (message: RoomMessage) => {
      closeSearch();
      setLocalJump({ messageId: message.id, messageSeq: message.seq, runId: null, nonce: Date.now() });
    },
    [closeSearch]
  );
  const searchView = useMemo<TranscriptSearch | undefined>(() => {
    if (!chatSearch.plan) return undefined;
    return {
      plan: chatSearch.plan,
      onShowInChat: showInChat,
      ...(threadsLayout
        ? { contextLabel: (m: RoomMessage) => (threadsLayout.rootOf.has(m.id) ? 'In a thread' : null) }
        : {}),
    };
  }, [chatSearch.plan, showInChat, threadsLayout]);
  const { matches: searchMatches, remote: searchRemote } = chatSearch;
  const searchSnapshot = useMemo<RoomSnapshot | null>(() => {
    if (!shownSnapshot || !searchActive) return null;
    return {
      ...shownSnapshot,
      messages: searchMatches,
      typingUserIds: [],
      // Scrolling up the matches asks the relay for older ones.
      olderMessages: searchRemote.loadingMore ? 'loading' : searchRemote.more ? 'more' : undefined,
    };
  }, [shownSnapshot, searchActive, searchMatches, searchRemote]);

  // Cmd-F in the Room opens the search, or selects what's in it, when the
  // chat is the pane you're in (`cmd-f-target.ts`): beside a doc, the one you
  // last clicked or focused; a doc's editor has its own find. On its own,
  // outside App, the Room is the only pane.
  const roomRootRef = useRef<HTMLDivElement>(null);
  const openChatSearch = chatSearch.openSearch;
  const searchOpen = chatSearch.open;
  const getCmdFRoute = useContext(CmdFRouteContext);
  const isChatsKey = useCallback(
    (event: KeyboardEvent) => {
      const route = getCmdFRoute?.() ?? { layout: 'chat' as const, lastPane: 'chat' as const };
      const target = event.target instanceof Element ? event.target : null;
      return (
        cmdFTarget({
          ...route,
          focus: focusOf(event.target, { root: roomRootRef.current, pane: 'chat' }),
          editorFocused: target?.closest('.cm-editor') != null,
          previewOpen: false,
        }) === 'chat-search'
      );
    },
    [getCmdFRoute]
  );
  useEffect(() => {
    if (collapsed) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isCmdF(event) || !isChatsKey(event)) return;
      event.preventDefault();
      openChatSearch();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [collapsed, openChatSearch, isChatsKey]);
  // Esc closes it from anywhere in the Room (in the field, the field says so
  // first), before a focused theme hears it. Beside a doc, only when the chat
  // is the pane you're in.
  useEffect(() => {
    if (!searchOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (!isChatsKey(event)) return;
      event.preventDefault();
      closeSearch();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [searchOpen, closeSearch, isChatsKey]);

  // A notification pointing at a reply: the main column goes to its root, and its thread opens on it.
  const jumpTargetId = useMemo(() => {
    if (!activeJump || !threadsLayout || !shownMessages) return null;
    if (activeJump.messageId) return activeJump.messageId;
    if (!activeJump.runId) return null;
    return shownMessages.find((m) => m.meta.kind === 'session' && m.meta.runId === activeJump.runId)?.id ?? null;
  }, [activeJump, threadsLayout, shownMessages]);
  const jumpRootId = jumpTargetId ? (threadsLayout?.rootOf.get(jumpTargetId) ?? null) : null;
  const transcriptJump = useMemo(
    () => (activeJump && jumpRootId ? { ...activeJump, messageId: jumpRootId, runId: null } : activeJump),
    [activeJump, jumpRootId]
  );
  const threadJumpDoneRef = useRef<number | null>(null);
  useEffect(() => {
    if (!activeJump || !jumpRootId || !jumpTargetId || threadJumpDoneRef.current === activeJump.nonce) return;
    threadJumpDoneRef.current = activeJump.nonce;
    openThreadOn(jumpRootId, { focusId: jumpTargetId });
  }, [activeJump, jumpRootId, jumpTargetId, openThreadOn]);
  // Reply, in Threads view, opens the message's thread (a reply to a reply
  // answers it there). A reply whose root isn't loaded quotes it as in Flow.
  const handleReply = useCallback(
    (ref: RoomReplyRef) => {
      const rootId = threadsLayout ? threadRootFor(threadsLayout, ref.id) : null;
      if (!rootId) {
        setReplyTo(ref);
        return;
      }
      openThreadOn(rootId, { replyTo: ref.id === rootId ? null : ref });
    },
    [threadsLayout, openThreadOn]
  );
  const threadShown = !!openRoot && !collapsed;
  // Beside a doc (or in a narrow Room) a thread takes the chat column's place: never a third column.
  const threadMode: 'beside' | 'replace' =
    split || (bodyWidth > 0 && bodyWidth < THREAD_BESIDE_MIN_PX) ? 'replace' : 'beside';

  const reducedMotion = useReducedMotion();
  // With the dock's pills out, the transcript keeps clear of them: all of their
  // width in a narrow Room, only as much as it takes in a wide one. A thread
  // beside the chat covers the panel and the dock, so then there's nothing to clear.
  const transcriptClearance =
    threadShown && threadMode === 'beside'
      ? 0
      : dockGutter > 0
        ? Math.min(dockGutter, Math.max(0, TRANSCRIPT_COLUMN_PX + 2 * dockGutter - bodyWidth))
        : panelClearance;

  // Split-resize perf round: `RoomTranscript` memoizes its own node list
  // against its props (its own `mapEntries`/render loop), which only pays
  // off when those props are referentially stable. These three used to be
  // freshly-created closures on every render — defeating that memo on
  // every window/split resize (each one re-renders this component via
  // `bodyWidth` above) even though nothing the transcript actually shows
  // had changed. `useCallback` keeps the same function identity across a
  // resize; the `source instanceof RelayRoomSource` gate stays at the
  // exposed-value level below so a fixture-mode Room still gets `undefined`
  // (same as before — `RoomTranscript` hides the button/pill without one).
  //
  // Only meaningful against the real relay — there's nothing running to
  // stop behind the scripted demo, so `RoomTranscript` never even offers
  // the button in that case (see its own `onStopSession` prop).
  const stopSession = useCallback(async (runId: string): Promise<boolean> => {
    const result = await rpc.rig.spacesDispatch.stopRun({ runId, bindingId }).catch(() => null);
    return result?.stopped === true;
  }, [bindingId]);
  const handleStopSession = source instanceof RelayRoomSource ? stopSession : undefined;

  const resolvePermission = useCallback((runId: string, requestId: string, optionId: string) => {
    void rpc.rig.spacesDispatch.resolvePermission({ runId, requestId, optionId });
  }, []);
  const handleResolvePermission = source instanceof RelayRoomSource ? resolvePermission : undefined;

  const hideDetails = useCallback(
    async (runId: string): Promise<boolean> => {
      const result = await rpc.rig.spacesDispatch.hideRunDetails({ bindingId, runId }).catch(() => null);
      return result?.success === true;
    },
    [bindingId]
  );
  const handleHideDetails = source instanceof RelayRoomSource ? hideDetails : undefined;
  // Scrollback: the relay source pages back; the scripted demo has none.
  const loadOlder = useCallback(() => {
    if (source instanceof RelayRoomSource) void source.loadOlder();
  }, [source]);
  const handleLoadOlder = source instanceof RelayRoomSource ? loadOlder : undefined;

  // A run shown from disk (its summary only): expanding its card fetches the log.
  const loadRunLog = useCallback(
    (runId: string) => {
      if (source instanceof RelayRoomSource) void source.loadRunLog(runId);
    },
    [source]
  );
  const handleLoadRunLog = source instanceof RelayRoomSource ? loadRunLog : undefined;

  // Shared by the transcript's connector pills (a `connectors_added` card,
  // an agent turn's footer gap) — the fuller add/consent/catalog flow lives
  // in the space panel's `ConnectorsSection` instead.
  const connectorConnect = useCallback(
    async (id: string) => {
      const result = await connectorsApi.connect(id as ConnectorId);
      if (source instanceof RelayRoomSource) await source.refreshConnections();
      return result;
    },
    [source]
  );
  const handleConnectorConnect = source instanceof RelayRoomSource ? connectorConnect : undefined;

  const rerun = useCallback(
    async (agent: AgentKind, prompt: string): Promise<boolean> => {
      if (!(source instanceof RelayRoomSource)) return false;
      const filed = await source.requestOwnAgent(agent, prompt).catch(() => false);
      if (filed) void rpc.rig.spacesDispatch.checkNow();
      return filed;
    },
    [source]
  );
  const handleRerun = source instanceof RelayRoomSource ? rerun : undefined;

  // While set up (and until the live Room has loaded): an empty Room under
  // the space's name stands in, so the layout and the composer are the same
  // elements before and after — nothing remounts when it goes live.
  const placeholder = useMemo(
    () => (awaitingLive && !liveLoaded ? emptySnapshot(spaceName, selfUserId) : null),
    [awaitingLive, liveLoaded, spaceName, selfUserId]
  );

  if (gone) {
    return (
      <div
        className="bg-bg-0 flex h-full min-h-0 flex-col items-center justify-center gap-3 text-sm text-text-muted"
        data-testid="room-gone"
      >
        <p>This space isn’t available to you anymore.</p>
      </div>
    );
  }

  if (connectError) {
    return (
      <div className="bg-bg-0 flex h-full min-h-0 flex-col items-center justify-center gap-3 text-sm text-text-muted">
        <p>Could not connect to the chat: {connectError}</p>
        <button
          type="button"
          onClick={() => setUseFixtures(true)}
          className="hover:bg-bg-2 rounded-control border border-border-hairline px-3 py-1.5 text-text-primary transition-colors"
        >
          Use the scripted demo instead
        </button>
      </div>
    );
  }

  const room = placeholder ?? snapshot;
  if (!room) {
    // Still asking who you are and where the relay is: the opening skeleton, not a blank pane.
    return (
      <div className="bg-bg-0 flex h-full min-h-0 flex-col" data-testid="room-view">
        {!collapsed && <RoomLoadingSkeleton />}
      </div>
    );
  }

  // Doc-focus round: the Room stays connected in doc focus (every hook
  // above keeps running) but draws only the slim left rail — see
  // `SpaceRail`'s own header comment for what replaced here (a floating
  // bottom-right chip that drew OVER the doc instead of living in the
  // column App.tsx already reserves for it).
  if (collapsed) {
    return <SpaceRail snapshot={room} selfUserId={selfUserId} onExpand={onExpandCollapsed} />;
  }

  // What a message in the Room needs to draw (links beside the chat, file cards, reactions).
  const withRoomContexts = (node: ReactNode) => (
    <OpenPageContext.Provider value={onOpenPage ?? null}>
      <AttachmentSpaceContext.Provider value={attachmentSpace}>
        <ReactionsContext.Provider value={reactionsApi}>
          <AskSuggestionContext.Provider value={askSuggestion}>{node}</AskSuggestionContext.Provider>
        </ReactionsContext.Provider>
      </AttachmentSpaceContext.Provider>
    </OpenPageContext.Provider>
  );
  const threadSnapshot = shownSnapshot ?? room;
  const threadPanel =
    threadShown && openRoot && openThread
      ? withRoomContexts(
          <ThreadPanel
            key={openRoot.id}
            root={openRoot}
            replies={openReplies}
            spaceName={room.name}
            mode={threadMode}
            onClose={closeThread}
            focus={openThread.focus}
            isContinuation={(prev, message) => isContinuation(prev, message, threadSnapshot)}
            renderMessage={(message, continued, onJumpTo) =>
              renderItem(
                message,
                threadSnapshot,
                selfUserId,
                handleStopSession,
                handleResolvePermission,
                handleOpenFile,
                continued,
                // Reply on the root is the thread's default; on a reply, it answers that one.
                live ? (ref) => setThreadReplyTo(ref.id === openRoot.id ? null : ref) : undefined,
                onJumpTo,
                handleRerun,
                handleConnectorConnect,
                globalSetup,
                handleHideDetails,
                handleLoadRunLog
              )
            }
            composer={
              <Composer
                prefill={threadPrefill}
                spaceName={room.name}
                draftKey={draftKey ? `${draftKey}:thread:${openRoot.id}` : undefined}
                placeholder="Reply in thread"
                autoFocus
                replyTo={threadReplyTo}
                onCancelReply={() => setThreadReplyTo(null)}
                busyAgents={busyOwnAgents(room, selfUserId)}
                openDoc={live ? openDoc : null}
                agentModels={lastModels(room, selfUserId)}
                members={room.members}
                people={mentionable}
                onInvitePerson={live ? invitePerson : undefined}
                agents={room.agents.filter((a) => a.owner === selfUserId)}
                availableAgents={availableAgents}
                onSetUpAgent={setSetUpAgent}
                skills={room.skills}
                onSend={(text, context) => {
                  setThreadReplyTo(null);
                  setAlsoInChannel(false);
                  handleSend(
                    text,
                    {
                      ...context,
                      replyTo: context.replyTo ?? replyRefFor(openRoot, threadSnapshot, selfUserId),
                      ...(alsoInChannel ? { alsoInChannel: true } : {}),
                    },
                    (unsent) => setThreadPrefill({ text: unsent, nonce: Date.now() })
                  );
                }}
                waitForConnection={roomConnection !== null || awaitingLive}
                listFiles={live ? listSpaceFiles : undefined}
                onTypingChange={
                  source instanceof RelayRoomSource ? (typing) => source.setTyping(typing) : undefined
                }
                footer={
                  <label
                    className="mt-2 flex w-fit cursor-pointer items-center gap-2 px-1 text-xs text-text-secondary select-none"
                    data-testid="thread-also-send"
                  >
                    <input
                      type="checkbox"
                      checked={alsoInChannel}
                      onChange={(e) => setAlsoInChannel(e.target.checked)}
                      className="size-3.5 accent-[var(--accent)]"
                    />
                    Also send to {room.name}
                  </label>
                }
              />
            }
          />
        )
      : null;

  return (
    <AgentSettingsContext.Provider value={agentSettingsApi}>
    <div ref={roomRootRef} className="bg-bg-0 relative flex h-full min-h-0 flex-col" data-testid="room-view">
      {/* Room chrome round: a real space (#name) is already named in the
          app's single top bar — this row used to repeat it. It survives
          only for the Room-preview overlay on a plain rig (`showDemoToggle`,
          same condition), where it's the dev-only demo toggle's home and
          there's no other bar in view. */}
      {showDemoToggle && (
        <div className="border-border-hairline bg-bg-1 flex h-9 shrink-0 items-center gap-2 border-b px-3">
          <span className="text-xs font-medium text-text-primary">{room.name}</span>
          <button
            type="button"
            onClick={() => setUseFixtures((v) => !v)}
            title={useFixtures ? 'Switch to the live space' : 'Switch to the scripted demo (dev)'}
            className="hover:bg-bg-2 ml-auto flex size-6 items-center justify-center rounded-control text-text-muted transition-colors"
          >
            <RadioTower className="size-3.5" strokeWidth={1.5} />
          </button>
          {useFixtures && (
            <button
              type="button"
              onClick={togglePlay}
              aria-label={playing ? 'Pause the scripted feed' : 'Play the scripted feed'}
              className="hover:bg-bg-2 flex size-6 items-center justify-center rounded-control text-text-muted transition-colors"
            >
              {playing ? (
                <Pause className="size-3.5" strokeWidth={1.5} />
              ) : (
                <Play className="size-3.5" strokeWidth={1.5} />
              )}
            </button>
          )}
        </div>
      )}

      <div ref={bodyRef} className="relative flex min-h-0 flex-1">
        {/* Wide: keep the transcript clear of the floating panel. Narrow:
            the panel starts as its chip instead of covering the messages. */}
        <motion.div
          className={cn('relative flex min-h-0 flex-1 flex-col', threadPanel && threadMode === 'replace' && 'hidden')}
          // The transcript's own room: clear of the panel, and of the dock's
          // pills once there are some (it slides over only when the dock changes).
          initial={false}
          animate={{ paddingRight: transcriptClearance }}
          transition={reducedMotion || !gutterMoving ? { duration: 0 } : { type: 'spring', stiffness: 320, damping: 34 }}
          onDragEnter={(e) => {
            if (!hasDraggedFiles(e.dataTransfer)) return;
            e.preventDefault();
            dragDepth.current += 1;
            setDragging(true);
          }}
          onDragOver={(e) => {
            if (!hasDraggedFiles(e.dataTransfer)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = composerAttachments.disabledReason ? 'none' : 'copy';
          }}
          onDragLeave={() => {
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragging(false);
          }}
          onDrop={(e) => {
            if (!hasDraggedFiles(e.dataTransfer)) return;
            e.preventDefault();
            dragDepth.current = 0;
            setDragging(false);
            if (composerAttachments.disabledReason) {
              toast({ title: 'Files can’t be added here', description: composerAttachments.disabledReason });
              return;
            }
            void attachments.addFiles(Array.from(e.dataTransfer.files));
          }}
        >
          {dragging && (
            <div
              // Opaque enough to cover the Room: a see-through tint let the
              // welcome's chips show through the label (worst in light mode).
              className="bg-bg-1/90 pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-[14px] border-[1.5px] border-dashed border-accent backdrop-blur-sm"
              data-testid="attachment-drop-overlay"
            >
              <span className="rounded-full bg-accent-subtle px-3 py-1.5 text-sm text-accent">
                {composerAttachments.disabledReason ?? 'Drop to attach to your message'}
              </span>
            </div>
          )}
          {/* Your own message the moment you send it counts: a new space's welcome never hides it while files copy. */}
          {awaitingLive ? (
            <SpaceSetupState
              spaceName={spaceName}
              failed={setup?.status === 'failed'}
              error={setup?.error ?? null}
              removable={setup?.removable ?? false}
              onRetry={() => setup?.onRetry()}
              onRemove={() => setup?.onRemove()}
            />
          ) : live && (shownSnapshot ?? room).messages.length === 0 ? (
            <RoomWelcome
              spaceName={room.name}
              // Until the first load is in, not until the socket is: an empty
              // space is known to be empty as soon as its messages come back.
              connecting={room.loaded === false}
              hasSkills={room.skills.length > 0}
              onPrefill={(text) => setPrefill({ text, nonce: Date.now() })}
            />
          ) : (
          withRoomContexts(
          <div className="relative flex min-h-0 flex-1 flex-col">
          {/* Under the search's results the chat stays as it was (scroll and all), only hidden. */}
          <div
            className={cn('flex min-h-0 flex-1 flex-col', searchActive && 'invisible')}
            aria-hidden={searchActive || undefined}
            inert={searchActive || undefined}
          >
          <RoomTranscript
            snapshot={transcriptSnapshot ?? room}
            ownId={selfUserId}
            onStopSession={handleStopSession}
            onResolvePermission={handleResolvePermission}
            onOpenFile={handleOpenFile}
            onReply={source instanceof RelayRoomSource ? handleReply : undefined}
            readKey={source instanceof RelayRoomSource ? bindingId : undefined}
            onRerun={handleRerun}
            onConnectorConnect={handleConnectorConnect}
            globalSetup={globalSetup}
            onHideDetails={handleHideDetails}
            onLoadRunLog={handleLoadRunLog}
            jump={transcriptJump}
            onJumpMissed={onJumpMissed}
            onLoadOlder={handleLoadOlder}
            focus={transcriptFocus}
            previewIds={dockPreview}
            topBar={topBar}
            threads={transcriptThreads}
            readThroughSeq={readThroughSeq}
          />
          </div>
          {searchSnapshot && searchView && (
            <div className="bg-bg-0 absolute inset-0 flex min-h-0 flex-col" data-testid="chat-search-results">
              <RoomTranscript
                // Each query starts at its newest match, at the bottom.
                key={chatSearch.searched}
                snapshot={searchSnapshot}
                ownId={selfUserId}
                onStopSession={handleStopSession}
                onResolvePermission={handleResolvePermission}
                onOpenFile={handleOpenFile}
                onRerun={handleRerun}
                onConnectorConnect={handleConnectorConnect}
                globalSetup={globalSetup}
                onHideDetails={handleHideDetails}
                onLoadRunLog={handleLoadRunLog}
                onLoadOlder={chatSearch.loadMore}
                search={searchView}
              />
            </div>
          )}
          <ChatSearchBar search={chatSearch} />
          </div>
          )
          )}
          <div className="mx-auto w-full max-w-[44rem] shrink-0 px-5 pb-4">
            {/* No live socket: the source polls instead, so nothing is
                broken, just a few seconds behind. A quiet note, not an alarm. */}
            {/* Files here go stale without a word when sync isn't running on this computer: say so. */}
            {live && <SyncHealthNotice path={spaceRoot} className="mb-1.5" />}
            {/* The space's own .mcp.json servers your agent here can't use until you allow them. */}
            {live && <ProjectServersNotice bindingId={bindingId} className="mb-1.5" />}
            {roomConnection && (
              <ConnectionBanner
                connection={roomConnection}
                retrying={reconnecting}
                onTryAgain={reconnectNow}
                className="mb-1.5"
              />
            )}
            {live && !roomConnection && room.connection === 'offline' && (
              <p
                className="mb-1.5 flex items-center gap-1.5 px-1 text-2xs text-text-muted"
                role="status"
                title="The live connection is down, so the chat checks for news every few seconds. Your agents keep working on this computer."
                data-testid="room-offline"
              >
                <span className="bg-border-strong size-1.5 shrink-0 rounded-full" />
                Updating a little slower than usual
              </p>
            )}
            {live && catchingUp && !roomConnection && room.connection !== 'offline' && (
              <p
                className="mb-1.5 flex items-center gap-1.5 px-1 text-2xs text-text-muted"
                role="status"
                data-testid="room-catching-up"
              >
                <span className="bg-border-strong size-1.5 shrink-0 rounded-full" />
                Catching up…
              </p>
            )}
            <Composer
              prefill={prefill}
              spaceName={room.name}
              draftKey={draftKey}
              replyTo={replyTo}
              onCancelReply={() => setReplyTo(null)}
              busyAgents={busyOwnAgents(room, selfUserId)}
              openDoc={live ? openDoc : null}
              agentModels={lastModels(room, selfUserId)}
              members={room.members}
              people={mentionable}
              onInvitePerson={live ? invitePerson : undefined}
              // Own agents only: @claude/@codex always means the sender's
              // own agent (no cross-person delegation in the MVP).
              agents={room.agents.filter((a) => a.owner === selfUserId)}
              skills={room.skills}
              onSend={(text, context) => {
                setReplyTo(null);
                // Threads view: what you send from the main column shows there,
                // even when it answers something (your agent's turn, a reply whose root isn't loaded).
                handleSend(text, threadsOn && context.replyTo ? { ...context, alsoInChannel: true } : context);
              }}
              waitForConnection={roomConnection !== null || awaitingLive}
              waitingNote={awaitingLive ? 'Sends once the space is ready.' : undefined}
              attachments={composerAttachments}
              listFiles={live ? listSpaceFiles : undefined}
              suggestReply={live ? suggestReply : undefined}
              availableAgents={availableAgents}
              onSetUpAgent={setSetUpAgent}
              onTypingChange={
                source instanceof RelayRoomSource ? (typing) => source.setTyping(typing) : undefined
              }
            />
          </div>
        </motion.div>
        {threadPanel}
        <AgentSetupDialog
          open={setUpAgent !== null}
          onOpenChange={(open) => !open && setSetUpAgent(null)}
          agent={setUpAgent ?? undefined}
        />
        {dockOn && shownSnapshot && (
          <ForYouFeeder
            bindingId={bindingId}
            snapshot={shownSnapshot}
            selfUserId={selfUserId}
            notifications={source instanceof FixtureRoomSource ? (demoNotifications ?? NO_DEMO_ROWS) : undefined}
            // The scripted demo answers in its own fixture: the request leaves, nothing real is called.
            resolvePermission={
              source instanceof FixtureRoomSource
                ? (runId, requestId, optionId) => source.resolvePermission(runId, requestId, optionId)
                : undefined
            }
            onState={setForYouState}
          />
        )}
        {awaitingLive && !(source instanceof RelayRoomSource) ? null : source instanceof RelayRoomSource ? (
          (renderPanel?.(
            <>
              <AgentRows
                snapshot={room}
                selfUserId={selfUserId}
                bindingId={bindingId}
                signInRow={(agent) => <AgentSignInRow agent={agent} />}
              />
              <ConnectorsSection
                snapshot={room}
                selfUserId={selfUserId}
                bindingId={bindingId}
                onOpenGallery={(focus) => {
                  setGallery({ open: true, focus: focus ?? null, initialScope: 'all', initialSection: null });
                  refreshGlobalSetup();
                }}
                onOpenGlobalSetup={() => {
                  setGallery({ open: true, focus: null, initialScope: 'installed', initialSection: 'global-setup' });
                  refreshGlobalSetup();
                }}
                globalSetup={globalSetup}
                onExpand={refreshGlobalSetup}
              />
            </>,
            // Presence comes over the realtime socket; without it (the Room
            // is polling) nobody's presence is known, so nobody is dimmed.
            new Set(
              room.members
                .filter((m) => room.connection !== 'online' || m.online !== false)
                .map((m) => m.id)
            ),
            {
              startCollapsed: narrow,
              chipSummary: ({ unseenCount }) => (
                <SpaceChipSummary snapshot={room} selfUserId={selfUserId} unseenCount={unseenCount} />
              ),
              collapsedDock: dockOn
                ? ({ onExpand, onFold, open, card }) => (
                    <ThemeDock
                      key={bindingId}
                      snapshot={shownSnapshot ?? room}
                      selfUserId={selfUserId}
                      forYouState={dockForYou}
                      focus={dockFocus}
                      narrow={narrow}
                      onExpand={onExpand}
                      card={{ open, content: card, onFold }}
                      onGutterChange={onDockGutter}
                      onPreviewChange={setDockPreview}
                      className="absolute top-[52px] right-4"
                    />
                  )
                : undefined,
            }
          ) ?? null)
        ) : dockOn ? (
          // The scripted demo has no pinned panel to open: the dock stands alone.
          <ThemeDock
            key={bindingId}
            snapshot={shownSnapshot ?? room}
            selfUserId={selfUserId}
            forYouState={dockForYou}
            focus={dockFocus}
            narrow={narrow}
            onGutterChange={onDockGutter}
            onPreviewChange={setDockPreview}
            className="absolute top-3 right-4"
          />
        ) : (
          <SpaceCard snapshot={room} bindingId={live ? bindingId : undefined} />
        )}
        {gallery.open && source instanceof RelayRoomSource && (
          <ConnectorGallery
            snapshot={room}
            selfUserId={selfUserId}
            source={source}
            onClose={() => setGallery({ open: false, focus: null, initialScope: 'all', initialSection: null })}
            // Beside the floating panel in a wide Room; over the Room when it's narrow.
            rightInset={narrow ? 12 : PANEL_LANE_PX + 4}
            globalSetup={globalSetup}
            focus={gallery.focus}
            initialScope={gallery.initialScope}
            initialSection={gallery.initialSection}
          />
        )}
      </div>
    </div>
    </AgentSettingsContext.Provider>
  );
}
