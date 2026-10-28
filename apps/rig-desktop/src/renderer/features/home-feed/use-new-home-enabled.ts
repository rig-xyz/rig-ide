import { useEffect, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { rigSettingsChangedChannel, type RigSettings } from '@shared/rig/settings';

/**
 * One settings flag, live: the saved value, then every change, like
 * `useRoomThemesEnabled`. A settings read that fails leaves it off, so the
 * current release keeps working.
 */
function useSettingsFlag(read: (settings: RigSettings) => boolean): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let alive = true;
    try {
      void rpc.rig.settings
        .get()
        .then((current) => {
          if (alive) setEnabled(read(current));
        })
        .catch(() => {});
    } catch {
      // No settings to read: it stays off.
    }
    const off = events.on(rigSettingsChangedChannel, (next) => {
      setEnabled(read(next));
    });
    return () => {
      alive = false;
      off();
    };
    // `read` is a plain accessor; the flag it reads never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return enabled;
}

/**
 * Rig Alpha (`alphaEnabled`, Settings › Advanced): the new Home, the first run and the background
 * reads. For Settings; App reads it with the rest of its first screen's settings, in one go.
 */
export function useAlphaEnabled(): boolean {
  return useSettingsFlag((s) => s.alphaEnabled === true);
}
