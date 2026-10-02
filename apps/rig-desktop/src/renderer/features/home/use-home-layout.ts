import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import {
  applyHomeLayoutAction,
  DEFAULT_HOME_LAYOUT,
  rigHomeLayoutChangedChannel,
  type HomeLayout,
  type HomeLayoutAction,
} from '@shared/rig/home-layout';

export const HOME_LAYOUT_KEY = ['rig', 'homeLayout'];

/** Edits sent to main and not answered yet: main's answer to an older one would undo a newer one on screen. */
let inFlight = 0;

/**
 * Home's Spaces card layout (`@shared/rig/home-layout`). Main holds it
 * (cached on disk, saved to the account in the background); an edit shows
 * here at once and main's answer, or a newer copy from the relay, replaces
 * it. The defaults until main answers, and if it can't.
 */
export function useHomeLayout(): {
  layout: HomeLayout;
  dispatch: (action: HomeLayoutAction) => void;
} {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: HOME_LAYOUT_KEY,
    queryFn: () => rpc.rig.homeLayout.get(),
    // Asking again (Home reopened, the window refocused) also has main check
    // the relay for a copy saved on another computer.
    staleTime: 30_000,
    retry: false,
  });

  useEffect(
    () =>
      events.on(rigHomeLayoutChangedChannel, ({ layout }) => {
        queryClient.setQueryData(HOME_LAYOUT_KEY, layout);
      }),
    [queryClient]
  );

  const dispatch = useCallback(
    (action: HomeLayoutAction) => {
      const current = queryClient.getQueryData<HomeLayout>(HOME_LAYOUT_KEY) ?? DEFAULT_HOME_LAYOUT;
      queryClient.setQueryData(HOME_LAYOUT_KEY, applyHomeLayoutAction(current, action));
      inFlight += 1;
      void Promise.resolve()
        .then(() => rpc.rig.homeLayout.apply({ action }))
        .then(
          (layout) => {
            inFlight -= 1;
            if (layout && inFlight === 0) queryClient.setQueryData(HOME_LAYOUT_KEY, layout);
          },
          () => {
            inFlight -= 1;
          }
        );
    },
    [queryClient]
  );

  return { layout: data ?? DEFAULT_HOME_LAYOUT, dispatch };
}
