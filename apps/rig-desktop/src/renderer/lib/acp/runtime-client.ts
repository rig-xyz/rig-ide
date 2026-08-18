import { acpApiContract, type StartSessionInput } from '@emdash/core/acp/client';
import { awaitWirePort, client, connect, domPortTransport, type DomPortLike } from '@emdash/wire';

/**
 * Renderer-side wire client for the ACP runtime worker — ported verbatim from
 * emdash-desktop's `renderer/lib/acp/runtime-client.ts`. No emdash-desktop
 * coupling: it only touches `@emdash/core`/`@emdash/wire` and
 * `window.electronAPI.requestWirePort`, which this app's preload already
 * exposes (see `src/preload/index.ts`) — the main process side (the ACP
 * runtime worker + `acp-wire` channel) is untouched Emdash core, already
 * wired in `main/index.ts`/`main/core/acp/runtime-process/host.ts`.
 */

const ACP_WIRE_CHANNEL = 'acp-wire';

export type AcpRuntimeRpcClient = ReturnType<typeof createAcpClientForPort>;

let clientPromise: Promise<AcpRuntimeRpcClient> | null = null;
export type { StartSessionInput };

export function getAcpRuntimeClient(): Promise<AcpRuntimeRpcClient> {
  clientPromise ??= createAcpRuntimeClient();
  return clientPromise;
}

export function resetAcpRuntimeClient(): void {
  clientPromise = null;
}

async function createAcpRuntimeClient(): Promise<AcpRuntimeRpcClient> {
  const portPromise = awaitWirePort(window, { channel: ACP_WIRE_CHANNEL });
  await window.electronAPI.requestWirePort(ACP_WIRE_CHANNEL);
  const port = (await portPromise) as DomPortLike;
  return createAcpClientForPort(port);
}

function createAcpClientForPort(port: DomPortLike) {
  const transport = domPortTransport(port);
  return client(acpApiContract, connect(transport));
}
