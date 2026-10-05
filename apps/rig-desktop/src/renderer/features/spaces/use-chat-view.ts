import { useEffect, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { rigSettingsChangedChannel, type SpacesChatView } from '@shared/rig/settings';

/**
 * Settings › Spaces › Chat view (`spacesChatView`), read live like
 * `useRoomThemesEnabled`: the saved value, then every change. A settings
 * read that fails leaves the Room in Flow rather than taking it down.
 */
export function useSpacesChatView(): SpacesChatView {
  const [view, setView] = useState<SpacesChatView>('flow');

  useEffect(() => {
    let alive = true;
    try {
      void rpc.rig.settings
        .get()
        .then((current) => {
          if (alive) setView(current.spacesChatView === 'threads' ? 'threads' : 'flow');
        })
        .catch(() => {});
    } catch {
      // No settings to read: Flow.
    }
    const off = events.on(rigSettingsChangedChannel, (next) => {
      setView(next.spacesChatView === 'threads' ? 'threads' : 'flow');
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  return view;
}
