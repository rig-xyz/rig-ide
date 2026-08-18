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

export function getAgentConfigRuntimeClient(): Promise<AgentConfigRuntimeRpcClient> {
  clientPromise ??= createAgentConfigRuntimeClient();
  return clientPromise;
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
