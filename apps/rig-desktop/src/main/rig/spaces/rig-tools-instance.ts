import { readFile, stat } from 'node:fs/promises';
import { err, ok, type Result } from '@emdash/shared';
import { events } from '@main/lib/events';
import type { RigFileNode } from '@shared/rig/files';
import { spacesAgentConfigChangedChannel } from '@shared/spaces/agent-settings';
import { roomSeesFor } from '@shared/spaces/room-sees';
import { findBindingConfig } from '../binding';
import { rigSettingsStore } from '../settings-instance';
import { rigCommentsController } from '../comments';
import { rigFileRootRegistry } from '../file-root-registry';
import { rigFilesController } from '../files';
import { rigPulseController } from '../pulse';
import { renameRig } from '../rig-controls';
import { rigShareController } from '../rig-share';
import { browserRigTools } from '../pages/browser-rig-tools';
import { finalAnswerFromEvents } from './dispatch';
import { createHttpSpacesRelayApi } from './relay-api';
import { ownerApprovals, rigToolScopeKey, type RigToolsBackend } from './rig-tools';
import { createRigToolsServer } from './rig-tools-server';

/**
 * Boot-only wiring for the rig tools server: the real backends, each the one
 * the desktop already uses for the same thing (the Share popover's invite,
 * the Room's member and invite lists, Details → Changes' file listing and
 * Pulse line, the doc margin's comments, the row menu's Rename…, the Room's
 * message list and run logs). Kept out of `rig-tools.ts` and
 * `rig-tools-server.ts` for the same reason as `dispatch-controller-instance.ts`:
 * these modules touch Electron at load time, so nothing under test may import
 * this file.
 */

const MAX_TEXT_BYTES = 5 * 1024 * 1024;

const api = createHttpSpacesRelayApi();

/** Runs `fn` with `root` registered as a file root, and always lets it go again. */
async function withRoot<T>(root: string, fn: (rootId: string) => Promise<T>, fallback: T): Promise<T> {
  const registered = await rigFileRootRegistry.register(root);
  if (!registered.success) return fallback;
  try {
    return await fn(registered.data.rootId);
  } finally {
    rigFileRootRegistry.release(registered.data.rootId);
  }
}

const backend: RigToolsBackend = {
  whoami: () => api.whoami(),
  bindingAt: (dir) => findBindingConfig(dir)?.config.bindingId ?? null,
  createInvite: (root, email, role) => rigShareController.createInvite({ root, email, role }),
  listMembers: (bindingId) => api.listMembers(bindingId),
  listInvites: async (bindingId) => (api.listInvites ? api.listInvites(bindingId) : ok([])),
  listFiles: (root) =>
    withRoot<Result<RigFileNode[], { message: string }>>(
      root,
      (rootId) => rigFilesController.list({ rootId }),
      err({ message: "the space's folder isn't available" })
    ),
  spaceStory: async (bindingId) => {
    // Account-wide briefing: only this space's own line is ever used, never other rigs' or people's lines.
    const pulse = await rigPulseController.get({});
    if (!pulse.success) return null;
    return pulse.data.briefing.perRig.find((item) => item.bindingId === bindingId)?.line || null;
  },
  listComments: async (absPath) => {
    const listed = await rigCommentsController.list({ absPath });
    return listed.success ? ok(listed.data.messages) : err(listed.error);
  },
  readText: (root, relPath) =>
    withRoot(
      root,
      async (rootId) => {
        const resolved = await rigFileRootRegistry.resolveExisting(rootId, relPath);
        if (!resolved.success) return null;
        try {
          if ((await stat(resolved.data)).size > MAX_TEXT_BYTES) return null;
          return await readFile(resolved.data, 'utf8');
        } catch {
          return null;
        }
      },
      null
    ),
  createComment: ({ absPath, body, anchor, meta }) =>
    rigCommentsController.create({ absPath, body, anchor, authorKind: 'agent', meta }),
  replyComment: ({ absPath, parentId, body, meta }) =>
    rigCommentsController.reply({ absPath, parentId, body, authorKind: 'agent', meta }),
  // renameRig itself updates the relay's name and tells every window (rigRenamedChannel).
  renameSpace: async (bindingId, root, name) => {
    return renameRig(bindingId, root, name);
  },
  listMessages: (bindingId, query) => api.listMessages(bindingId, query),
  runAnswer: async (bindingId, runId) => {
    const log = await api.getSessionEvents(bindingId, runId);
    if (!log.success) return null;
    return { agent: log.data.run.agent, text: finalAnswerFromEvents(log.data.events), endedAt: log.data.run.endedAt };
  },
  // The agent settings pill's own path. Imported on use: the dispatch controller imports this module.
  agentConfig: async ({ bindingId, ownerUserId, agent }) => {
    const { spacesDispatchController } = await import('./dispatch-controller-instance');
    const config = await spacesDispatchController.agentConfig(bindingId, ownerUserId, agent);
    return config.success ? config : err({ message: config.error });
  },
  setAgentConfig: async ({ bindingId, ownerUserId, agent }, change) => {
    const { spacesDispatchController } = await import('./dispatch-controller-instance');
    const config = await spacesDispatchController.setAgentConfig(bindingId, ownerUserId, agent, change);
    if (!config.success) return err({ message: config.error });
    // The pill changes its own copy; an agent's change tells every open pill.
    events.emit(spacesAgentConfigChangedChannel, { bindingId, agent, config: config.data });
    return config;
  },
  // The pill's save path: settings-changed reaches its windows, and each turn's trace filter reads it.
  roomSees: (bindingId) => roomSeesFor(rigSettingsStore.get().spacesRoomSees, bindingId),
  setRoomSees: (bindingId, level) => {
    rigSettingsStore.set({ spacesRoomSees: { [bindingId]: level } });
  },
  // The connectors panel's calls; the relay posts the "added/removed" line the Room refreshes on.
  listSpaceConnectors: async (bindingId) => {
    const listed = api.listConnectors ? await api.listConnectors(bindingId) : ok([]);
    return listed.success ? ok(listed.data.map((c) => c.connectorId)) : err(listed.error);
  },
  addSpaceConnector: async (bindingId, connectorId) => {
    if (!api.addConnector) return err({ message: "this relay can't add connectors" });
    const added = await api.addConnector(bindingId, connectorId);
    return added.success ? ok(undefined) : err(added.error);
  },
  removeSpaceConnector: async (bindingId, connectorId) => {
    if (!api.removeConnector) return err({ message: "this relay can't remove connectors" });
    return api.removeConnector(bindingId, connectorId);
  },
  takeOwnerApproval: (scope) => ownerApprovals.take(rigToolScopeKey(scope)),
  // As the session's agent: the relay stores it under the owner, labelled with the agent.
  react: async (bindingId, messageId, emoji, agent) => {
    if (!api.setReaction) return err({ message: "this relay can't take reactions" });
    return api.setReaction(bindingId, messageId, { emoji, on: true, agent });
  },
  // Imported on use, like `agentConfig`: the dispatch controller imports this module.
  currentRunId: async ({ bindingId, ownerUserId, agent }) => {
    const { spacesDispatchController } = await import('./dispatch-controller-instance');
    return spacesDispatchController.currentRunId(bindingId, ownerUserId, agent);
  },
};

export const rigToolsServer = createRigToolsServer({ backend, extraTools: browserRigTools(api) });
