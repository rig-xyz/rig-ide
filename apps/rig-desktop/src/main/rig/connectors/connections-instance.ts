import { execFile } from 'node:child_process';
import { shell } from 'electron';
import { resolveLocalAcpSpawnContext } from '@main/core/acp/transport/local-acp-process-host';
import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { isConnectorId, type ConnectResult, type GlobalServer, type ProjectServerNotice } from '@shared/spaces/connectors';
import { getCurrentAccountId } from '../account';
import { createConnections } from './connections';
import { createGlobalSetup } from './global-setup';
import {
  allowProjectServer,
  readCodexProjectServers,
  readProjectServersPlan,
  type CodexProjectServers,
  type ProjectServersPlan,
} from './project-servers';

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

/**
 * Which of the space folder's own `.mcp.json` servers your Claude session
 * there gets (see project-servers.ts). Null when the space isn't open on
 * this device or the folder can't be read.
 */
export async function projectServersFor(bindingId: string | undefined): Promise<ProjectServersPlan | null> {
  const cwd = await spaceFolder(bindingId);
  if (!cwd) return null;
  try {
    return await readProjectServersPlan(cwd, () => globalSetup.claudeEntries(cwd));
  } catch (error) {
    log.warn('Rig connectors: could not read the space’s own MCP servers', { bindingId, error: String(error) });
    return null;
  }
}

/**
 * The space folder's own `.mcp.json` servers your Codex session there gets,
 * through the same Allow as Claude's (see project-servers.ts). `own` is what
 * rig already hands that session; Codex's own global servers are added here.
 * Null when the space isn't open on this device or the folder can't be read.
 */
export async function codexProjectServersFor(
  bindingId: string,
  own: ReadonlyArray<{ name: string; url: string | null }>
): Promise<CodexProjectServers | null> {
  const cwd = await spaceFolder(bindingId);
  if (!cwd) return null;
  try {
    const plan = await readCodexProjectServers(cwd, {
      claudeEntries: () => globalSetup.claudeEntries(cwd),
      own: async () => [...own, ...(await globalSetup.list(cwd)).filter((s) => s.agent === 'codex')],
      // Variables expand from the environment Codex itself runs with.
      env: async () => ({ ...process.env, ...(await resolveLocalAcpSpawnContext('codex')).agentEnv }),
    });
    if (plan.unusable.length > 0) {
      log.info('Rig connectors: a space’s MCP servers Codex doesn’t get', { bindingId, unusable: plan.unusable });
    }
    return plan;
  } catch (error) {
    log.warn('Rig connectors: could not read the space’s own MCP servers for Codex', { bindingId, error: String(error) });
    return null;
  }
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
  /** The space's own `.mcp.json` servers you haven't allowed on this device (names and URLs only). */
  projectServers: async ({ bindingId }: { bindingId: string }): Promise<ProjectServerNotice[]> =>
    ((await projectServersFor(bindingId))?.pending ?? []).map((p) => ({ name: p.name, url: p.url })),
  /** You clicked Allow: recorded in the folder's `.claude/settings.local.json`, read by your next run there. */
  allowProjectServer: async ({ bindingId, name }: { bindingId: string; name: string }): Promise<boolean> => {
    const cwd = await spaceFolder(bindingId);
    if (!cwd) return false;
    try {
      const allowed = await allowProjectServer(cwd, name);
      if (allowed) globalSetup.invalidate();
      return allowed;
    } catch (error) {
      log.warn('Rig connectors: could not allow a space’s MCP server', { bindingId, error: String(error) });
      return false;
    }
  },
});
