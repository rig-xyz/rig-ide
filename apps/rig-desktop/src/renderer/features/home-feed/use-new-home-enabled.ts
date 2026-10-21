import { useEffect, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { rigSettingsChangedChannel } from '@shared/rig/settings';

/**
 * The new Home flag (`newHomeEnabled`, Settings › Advanced): the saved value,
 * then every change, like `useRoomThemesEnabled`. A settings read that fails
 * leaves it off, so the current Home keeps working.
 */
export function useNewHomeEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let alive = true;
    try {
      void rpc.rig.settings
        .get()
        .then((current) => {
          if (alive) setEnabled(current.newHomeEnabled === true);
        })
        .catch(() => {});
    } catch {
      // No settings to read: the current Home stays.
    }
    const off = events.on(rigSettingsChangedChannel, (next) => {
      setEnabled(next.newHomeEnabled === true);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  return enabled;
}
