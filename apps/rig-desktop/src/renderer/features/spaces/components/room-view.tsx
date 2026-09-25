import { AtSign, Hash, Pause, Play, RadioTower, Sparkles, UserPlus } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { cn } from '@renderer/lib/utils';
import type { ConnectorId, GlobalServer } from '@shared/spaces/connectors';
import { connectorsApi } from '../connectors-api';
import { buildRoomFeed } from '../fixtures/room-feed';
import { RelayRoomSource, type RelayRoomClient } from '../relay-room-source';
import { FixtureRoomSource, type RoomSource } from '../room-source';
import { effectiveRunStatus, projectSessionCard } from '../projection';
import type { AgentKind, RoomReplyRef, RoomSnapshot } from '../types';
import { Composer, type ComposerSendContext } from './composer';
import { RoomTranscript } from './room-transcript';
import { AgentRows, SpaceChipSummary } from './agent-rows';
import { SpaceRail } from './space-rail';
import { AgentSettingsContext, type AgentSettingsApi } from './agent-settings';
import { ConnectorGallery } from './connector-gallery';
import { ConnectorsSection } from './connectors-panel';
import { SpaceCard } from './space-card';

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
    getSessionEvents: (bindingId, runId, after) => client.getSessionEvents({ bindingId, runId, after }),
    postMessage: (bindingId, input) => client.postMessage({ bindingId, ...input }),
    requestOwnAgent: (bindingId, input) => client.requestOwnAgent({ bindingId, ...input }),
    listConnectors: (bindingId) => client.listConnectors({ bindingId }),
    addConnector: (bindingId, connectorId) => client.addConnector({ bindingId, connectorId }),
    removeConnector: (bindingId, connectorId) => client.removeConnector({ bindingId, connectorId }),
  };
}

/**
 * Spaces: the Room view, mounted only when `spacesEnabled` is on (see
 * `shell/settings-modal.tsx`'s Experimental section and the topbar's "Room
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
        <p className="text-sm text-text-secondary">A room for you, your team and your agents.</p>
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
    const model = projectSessionCard(snapshot.sessionEventsByRun[meta.id] ?? []).model;
    if (model) models[meta.agent] = model;
  }
  return models;
}

/** The viewer's own agents that are mid-turn, so the composer can say a new @mention will queue. */
function busyOwnAgents(snapshot: RoomSnapshot, selfUserId: string): AgentKind[] {
  const busy = new Set<AgentKind>();
  for (const meta of Object.values(snapshot.sessionMetaByRun)) {
    if (meta.owner !== selfUserId) continue;
    const status = effectiveRunStatus(meta.status, projectSessionCard(snapshot.sessionEventsByRun[meta.id] ?? []));
    if (status === 'running') busy.add(meta.agent);
  }
  return [...busy];
}

