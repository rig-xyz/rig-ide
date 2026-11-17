import { useEffect, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { rigSpaceStateChannel, type SpaceState } from '@shared/rig/space-state';

/**
 * What this Mac's Rig knows about the space's standing work and turns (spike, Rig Alpha): asked
 * for on mount and whenever `refreshKey` changes (so a view or schedule that just appeared is
 * looked at at once), then kept current by main's pushes. Null until the first answer.
 */
export function useSpaceState(bindingId: string, refreshKey: string): SpaceState | null {
  const [state, setState] = useState<SpaceState | null>(null);
  useEffect(() => {
    let current = true;
    void rpc.rig.spaceState
      .get({ bindingId })
      .then((answer) => {
        if (current) setState(answer);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [bindingId, refreshKey]);
  useEffect(
    () =>
      events.on(rigSpaceStateChannel, (next) => {
        if (next.bindingId === bindingId) setState(next);
      }),
    [bindingId]
  );
  // An answer for an older space is never shown for this one.
  return state && state.bindingId === bindingId ? state : null;
}
