/**
 * Polish round 2, lane F — "Join with a link" (Home's new-space row): the
 * one thing this needs that isn't already built is recognizing a pasted
 * invite link before handing it off. The link itself is the hub's own
 * `/join/<secret>` page (`@shared/urls.ts`'s `rigJoinPageUrl` — the exact
 * URL every invite email/copy-link button already produces); the hub page
 * is where accept-and-attach actually happens (signed-in there mints the
 * device and hands back into the app), so this module only validates and
 * normalizes what the user pasted, never re-implements that flow.
 */

import { RIG_WEBSITE_URL } from '@shared/urls';

const JOIN_HOST = new URL(RIG_WEBSITE_URL).hostname.toLowerCase();

/**
 * `null` when `input` isn't recognizable as a rig invite link. Accepts a
 * bare `userig.xyz/join/...` paste (no scheme) the same way browsers'
 * address bars do — prefixes `https://` before parsing rather than
 * rejecting it outright.
 */
export function normalizeJoinLink(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  if (url.hostname.toLowerCase() !== JOIN_HOST) return null;

  const path = url.pathname.replace(/\/+$/, '');
  if (!path.startsWith('/join/') || path === '/join') return null;

  return url.toString();
}