export function RoomView({
  bindingId,
  spaceName,
  onOpenFile,
  openDoc = null,
  renderPanel,
  collapsed = false,
  onExpand: onExpandCollapsed,
}: {
  bindingId: string;
  spaceName: string;
  /** Opens a space file (relative path) in the editor. */
  onOpenFile?: (relPath: string) => void;
  /** The doc open beside the Room (its path in the space), if any. */
  openDoc?: string | null;
  /** Renders the live space panel (the rig's pinned card), given the Room's own rows to add to it. */
  renderPanel?: (
    extraRows: ReactNode,
    onlineUserIds: ReadonlySet<string>,
    options: { startCollapsed: boolean; chipSummary: (ctx: { unseenCount: number }) => ReactNode }
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
}) {
  const [useFixtures, setUseFixtures] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [source, setSource] = useState<RoomSource | null>(null);
  const [selfUserId, setSelfUserId] = useState(FALLBACK_OWN_ID);
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
  // The body only exists once the Room has a snapshot (and isn't folded into
  // the doc-focus rail), so it's tracked as state: the observer attaches when
  // the element appears, not at mount — a mount-time `[]` effect missed it
  // and left `bodyWidth` at 0, which shoved the transcript left.
  const [bodyEl, bodyRef] = useState<HTMLDivElement | null>(null);
  const [bodyWidth, setBodyWidth] = useState(0);
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
  // The panel floats over the Room. The centered transcript only moves left
  // by as much as it takes to clear it, and not at all in a wide window.
  const panelClearance =
    hasPanel && !narrow ? Math.max(0, TRANSCRIPT_COLUMN_PX + 2 * PANEL_LANE_PX - bodyWidth) : 0;
  // The scripted-demo switch is a dev tool for the Room preview on plain
  // rigs; a real space (#name) never shows it.
  const showDemoToggle = !spaceName.startsWith('#');

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

  useEffect(() => {
    let cancelled = false;
    setConnectError(null);
    setSource(null);

    if (useFixtures) {
      const fixtureSource = new FixtureRoomSource(buildRoomFeed());
      setSource(fixtureSource);
      setSelfUserId(FALLBACK_OWN_ID);
      return () => fixtureSource.dispose();
    }

    let relaySource: RelayRoomSource | null = null;
    void rpc.rig.spacesConnection.getConnectionInfo().then((result) => {
      if (cancelled) return;
      if (!result.success) {
        setConnectError(result.error.message);
        return;
      }
      relaySource = new RelayRoomSource({
        bindingId,
        spaceName,
        wsUrl: result.data.wsUrl,
        selfUserId: result.data.selfUserId,
        relay: createRelayRoomClient(),
        connections: connectorsApi,
      });
      setSelfUserId(result.data.selfUserId);
      setSource(relaySource);
    });

    return () => {
      cancelled = true;
      relaySource?.dispose();
    };
  }, [useFixtures, bindingId, spaceName]);

  useEffect(() => {
    if (!source) return;
    setSnapshot(source.getSnapshot());
    const unsubscribe = source.subscribe((_event, next) => setSnapshot(next));
    source.play();
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
      const card = projectSessionCard(snapshot.sessionEventsByRun[meta.id] ?? []);
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

  // Every hook sits above the early returns below: React needs the same
  // hooks in the same order on every render.
  const configCache = useRef(new Map<AgentKind, ReturnType<AgentSettingsApi['load']>>());
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
          }
        : null,
    [source, bindingId]
  );

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

  const handleSend = (text: string, { replyTo, agent, attach }: ComposerSendContext) => {
    if (!(source instanceof RelayRoomSource) || !snapshot) return;
    setReplyTo(null);
    void source.send(text, replyTo).then((sourceMessageId) => {
      // The composer's pill decides: your agent when you tagged it and kept
      // the pill, plain chat when you dropped it.
      if (!agent || !snapshot.agents.some((a) => a.agent === agent && a.owner === selfUserId)) return;
      const prompt = attach ? `${text}\n\n(Open beside the Room: ${attach})` : text;
      // Wake this device's claim poller rather than waiting for its next tick.
      void source
        .requestOwnAgent(agent, prompt, sourceMessageId ?? undefined)
        .then(() => rpc.rig.spacesDispatch.checkNow());
    });
  };

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
    (agent: AgentKind, prompt: string) => {
      if (!(source instanceof RelayRoomSource)) return;
      void source.requestOwnAgent(agent, prompt).then(() => rpc.rig.spacesDispatch.checkNow());
    },
    [source]
  );
  const handleRerun = source instanceof RelayRoomSource ? rerun : undefined;

  if (connectError) {
    return (
      <div className="bg-bg-0 flex h-full min-h-0 flex-col items-center justify-center gap-3 text-sm text-text-muted">
        <p>Could not connect to the room: {connectError}</p>
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

  if (!snapshot) {
    return <div className="bg-bg-0 flex h-full min-h-0 flex-col" data-testid="room-view" />;
  }

  // Doc-focus round: the Room stays connected in doc focus (every hook
  // above keeps running) but draws only the slim left rail — see
  // `SpaceRail`'s own header comment for what replaced here (a floating
  // bottom-right chip that drew OVER the doc instead of living in the
  // column App.tsx already reserves for it).
  if (collapsed) {
    return <SpaceRail snapshot={snapshot} onExpand={onExpandCollapsed} />;
  }

  return (
    <AgentSettingsContext.Provider value={agentSettingsApi}>
    <div className="bg-bg-0 relative flex h-full min-h-0 flex-col" data-testid="room-view">
      {/* Room chrome round: a real space (#name) is already named in the
          app's single top bar — this row used to repeat it. It survives
          only for the Room-preview overlay on a plain rig (`showDemoToggle`,
          same condition), where it's the dev-only demo toggle's home and
          there's no other bar in view. */}
      {showDemoToggle && (
        <div className="border-border-hairline bg-bg-1 flex h-9 shrink-0 items-center gap-2 border-b px-3">
          <span className="text-xs font-medium text-text-primary">{snapshot.name}</span>
          <button
            type="button"
            onClick={() => setUseFixtures((v) => !v)}
            title={useFixtures ? 'Switch to the live room' : 'Switch to the scripted demo (dev)'}
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
        <div className="flex min-h-0 flex-1 flex-col" style={{ paddingRight: panelClearance }}>
          {live && snapshot.messages.length === 0 ? (
            <RoomWelcome
              spaceName={snapshot.name}
              connecting={snapshot.connection === 'connecting'}
              hasSkills={snapshot.skills.length > 0}
              onPrefill={(text) => setPrefill({ text, nonce: Date.now() })}
            />
          ) : (
          <RoomTranscript
            snapshot={snapshot}
            ownId={selfUserId}
            onStopSession={handleStopSession}
            onResolvePermission={handleResolvePermission}
            onOpenFile={onOpenFile}
            onReply={source instanceof RelayRoomSource ? setReplyTo : undefined}
            readKey={source instanceof RelayRoomSource ? bindingId : undefined}
            onRerun={handleRerun}
            onConnectorConnect={handleConnectorConnect}
            globalSetup={globalSetup}
          />
          )}
          <div className="mx-auto w-full max-w-[44rem] shrink-0 px-5 pb-4">
            {live && snapshot.connection === 'offline' && (
              <div
                className="border-border-hairline bg-bg-1 mb-2 flex items-center gap-2 rounded-card border px-3 py-2 text-xs text-text-secondary"
                role="status"
                data-testid="room-offline"
              >
                <span className="size-1.5 shrink-0 rounded-full bg-warning" />
                Lost the live connection to the room, reconnecting. Your agents keep working on this computer.
              </div>
            )}
            <Composer
              prefill={prefill}
              spaceName={snapshot.name}
              draftKey={bindingId}
              replyTo={replyTo}
              onCancelReply={() => setReplyTo(null)}
              busyAgents={busyOwnAgents(snapshot, selfUserId)}
              openDoc={live ? openDoc : null}
              agentModels={lastModels(snapshot, selfUserId)}
              members={snapshot.members}
              // Own agents only: @claude/@codex always means the sender's
              // own agent (no cross-person delegation in the MVP).
              agents={snapshot.agents.filter((a) => a.owner === selfUserId)}
              skills={snapshot.skills}
              onSend={handleSend}
              onTypingChange={
                source instanceof RelayRoomSource ? (typing) => source.setTyping(typing) : undefined
              }
            />
          </div>
        </div>
        {source instanceof RelayRoomSource ? (
          (renderPanel?.(
            <>
              <AgentRows snapshot={snapshot} selfUserId={selfUserId} bindingId={bindingId} />
              <ConnectorsSection
                snapshot={snapshot}
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
            new Set(snapshot.members.filter((m) => m.online !== false).map((m) => m.id)),
            {
              startCollapsed: narrow,
              chipSummary: ({ unseenCount }) => (
                <SpaceChipSummary snapshot={snapshot} selfUserId={selfUserId} unseenCount={unseenCount} />
              ),
            }
          ) ?? null)
        ) : (
          <SpaceCard snapshot={snapshot} />
        )}
        {gallery.open && source instanceof RelayRoomSource && (
          <ConnectorGallery
            snapshot={snapshot}
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
