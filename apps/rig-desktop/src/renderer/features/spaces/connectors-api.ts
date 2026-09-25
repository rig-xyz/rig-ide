import { rpc } from '@renderer/lib/ipc';
import type { ConnectionStatus, ConnectorId, ConnectResult } from '@shared/spaces/connectors';

/**
 * The main-process connectors RPC (`rpc.rig.connectors`, see connectors-
 * spec.md): your own connections to the BYOA catalog, on this machine. Kept
 * behind this one wrapper — rather than every caller reaching into
 * `rpc.rig.connectors` directly — so tests can mock a single module instead
 * of standing up IPC (same reason `relay-room-source.ts` takes a
 * `RelayRoomClient` instead of calling `rpc.rig.spacesConnection` itself).
 */
export interface ConnectorsApi {
  /** Every catalog id's connection state on this device. */
  list(): Promise<ConnectionStatus[]>;
  /** Opens the vendor's browser sign-in; resolves when it finishes, is cancelled, or times out. */
  connect(id: ConnectorId): Promise<ConnectResult>;
  /** Aborts an in-flight `connect()` for this connector. */
  cancel(id: ConnectorId): Promise<void>;
  /** Deletes this device's local tokens for the connector. */
  disconnect(id: ConnectorId): Promise<void>;
}

export const connectorsApi: ConnectorsApi = {
  list: () => rpc.rig.connectors.list(),
  connect: (id) => rpc.rig.connectors.connect({ id }),
  cancel: (id) => rpc.rig.connectors.cancel({ id }),
  disconnect: (id) => rpc.rig.connectors.disconnect({ id }),
};
