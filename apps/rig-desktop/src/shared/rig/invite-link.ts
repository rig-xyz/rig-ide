/**
 * A pasted rig invite link, recognized — the hub's own `/join/<secret>`
 * page (`@shared/urls.ts`'s `rigJoinPageUrl`, the exact URL every invite
 * email/copy-link button produces). Shared so the renderer's "Join with a
 * link" field (`features/home/join-link.ts`) validates exactly what the
 * main process then accepts (`main/rig/rig-share.ts`'s `acceptInviteLink`).
 *
 * The secret IS the invite's bearer capability: callers must never log or
 * display it (or the full URL that carries it).
 */

import { RIG_WEBSITE_URL } from '@shared/urls';

const JOIN_HOST = new URL(RIG_WEBSITE_URL).hostname.toLowerCase();

export type ParsedInviteLink = {
  /** The normalized link (scheme added when the paste had none). */
  url: string;
  /** The invite secret, URL-decoded. */
  secret: string;
};

/**
 * `null` when `input` isn't recognizable as a rig invite link. Accepts a
 * bare `userig.xyz/join/...` paste (no scheme) the same way browsers'
 * address bars do — prefixes `https://` before parsing rather than
 * rejecting it outright.
 */
export function parseInviteLink(input: string): ParsedInviteLink | null {
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

  const match = /^\/join\/([^/]+)$/.exec(url.pathname.replace(/\/+$/, ''));
  if (!match) return null;
  let secret: string;
  try {
    secret = decodeURIComponent(match[1]!).trim();
  } catch {
    return null;
  }
  if (!secret) return null;

  return { url: url.toString(), secret };
}

/** Just the secret out of a pasted invite link — `null` when it isn't one. */
export function extractInviteSecret(input: string): string | null {
  return parseInviteLink(input)?.secret ?? null;
}

/**
 * The relay's own invite-secret shape: `tap_inv_` + base64url (tap's
 * `core/src/ids.ts` `newInviteSecret` — 24 random bytes, so 32 chars
 * today; the bounds leave room without accepting arbitrary junk).
 * Stricter than `parseInviteLink`, which takes whatever a person pasted
 * and lets the relay decide: this is for input a web page can hand us
 * unasked (the `rig://join/<secret>` deep link, `./deep-link.ts`), where
 * anything else is dropped before it reaches the network.
 */
const INVITE_SECRET_SHAPE = /^tap_inv_[A-Za-z0-9_-]{16,128}$/;

export function isInviteSecretShape(secret: string): boolean {
  return INVITE_SECRET_SHAPE.test(secret);
}
