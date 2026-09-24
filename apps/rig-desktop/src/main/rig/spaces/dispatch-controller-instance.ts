import { getAcpRuntimeClient } from '@main/core/acp/controller';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { isError, resolveContext } from '../account';
import { resolveLocalPathsImpl } from '../recent-rigs';
import { rigSettingsStore } from '../settings-instance';
import { createDeviceIdResolver, createRuntimeAcpSessions, createSpacesDispatcher } from './dispatch';
import { SpacesDispatchController, type SpacesDispatchControllerDeps } from './dispatch-controller';
import { createHttpSpacesRelayApi } from './relay-api';
import { RequestClaimPoller } from './request-claim';

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
      });
      const poller = new RequestClaimPoller({
        api,
        deviceId: createDeviceIdResolver(api),
        dispatch: dispatcher.dispatch,
      });
      poller.start();
      return { poller, dispatcher };
    },
    setInterval: (cb, ms) => setInterval(cb, ms),
    clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
  };
}

export const spacesDispatchController = new SpacesDispatchController(realDeps());

/** The renderer-facing half: the Room's session card Stop button and owner approvals. */
export const rigSpacesDispatchController = createRPCController({
  stopRun: async ({ runId }: { runId: string }): Promise<{ stopped: boolean }> => ({
    stopped: await spacesDispatchController.stopRun(runId),
  }),
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
