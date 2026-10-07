import { useEffect, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { rigSettingsChangedChannel } from '@shared/rig/settings';

/**
 * Settings › Spaces › Show plain rigs, read live like `useSpacesEnabled`:
 * flipping it shows or hides Home's Rigs card at once.
 */
export function useShowPlainRigs(): boolean {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    let alive = true;
    void rpc.rig.settings.get().then((current) => {
      if (alive) setShown(current.showPlainRigs);
    });
    const off = events.on(rigSettingsChangedChannel, (next) => {
      setShown(next.showPlainRigs);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  return shown;
}
