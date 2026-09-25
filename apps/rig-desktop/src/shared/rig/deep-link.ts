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
 * it, or the URL that carries it.
 */

export const RIG_URL_SCHEME = 'rig';

export type RigDeepLink = {
  kind: 'join';
  secret: string;
};

// `rig://join/<secret>`, an optional trailing slash (Windows' shell appends
// one to some protocol activations), nothing else: no query, no fragment, no
// extra path segments, no userinfo/port. The scheme and `join` host are
// case-insensitive (browsers may lowercase either); the secret is not.
const JOIN_LINK = /^rig:\/\/join\/([^/?#]+)\/?$/i;

/** `null` for anything that isn't a well-formed `rig://join/<secret>`. */
export function parseRigDeepLink(input: string): RigDeepLink | null {
  const match = JOIN_LINK.exec(input.trim());
  if (!match) return null;
  const secret = match[1]!;
  if (!isInviteSecretShape(secret)) return null;
  return { kind: 'join', secret };
}

/**
 * The first `rig://` argument in a process argv — how Windows and Linux hand
 * a deep link over (the initial `process.argv`, and `second-instance`'s argv
 * when the app was already running). Not parsed here: callers run it through
 * `parseRigDeepLink` so an unrecognized one is still logged as ignored.
 */
export function findRigUrlInArgv(argv: readonly string[]): string | null {
  const prefix = `${RIG_URL_SCHEME}://`;
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
