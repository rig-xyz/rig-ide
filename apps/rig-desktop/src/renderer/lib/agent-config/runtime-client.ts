import { agentConfigContract } from '@emdash/core/workspace-server/agent-config';
import { awaitWirePort, client, connect, domPortTransport, type DomPortLike } from '@emdash/wire';

/**
 * Renderer-side wire client for the agent-config runtime worker — ported
 * verbatim from emdash-desktop's `renderer/lib/agent-config/runtime-client.ts`,
 * mirroring this app's own `renderer/lib/acp/runtime-client.ts` for the ACP
 * channel. No emdash-desktop coupling: it only touches `@emdash/core`/
 * `@emdash/wire` and `window.electronAPI.requestWirePort`, which this app's
 * preload already exposes (see `src/preload/index.ts`) — the main process
 * side (the agent-config runtime worker + `agent-config-wire` channel) is
 * untouched Emdash core, already wired in `main/index.ts`/
 * `main/core/agent-config/runtime-process/host.ts`.
 */

const AGENT_CONFIG_WIRE_CHANNEL = 'agent-config-wire';

export type AgentConfigRuntimeRpcClient = ReturnType<typeof createAgentConfigClientForPort>;

let clientPromise: Promise<AgentConfigRuntimeRpcClient> | null = null;

/**
 * Shown in place of the raw IPC failure ("No handler registered for
 * 'agent-config-wire:connect'") when the main process hasn't installed the
 * channel yet — the agent-config worker is still starting, or its start
 * failed and is being retried (`main/index.ts`). A user saw the raw form on
 * the fresh-user regression run's provider sign-in dialog.
 */
export const AGENT_RUNTIME_UNAVAILABLE_MESSAGE =
  'Agent sign-in isn’t available yet — the agent runtime is still starting. Try again in a few seconds; if it keeps failing, restart Rig.';

export function getAgentConfigRuntimeClient(): Promise<AgentConfigRuntimeRpcClient> {
  // A failed connect must not be memoized: the main process retries a slow
  // worker start with backoff, so the next attempt from here may succeed.
  clientPromise ??= createAgentConfigRuntimeClient().catch((error: unknown) => {
    clientPromise = null;
    throw isMissingHandlerError(error) ? new Error(AGENT_RUNTIME_UNAVAILABLE_MESSAGE) : error;
  });
  return clientPromise;
}

function isMissingHandlerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('No handler registered');
}

export function resetAgentConfigRuntimeClient(): void {
  clientPromise = null;
}

async function createAgentConfigRuntimeClient(): Promise<AgentConfigRuntimeRpcClient> {
  const portPromise = awaitWirePort(window, { channel: AGENT_CONFIG_WIRE_CHANNEL });
  await window.electronAPI.requestWirePort(AGENT_CONFIG_WIRE_CHANNEL);
  const port = (await portPromise) as DomPortLike;
  return createAgentConfigClientForPort(port);
}

function createAgentConfigClientForPort(port: DomPortLike) {
  const transport = domPortTransport(port);
  return client(agentConfigContract, connect(transport));
}
