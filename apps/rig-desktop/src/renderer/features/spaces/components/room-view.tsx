import { AtSign, Hash, Pause, Play, RadioTower, Sparkles, UserPlus } from 'lucide-react';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { buildRoomFeed } from '../fixtures/room-feed';
import { RelayRoomSource, type RelayRoomClient } from '../relay-room-source';
import { FixtureRoomSource, type RoomSource } from '../room-source';
import { effectiveRunStatus, projectSessionCard } from '../projection';
import type { AgentKind, RoomReplyRef, RoomSnapshot } from '../types';
import { Composer } from './composer';
import { RoomTranscript } from './room-transcript';
import { AgentRows, SpaceChipSummary } from './agent-rows';
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
/** The transcript's centered column (44rem plus its side padding). */
const TRANSCRIPT_COLUMN_PX = 728;
/** The floating panel's lane at the right edge: its 304px plus a margin. */
const PANEL_LANE_PX = 320;

const FALLBACK_OWN_ID = 'bob'; // fixture-only identity; the relay source uses the signed-in user's real id

/** `@claude`/`@codex` in the text, only when the SENDER runs that agent in this room — per the lane-3 brief, a mention only ever creates an agent request targeting the sender, never a teammate's agent. */
function detectOwnAgentMention(
  text: string,
  selfUserId: string,
  agents: { agent: AgentKind; owner: string }[]
): AgentKind | null {
  const match = /@(claude|codex)\b/i.exec(text);
  if (!match) return null;
  const agent = match[1].toLowerCase() as AgentKind;
  const ownsIt = agents.some((a) => a.agent === agent && a.owner === selfUserId);
  return ownsIt ? agent : null;
}

/** A space with nothing in it yet: what it is, and three ways in. While the Room is still opening, just the matrix. */
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
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3" data-testid="room-opening">
        <DotMatrix state="starting" size="lg" />
        <span className="active-shimmer-muted text-sm text-text-secondary">Opening {spaceName}</span>
      </div>
    );
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
  renderPanel,
}: {
  bindingId: string;
  spaceName: string;
  /** Opens a space file (relative path) in the editor. */
  onOpenFile?: (relPath: string) => void;
  /** Renders the live space panel (the rig's pinned card), given the Room's own rows to add to it. */
  renderPanel?: (
    extraRows: ReactNode,
    onlineUserIds: ReadonlySet<string>,
    options: { startCollapsed: boolean; chipSummary: ReactNode }
  ) => ReactNode;
}) {
  const [useFixtures, setUseFixtures] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [source, setSource] = useState<RoomSource | null>(null);
  const [selfUserId, setSelfUserId] = useState(FALLBACK_OWN_ID);
  const [snapshot, setSnapshot] = useState(() => source?.getSnapshot() ?? null);
  const [playing, setPlaying] = useState(false);
  const [replyTo, setReplyTo] = useState<RoomReplyRef | null>(null);
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyWidth, setBodyWidth] = useState(0);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setBodyWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  });
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

  const handleSend = (text: string, replyTo?: RoomReplyRef) => {
    if (!(source instanceof RelayRoomSource) || !snapshot) return;
    setReplyTo(null);
    void source.send(text, replyTo).then((sourceMessageId) => {
      const mentioned = detectOwnAgentMention(text, selfUserId, snapshot.agents);
      if (!mentioned) return;
      // Wake this device's claim poller rather than waiting for its next tick.
      void source
        .requestOwnAgent(mentioned, text, sourceMessageId ?? undefined)
        .then(() => rpc.rig.spacesDispatch.checkNow());
    });
  };

  // Only meaningful against the real relay — there's nothing running to
  // stop behind the scripted demo, so `RoomTranscript` never even offers
  // the button in that case (see its own `onStopSession` prop).
  const handleStopSession =
    source instanceof RelayRoomSource
      ? (runId: string) => {
          void rpc.rig.spacesDispatch.stopRun({ runId, bindingId });
        }
      : undefined;
  const handleResolvePermission =
    source instanceof RelayRoomSource
      ? (runId: string, requestId: string, optionId: string) => {
          void rpc.rig.spacesDispatch.resolvePermission({ runId, requestId, optionId });
        }
      : undefined;

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

  return (
    <div className="bg-bg-0 relative flex h-full min-h-0 flex-col" data-testid="room-view">
      <div className="border-border-hairline bg-bg-1 flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-xs font-medium text-text-primary">{snapshot.name}</span>
        {showDemoToggle && (
        <button
          type="button"
          onClick={() => setUseFixtures((v) => !v)}
          title={useFixtures ? 'Switch to the live room' : 'Switch to the scripted demo (dev)'}
          className="hover:bg-bg-2 ml-auto flex size-6 items-center justify-center rounded-control text-text-muted transition-colors"
        >
          <RadioTower className="size-3.5" strokeWidth={1.5} />
        </button>
        )}
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
            onRerun={
              source instanceof RelayRoomSource
                ? (agent, prompt) => {
                    void source.requestOwnAgent(agent, prompt).then(() => rpc.rig.spacesDispatch.checkNow());
                  }
                : undefined
            }
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
            <AgentRows snapshot={snapshot} selfUserId={selfUserId} />,
            new Set(snapshot.members.filter((m) => m.online !== false).map((m) => m.id)),
            { startCollapsed: narrow, chipSummary: <SpaceChipSummary snapshot={snapshot} /> }
          ) ?? null)
        ) : (
          <SpaceCard snapshot={snapshot} />
        )}
      </div>
    </div>
  );
}
