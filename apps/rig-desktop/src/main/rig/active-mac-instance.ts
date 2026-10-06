import { powerMonitor } from 'electron';
import { ACTIVE_MAC_INTERVAL_MS, createActiveMacTracker } from './active-mac';
import { createHttpSpacesRelayApi } from './spaces/relay-api';
import { thisMacId } from './this-mac';

const relayApi = createHttpSpacesRelayApi();

export const activeMac = createActiveMacTracker({
  device: thisMacId,
  idleSeconds: () => powerMonitor.getSystemIdleTime(),
  activeComputer: (markActive) => relayApi.activeComputer!(markActive),
});

/** Keeps the relay told when this Mac is in use: on a timer, and right away on wake or unlock. */
export function wireActiveMac(): void {
  setInterval(() => void activeMac.tick(), ACTIVE_MAC_INTERVAL_MS);
  powerMonitor.on('resume', () => void activeMac.tick(true));
  powerMonitor.on('unlock-screen', () => void activeMac.tick(true));
  void activeMac.tick(true);
}
