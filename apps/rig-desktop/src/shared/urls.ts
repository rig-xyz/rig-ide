// Outbound product URLs. These point at our properties, never upstream's —
// every one is reachable by a user click, so a stale emdash.sh here would send
// our users (and their bug reports) to a different product.
export const RIG_RELEASES_URL = 'https://github.com/rig-xyz/rig-ide/releases';
export const RIG_REPO_URL = 'https://github.com/rig-xyz/rig-ide';
export const RIG_WEBSITE_URL = 'https://userig.xyz';
export const RIG_ISSUES_URL = 'https://github.com/rig-xyz/rig-ide/issues';
export const RIG_ISSUES_NEW_URL = 'https://github.com/rig-xyz/rig-ide/issues/new';

/**
 * The canonical, human-facing invite link — the hub's friendly /join page,
 * exactly what the relay's own invite email links (relay-side
 * `inviteJoinPageUrl` builds the same shape from TAP_HUB_URL). Shown and
 * copied INSTEAD of the relay's raw `/v1/invites/<secret>/accept` URL
 * anywhere an invite link renders.
 */
export function rigJoinPageUrl(secret: string): string {
  return `${RIG_WEBSITE_URL}/join/${encodeURIComponent(secret)}`;
}
