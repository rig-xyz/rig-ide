import { execFile } from 'node:child_process';
import { shell } from 'electron';
import { resolveLocalAcpSpawnContext } from '@main/core/acp/transport/local-acp-process-host';
import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { isConnectorId, type ConnectResult, type GlobalServer } from '@shared/spaces/connectors';
import { getCurrentAccountId } from '../account';
import { createConnections } from './connections';
import { createGlobalSetup } from './global-setup';

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

/**
 * Your agents' own global MCP setup, read through each agent's own CLI with
 * the exact binary and environment rig launches it with.
 */
export const globalSetup = createGlobalSetup({
  run: async (agent, args, cwd) => {
    const { cli, agentEnv } = await resolveLocalAcpSpawnContext(agent);
    return new Promise<string>((resolve, reject) => {
      execFile(
        cli,
        args,
        { cwd, env: { ...process.env, ...agentEnv }, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => (error ? reject(error) : resolve(stdout))
      );
    });
  },
});

/** The folder a space is open in on this device (project-scoped agent servers count), if any. */
async function spaceFolder(bindingId: string | undefined): Promise<string | undefined> {
  if (!bindingId) return undefined;
  // Lazy: the rigs table module opens the app database at load.
  const { resolveLocalPathsImpl } = await import('../recent-rigs');
  return (await resolveLocalPathsImpl([bindingId]))[bindingId] ?? undefined;
}

export async function globalSetupFor(bindingId: string | undefined): Promise<GlobalServer[]> {
  return globalSetup.list(await spaceFolder(bindingId));
}

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
  /** What your agents bring from their own setup (names and URLs only; no credentials are ever read). */
  globalSetup: ({ bindingId }: { bindingId?: string }): Promise<GlobalServer[]> => globalSetupFor(bindingId),
});
