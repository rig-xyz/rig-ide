import { formatDistanceStrict } from 'date-fns';
import { RIG_WEBSITE_URL } from '@shared/urls';

/**
 * Formatting + liveness for the Settings → Workspaces row's "last synced"
 * status. Pure and `now`-parameterized so both are unit-testable without
 * mocking the system clock.
 */

/** Synced within this long ago counts as "live" for the row's status dot. */
export const LIVE_THRESHOLD_MS = 60_000;

function parse(lastSyncedAt: string): Date | null {
  const date = new Date(lastSyncedAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "just now" / "2 minutes ago" / "Never synced" — never throws on a bad timestamp. */
export function formatLastSynced(lastSyncedAt: string | null, now: Date = new Date()): string {
  if (lastSyncedAt === null) return 'Never synced';
  const date = parse(lastSyncedAt);
  if (!date) return 'Never synced';
  if (now.getTime() - date.getTime() < LIVE_THRESHOLD_MS) return 'just now';
  return formatDistanceStrict(date, now, { addSuffix: true, roundingMethod: 'floor' });
}

/** True when the caller's own device synced this workspace within the last minute. */
export function isWorkspaceLive(lastSyncedAt: string | null, now: Date = new Date()): boolean {
  if (lastSyncedAt === null) return false;
  const date = parse(lastSyncedAt);
  if (!date) return false;
  return now.getTime() - date.getTime() < LIVE_THRESHOLD_MS;
}

/**
 * Deep-links to this binding's Share tab on the hub — where member
 * management actually lives (`hub/web/src/app/home/workspaces/[bindingId]`),
 * deliberately not duplicated here. `RIG_WEBSITE_URL` (userig.xyz) is the
 * custom domain that `hub/web`'s `rig-web` Worker is routed to, so it's the
 * same origin the rest of the app already links out to.
 */
export function hubWorkspaceUrl(bindingId: string): string {
  return `${RIG_WEBSITE_URL}/home/workspaces/${bindingId}?tab=share`;
}
