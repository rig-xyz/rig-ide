import type { RigWorkspaceBinding } from './account';

/**
 * What Home can show without the relay, all read from this computer and all
 * scoped to the signed-in account (`main/rig/offline-home.ts`).
 */
export type RigOfflineHomeSnapshot = {
  /** The account this token was last seen as — known without asking the relay; null when it never was. */
  accountId: string | null;
  /** That account's last workspace list on the current relay, or null. */
  workspaces: { savedAt: number; bindings: RigWorkspaceBinding[] } | null;
  /** When each space's chat was last saved to this computer (only with the on-disk chat cache on). */
  roomSavedAt: Record<string, number>;
};
