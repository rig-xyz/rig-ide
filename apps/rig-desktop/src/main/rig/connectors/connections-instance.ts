import { shell } from 'electron';
import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { isConnectorId, type ConnectResult } from '@shared/spaces/connectors';
import { getCurrentAccountId } from '../account';
import { createConnections } from './connections';

/**
 * Boot-only wiring for your connector logins: the real encrypted secret
 * store, the signed-in rig account, the system browser. Kept out of
 * `connections.ts` so that module stays testable in the node project.
 */
export const connections = createConnections({
  secrets: encryptedAppSecretsStore,
  accountId: async () => {
    const account = await getCurrentAccountId();
    return account.status === 'known' ? account.id : null;
  },
  openBrowser: (url) => shell.openExternal(url),
});

/** The renderer's view: states only, never a token. */
export const rigConnectorsController = createRPCController({
  list: () => connections.list(),
  connect: ({ id }: { id: string }): Promise<ConnectResult> =>
    isConnectorId(id) ? connections.connect(id) : Promise.resolve({ ok: false, reason: 'failed', message: 'Unknown tool.' }),
  cancel: ({ id }: { id: string }): void => {
    if (isConnectorId(id)) connections.cancel(id);
  },
  disconnect: async ({ id }: { id: string }): Promise<void> => {
    if (isConnectorId(id)) await connections.disconnect(id);
  },
});
