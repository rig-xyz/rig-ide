import { join } from 'node:path';
import { app } from 'electron';
import { getAcpRuntimeClient } from '@main/core/acp/controller';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { isError, resolveContext, rigAccountController } from '../account';
import { resolveLocalPathsImpl } from '../recent-rigs';
import { rigSettingsStore } from '../settings-instance';
import { err, type Result } from '@emdash/shared';
import {
  type AgentConfig,
  type AgentConfigChange,
  createDeviceIdResolver,
  createRuntimeAcpSessions,
  createSpacesDispatcher,
} from './dispatch';
import { SpacesDispatchController, type SpacesDispatchControllerDeps } from './dispatch-controller';
import { createHttpSpacesRelayApi } from './relay-api';
import { RequestClaimPoller } from './request-claim';
import { createFileSpaceSessionStore } from './session-store';

/**
 * Boot-only wiring for `SpacesDispatchController` — real settings store,
 * real ACP runtime client, real relay API. Deliberately kept out of
 * `dispatch-controller.ts` itself: several of these (the ACP runtime
 * client, `resolveLocalPathsImpl`'s DB read, the settings store singleton)
 * touch Electron's `app`/the SQLite DB at module load time, which only
 * works inside the real app — importing any of them from a Vitest `node`
 * project test fails before a single test even runs (the same pre-existing
 * gap `context.test.ts`/`comments.smoke.test.ts`/etc. hit). This file is
 * the one place that eagerly pays that cost, and nothing under test may
 * import it.
 */
function realDeps(): SpacesDispatchControllerDeps {
  return {
    isEnabled: () => rigSettingsStore.get().spacesEnabled,
    subscribeEnabled: (cb) => rigSettingsStore.subscribe(cb),
    isSignedIn: async () => !isError(await resolveContext()),
    startPoller: async () => {
      const api = createHttpSpacesRelayApi();
      const dispatcher = createSpacesDispatcher({
        api,
        acp: createRuntimeAcpSessions(getAcpRuntimeClient),
        resolveWorkspace: async (bindingId) =>
          (await resolveLocalPathsImpl([bindingId]))[bindingId] ?? null,
        store: createFileSpaceSessionStore(join(app.getPath('userData'), 'spaces-sessions.json')),
      });
      const poller = new RequestClaimPoller({
        api,
        deviceId: createDeviceIdResolver(api),
        dispatch: dispatcher.dispatch,
      });
      poller.start();
      void dispatcher.settleInterrupted();
      return { poller, dispatcher };
    },
    setInterval: (cb, ms) => setInterval(cb, ms),
    clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
  };
}

const relayApi = createHttpSpacesRelayApi();

export const spacesDispatchController = new SpacesDispatchController(realDeps());

/**
 * Doc comments in a space go to your room agent: the same persistent session
 * `@claude` reaches in the Room. Returns null when this isn't a space (or
 * Spaces is off), so the caller keeps the standalone comment agent.
 */
/** Answers an approval on a room-agent turn from the doc margin (same path as the Room card). */
export async function resolveRoomTurnPermission(runId: string, requestId: string, optionId: string): Promise<boolean> {
  return spacesDispatchController.resolvePermission(runId, requestId, optionId);
}

export async function runCommentTurnInRoom(spec: {
  bindingId: string;
  agent: 'claude' | 'codex';
  prompt: string;
  hiddenContext: string;
  /** The doc comment thread being answered. */
  threadId?: string;
  onPermissionsChanged?: Parameters<SpacesDispatchController['runLocal']>[0]['onPermissionsChanged'];
}): Promise<Awaited<ReturnType<SpacesDispatchController['runLocal']>> | null> {
  if (!spacesDispatchController.isRunning()) {
    log.info('Rig spaces: doc mention goes to the standalone agent (Spaces not running)');
    return null;
  }
  log.info('Rig spaces: doc mention — checking whether this is a space', { bindingId: spec.bindingId });
  const workspaces = await rigAccountController.workspaces();
  const isSpace =
    workspaces.success && workspaces.data.some((b) => b.id === spec.bindingId && b.kind === 'space');
  log.info('Rig spaces: doc mention — space check done', { isSpace, ok: workspaces.success });
  if (!isSpace) return null;
  const me = await relayApi.whoami();
  if (!me.success) {
    log.warn('Rig spaces: doc mention could not identify you; using the standalone agent', { error: me.error.message });
    return null;
  }
  log.info('Rig spaces: doc mention goes to your room agent', { bindingId: spec.bindingId });
  return spacesDispatchController.runLocal({
    bindingId: spec.bindingId,
    ownerUserId: me.data.id,
    agent: spec.agent,
    prompt: spec.prompt,
    extraHiddenContext: spec.hiddenContext,
    threadId: spec.threadId,
    onPermissionsChanged: spec.onPermissionsChanged,
  });
}

/** The renderer-facing half: the Room's session card Stop button and owner approvals. */
export const rigSpacesDispatchController = createRPCController({
  stopRun: async ({ runId, bindingId }: { runId: string; bindingId?: string }): Promise<{ stopped: boolean }> => ({
    stopped: await spacesDispatchController.stopRun(runId, bindingId),
  }),
  /** Your agent's settings in this space; reaches its session, so only call it when a selector opens. */
  agentConfig: async ({
    bindingId,
    agent,
  }: {
    bindingId: string;
    agent: 'claude' | 'codex';
  }): Promise<Result<AgentConfig, string>> => {
    const me = await relayApi.whoami();
    if (!me.success) return err(me.error.message);
    return spacesDispatchController.agentConfig(bindingId, me.data.id, agent);
  },
  setAgentConfig: async ({
    bindingId,
    agent,
    change,
  }: {
    bindingId: string;
    agent: 'claude' | 'codex';
    change: AgentConfigChange;
  }): Promise<Result<AgentConfig, string>> => {
    const me = await relayApi.whoami();
    if (!me.success) return err(me.error.message);
    return spacesDispatchController.setAgentConfig(bindingId, me.data.id, agent, change);
  },
  settleStaleRun: async ({ runId, bindingId }: { runId: string; bindingId: string }): Promise<{ settled: boolean }> => ({
    settled: await spacesDispatchController.settleStaleRun(runId, bindingId),
  }),
  checkNow: async (): Promise<void> => {
    await spacesDispatchController.checkNow();
  },
  resolvePermission: async ({
    runId,
    requestId,
    optionId,
  }: {
    runId: string;
    requestId: string;
    optionId: string;
  }): Promise<{ resolved: boolean }> => ({
    resolved: await spacesDispatchController.resolvePermission(runId, requestId, optionId),
  }),
});
