import { Pause, Play, RadioTower } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { buildRoomFeed } from '../fixtures/room-feed';
import { RelayRoomSource, type RelayRoomClient } from '../relay-room-source';
import { FixtureRoomSource, type RoomSource } from '../room-source';
import type { AgentKind } from '../types';
import { Composer } from './composer';
import { RoomTranscript } from './room-transcript';
import { AgentRows } from './agent-rows';
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
  renderPanel?: (extraRows: ReactNode, onlineUserIds: ReadonlySet<string>) => ReactNode;
}) {
  const [useFixtures, setUseFixtures] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [source, setSource] = useState<RoomSource | null>(null);
  const [selfUserId, setSelfUserId] = useState(FALLBACK_OWN_ID);
  const [snapshot, setSnapshot] = useState(() => source?.getSnapshot() ?? null);
  const [playing, setPlaying] = useState(false);
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

  const handleSend = (text: string) => {
    if (!(source instanceof RelayRoomSource) || !snapshot) return;
    void source.send(text).then((sourceMessageId) => {
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
          void rpc.rig.spacesDispatch.stopRun({ runId });
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

      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-h-0 flex-1 flex-col">
          <RoomTranscript
            snapshot={snapshot}
            ownId={selfUserId}
            onStopSession={handleStopSession}
            onResolvePermission={handleResolvePermission}
            onOpenFile={onOpenFile}
          />
          <div className="mx-auto w-full max-w-[44rem] shrink-0 px-5 pb-4">
            <Composer
              spaceName={snapshot.name}
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
            new Set(snapshot.members.filter((m) => m.online !== false).map((m) => m.id))
          ) ?? null)
        ) : (
          <SpaceCard snapshot={snapshot} />
        )}
      </div>
    </div>
  );
}
