/**
 * How Home reads the connection, and what it falls back to without one.
 * Pure: `home.tsx` feeds it what the queries and `navigator.onLine` say.
 *
 *   offline      — no network at all (`navigator.onLine` false)
 *   unreachable  — online, but the relay's answer failed (down, timed out)
 *   slow         — still waiting on the first answer past `SLOW_AFTER_MS`;
 *                  slow is not offline: nothing is disabled, nothing hidden
 *   online       — everything else, including a normal first load
 */

import type { RigWorkspaceBinding } from '@shared/rig/account';
import type { HomeBinding, HomeWorkspacesState } from './home-sections';

export type HomeConnection = 'online' | 'slow' | 'offline' | 'unreachable';

/** How long a first load may take before Home says it's still connecting. */
export const SLOW_AFTER_MS = 4_000;

export function deriveHomeConnection(input: {
  signedIn: boolean;
  navigatorOnline: boolean;
  workspaces: HomeWorkspacesState;
  /** True once the first load has been waiting longer than `SLOW_AFTER_MS`. */
  waitedLong: boolean;
}): HomeConnection {
  // Signed out, Home shows nothing that needs the relay.
  if (!input.signedIn) return 'online';
  if (!input.navigatorOnline) return 'offline';
  if (input.workspaces.status === 'unreachable') return 'unreachable';
  if (input.workspaces.status === 'loading' && input.waitedLong) return 'slow';
  return 'online';
}

/** True when actions that need the relay (create, join, download, delete) should be disabled. */
export function needsConnection(connection: HomeConnection): boolean {
  return connection === 'offline' || connection === 'unreachable';
}

export const NEEDS_CONNECTION_TOOLTIP = 'Needs a connection';

export const CONNECTION_BANNER_TEXT: Record<Exclude<HomeConnection, 'online'>, string> = {
  offline: "You're offline · showing what's on this computer",
  unreachable: "Can't reach rig right now · showing what's on this computer",
  slow: 'Still connecting to rig…',
};

/** Auto-retry backoff while the relay is unreachable: 5s, 10s, 20s, 40s, then every 60s. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, attempt));
}

/**
 * The workspace list Home builds its rows from: the live one once it's in,
 * otherwise (loading, or the relay unreachable) the account's last known
 * one from this computer — so a slow or failed relay never empties the
 * Spaces card. Signed out (`'skipped'`) never falls back.
 */
export function withRememberedWorkspaces(
  workspaces: HomeWorkspacesState,
  remembered: readonly RigWorkspaceBinding[] | null
): HomeWorkspacesState {
  if (workspaces.status === 'ok' || workspaces.status === 'skipped' || !remembered) return workspaces;
  return {
    status: 'ok',
    bindings: remembered.map(
      (b): HomeBinding => ({
        bindingId: b.id,
        name: b.name,
        kind: b.kind,
        lastSyncedAt: b.lastSyncedAt,
        role: b.role,
        createdAt: b.createdAt,
      })
    ),
  };
}

/**
 * Which account's local rows Home may show (`filterLocalRigsByAccount`'s
 * `signedInAccountId`). The live `/v1/me` answer wins; while it's missing
 * (loading, or failed offline) the account this same token was last seen
 * as, from this computer, stands in. If that isn't known either and `/v1/me`
 * has failed, `null`: only rows no account has claimed are shown, never
 * another account's. `undefined` (don't filter yet) only while both are
 * still loading.
 */
export function resolveHomeAccountId(input: {
  signedIn: boolean;
  meId: string | null | undefined;
  meFailed: boolean;
  /** `undefined` while the local read is in flight. */
  rememberedAccountId: string | null | undefined;
}): string | null | undefined {
  if (!input.signedIn) return null;
  if (input.meId) return input.meId;
  if (input.rememberedAccountId) return input.rememberedAccountId;
  if (input.meFailed && input.rememberedAccountId !== undefined) return null;
  return undefined;
}

/** A space row's last activity from local data only: opened here, its chats, or its saved chat. */
export function offlineLastActivity(
  row: { lastOpenedAt?: number; sessions: readonly { updatedAt: number }[] },
  roomSavedAt: number | undefined
): number | null {
  const times = [row.lastOpenedAt ?? 0, roomSavedAt ?? 0, ...row.sessions.map((s) => s.updatedAt)];
  const latest = Math.max(...times);
  return latest > 0 ? latest : null;
}

/**
 * The same banner inside a space. The Room's own `connection: 'offline'`
 * only means the live socket is down — it keeps polling, so that alone is
 * the quiet "updating a little slower" note, not this banner. The banner
 * shows with no network at all, or once the relay's reads actually fail.
 */
export function deriveRoomConnection(input: {
  navigatorOnline: boolean;
  connection: 'connecting' | 'online' | 'offline' | undefined;
  relayUnreachable: boolean | undefined;
}): 'offline' | 'unreachable' | null {
  if (!input.navigatorOnline) return 'offline';
  if (input.relayUnreachable && input.connection !== 'online') return 'unreachable';
  return null;
}

/** The composer's note while a message waits for the connection. */
export const WILL_SEND_WHEN_ONLINE = "Will send when you're back online";
