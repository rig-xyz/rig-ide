/**
 * Polish round 2, lane F — "Join with a link" (Home's new-space row):
 * recognizing a pasted invite link before handing it off. The link itself
 * is the hub's own `/join/<secret>` page (`@shared/urls.ts`'s
 * `rigJoinPageUrl` — the exact URL every invite email/copy-link button
 * already produces). Lane H: the parsing now lives in
 * `@shared/rig/invite-link.ts`, so the main process accepts exactly what
 * this field lets through (`rpc.rig.share.acceptInviteLink`).
 */

import { parseInviteLink } from '@shared/rig/invite-link';

/**
 * `null` when `input` isn't recognizable as a rig invite link. Accepts a
 * bare `userig.xyz/join/...` paste (no scheme) the same way browsers'
 * address bars do — prefixes `https://` before parsing rather than
 * rejecting it outright.
 */
export function normalizeJoinLink(input: string): string | null {
  return parseInviteLink(input)?.url ?? null;
}
