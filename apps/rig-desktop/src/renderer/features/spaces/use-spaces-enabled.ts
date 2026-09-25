import { useEffect, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { rigSettingsChangedChannel } from '@shared/rig/settings';

/**
 * Spaces (lane 2) feature-flag gate — same live-read pattern as
 * `docs/paintbrush/use-paintbrush.ts`'s read of `smartHighlighterEnabled`:
 * an initial `rpc.rig.settings.get()` plus a live subscription over
 * `rigSettingsChangedChannel`, so flipping the Experimental toggle shows or
 * hides the "Room (preview)" entry point immediately, no restart.
 */
export function useSpacesEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let alive = true;
    void rpc.rig.settings.get().then((current) => {
      if (alive) setEnabled(current.spacesEnabled);
    });
    const off = events.on(rigSettingsChangedChannel, (next) => {
      setEnabled(next.spacesEnabled);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  return enabled;
}
