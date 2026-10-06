import { app, BrowserWindow } from 'electron';
import { ACTIVE_MAC_INTERVAL_MS, createActiveMacTracker } from './active-mac';
import { createHttpSpacesRelayApi } from './spaces/relay-api';
import { thisMacId } from './this-mac';

const relayApi = createHttpSpacesRelayApi();

export const activeMac = createActiveMacTracker({
  device: thisMacId,
  rigInFront: () => BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused()),
  activeComputer: (markActive) => relayApi.activeComputer!(markActive),
});

/** Brought forward settles a burst of window switches into one call. */
const FOCUS_SETTLE_MS = 2_000;

/** Keeps the relay told when you use Rig on this Mac: when a Rig window comes to the front, and on a slow timer. */
export function wireActiveMac(): void {
  let settle: ReturnType<typeof setTimeout> | null = null;
  app.on('browser-window-focus', () => {
    if (settle) clearTimeout(settle);
    settle = setTimeout(() => {
      settle = null;
      void activeMac.tick();
    }, FOCUS_SETTLE_MS);
  });
  setInterval(() => void activeMac.tick(), ACTIVE_MAC_INTERVAL_MS);
  void activeMac.tick();
}
