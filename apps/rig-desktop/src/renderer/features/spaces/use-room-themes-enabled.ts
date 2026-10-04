import { useEffect, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { rigSettingsChangedChannel } from '@shared/rig/settings';

/**
 * Room themes flag (`roomThemesEnabled`, Settings › Advanced) — a live
 * read, like `useSpacesEnabled`: the saved value, then every change. It
 * sits inside the Room, so a settings read that fails leaves it off rather
 * than taking the Room down with it.
 */
export function useRoomThemesEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let alive = true;
    try {
      void rpc.rig.settings
        .get()
        .then((current) => {
          if (alive) setEnabled(current.roomThemesEnabled === true);
        })
        .catch(() => {});
    } catch {
      // No settings to read: themes stay off.
    }
    const off = events.on(rigSettingsChangedChannel, (next) => {
      setEnabled(next.roomThemesEnabled === true);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  return enabled;
}
