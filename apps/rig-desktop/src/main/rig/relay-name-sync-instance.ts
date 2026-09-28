import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { rigRenamedChannel } from '@shared/rig/workspace';
import { fetchWorkspaceBindings } from './account';
import { resolveLocalPathsImpl, updateRigName } from './recent-rigs';
import { createRelayNameSync } from './relay-name-sync';
import { setBindingName } from './spaces/relay-api';
import { readRigName } from './workspace';

/** The app's one relay-name sync (see `relay-name-sync.ts`), wired to the real relay, `rig_rigs`, and disk. */
export const relayNameSync = createRelayNameSync({
  patchName: setBindingName,
  listBindings: async () => {
    const result = await fetchWorkspaceBindings();
    return result.success ? result.data : null;
  },
  localPaths: resolveLocalPathsImpl,
  readLocal: async (path) => {
    const name = readRigName(path);
    if (name === null) return null;
    try {
      return { name, mtimeMs: (await stat(join(path, 'rig.toml'))).mtimeMs };
    } catch {
      return null;
    }
  },
  onPushed: (bindingId, name) => {
    // rig_rigs mirrors rig.toml for the rigs rail; a rename that arrived by sync hasn't reached it yet.
    void updateRigName(bindingId, name)
      .catch((error: unknown) => log.warn('rig: failed to mirror a synced rename', { bindingId, error: String(error) }))
      .then(() => events.emit(rigRenamedChannel, { bindingId, name }));
  },
});
