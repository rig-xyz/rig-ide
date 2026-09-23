import { Pause, Play } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { buildRoomFeed } from '../fixtures/room-feed';
import { FixtureRoomSource } from '../room-source';
import { Composer } from './composer';
import { RoomTranscript } from './room-transcript';
import { SpaceCard } from './space-card';

/**
 * Spaces (lane 2): the Room view, mounted only when `spacesEnabled` is on
 * (see `shell/settings-modal.tsx`'s Experimental section and wherever this
 * gets a "Room (preview)" entry point). Owns exactly one `FixtureRoomSource`
 * for its lifetime, replays it, and re-renders on every event. Play/pause
 * here is a dev affordance for watching the scripted feed unfold — nothing
 * a real Room would ship with once lane 3's `RelayRoomSource` lands (a live
 * room is always "playing").
 */

const OWN_ID = 'bob';

export function RoomView() {
  const source = useMemo(() => new FixtureRoomSource(buildRoomFeed()), []);
  const [snapshot, setSnapshot] = useState(() => source.getSnapshot());
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    // `dispose()` below clears every listener along with the replay timer,
    // so there's no separate unsubscribe to keep hold of here.
    source.subscribe((_event, next) => setSnapshot(next));
    source.play();
    setPlaying(true);
    return () => {
      source.dispose();
    };
    // `source` is stable for this component's lifetime (created once via useMemo).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const togglePlay = () => {
    if (source.isDone()) return;
    if (source.isPlaying()) {
      source.pause();
      setPlaying(false);
    } else {
      source.play();
      setPlaying(true);
    }
  };

  return (
    <div className="bg-bg-0 relative flex h-full min-h-0 flex-col" data-testid="room-view">
      <div className="border-border-hairline bg-bg-1 flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-xs font-medium text-text-primary">{snapshot.name}</span>
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? 'Pause the scripted feed' : 'Play the scripted feed'}
          className="hover:bg-bg-2 ml-auto flex size-6 items-center justify-center rounded-control text-text-muted transition-colors"
        >
          {playing ? (
            <Pause className="size-3.5" strokeWidth={1.5} />
          ) : (
            <Play className="size-3.5" strokeWidth={1.5} />
          )}
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-h-0 flex-1 flex-col">
          <RoomTranscript snapshot={snapshot} ownId={OWN_ID} />
          <div className="mx-auto w-full max-w-[44rem] shrink-0 px-5 pb-4">
            <Composer
              spaceName={snapshot.name}
              members={snapshot.members}
              agents={snapshot.agents}
              skills={snapshot.skills}
              onSend={() => {
                // Lane 2 replays a scripted feed; there's no relay to persist
                // an outgoing message to yet. Lane 3's RelayRoomSource should
                // give RoomView a real `send`, at which point this becomes a
                // simple pass-through instead of a no-op.
              }}
            />
          </div>
        </div>
        <SpaceCard snapshot={snapshot} />
      </div>
    </div>
  );
}
