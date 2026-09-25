import { URL_SCHEME } from '../app-identity';
import { defineEvent } from '../lib/ipc/events';
import { rigJoinPageUrl } from '../urls';
import { isInviteSecretShape } from './invite-link';

/**
 * `rig://` deep links — the website's invite page ("Open in Rig" on
 * `userig.xyz/join/<secret>`) opens `rig://join/<secret>`, and the OS hands
 * that URL to this app (`main/app/deep-links.ts`). The contract the website
 * depends on is documented in `docs/deep-links.md`.
 *
 * Any web page can open a `rig://` URL, so everything here treats the input
 * as hostile: exactly one shape is accepted, and a match only ever leads to
 * an in-app confirm (`features/deep-link/deep-link-join-dialog.tsx`), never
 * a silent join. The secret is the invite's bearer capability — never log
 * it, or the URL that carries it. Canary builds use `rig-canary://` instead
 * (see `RIG_URL_SCHEME`).
 */

/**
 * The scheme this build registers and accepts: `rig` for stable (and dev),
 * `rig-canary` for canary, so the two never fight over the website's `rig://`
 * links. Everything below takes the scheme as a parameter (defaulting to this
 * build's) so tests can exercise both.
 */
export const RIG_URL_SCHEME = URL_SCHEME;

export type RigDeepLink = {
  kind: 'join';
  secret: string;
};

// `<scheme>://join/<secret>`, an optional trailing slash (Windows' shell
// appends one to some protocol activations), nothing else: no query, no
// fragment, no extra path segments, no userinfo/port. The scheme and `join`
// host are case-insensitive (browsers may lowercase either); the secret is not.
function joinLinkPattern(scheme: string): RegExp {
  const escaped = scheme.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  return new RegExp(`^${escaped}:\\/\\/join\\/([^/?#]+)\\/?$`, 'i');
}

/** `null` for anything that isn't a well-formed `<scheme>://join/<secret>` for this build's scheme. */
export function parseRigDeepLink(
  input: string,
  scheme: string = RIG_URL_SCHEME
): RigDeepLink | null {
  const match = joinLinkPattern(scheme).exec(input.trim());
  if (!match) return null;
  const secret = match[1]!;
  if (!isInviteSecretShape(secret)) return null;
  return { kind: 'join', secret };
}

/**
 * The first argument in this build's scheme (`rig://`, or `rig-canary://` on
 * canary) in a process argv — how Windows and Linux hand a deep link over
 * (the initial `process.argv`, and `second-instance`'s argv when the app was
 * already running). Not parsed here: callers run it through
 * `parseRigDeepLink` so an unrecognized one is still logged as ignored.
 */
export function findRigUrlInArgv(
  argv: readonly string[],
  scheme: string = RIG_URL_SCHEME
): string | null {
  const prefix = `${scheme.toLowerCase()}://`;
  return argv.find((arg) => arg.toLowerCase().startsWith(prefix)) ?? null;
}

/**
 * Main → renderer: a `rig://join/<secret>` arrived, re-expressed as the
 * canonical `https://userig.xyz/join/<secret>` link so the renderer can hand
 * it to the same `rpc.rig.share.previewInviteLink`/`acceptInviteLink` calls
 * the pasted-link flow uses.
 */
export type RigDeepLinkJoin = { link: string };

export function toJoinRequest(link: RigDeepLink): RigDeepLinkJoin {
  return { link: rigJoinPageUrl(link.secret) };
}

export const rigDeepLinkJoinChannel = defineEvent<RigDeepLinkJoin>('rig:deep-link-join');
