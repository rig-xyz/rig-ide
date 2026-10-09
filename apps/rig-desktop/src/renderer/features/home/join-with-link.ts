import type { QueryClient } from '@tanstack/react-query';
import { MY_INVITES_KEY_PREFIX } from '@renderer/features/shell/invites-inbox';
import { rpc } from '@renderer/lib/ipc';
import { markJustAttachedSyncing } from '@renderer/lib/just-attached';
import { inviteTargetLabel } from '@shared/rig/invite-label';
import { normalizeJoinLink } from './join-link';

/** How a pasted invite link went. */
export type JoinWithLinkOutcome =
  /** Joined and set up here: open this folder. */
  | { kind: 'opened'; path: string; space: boolean }
  /** No usable sign-in here: the link opened in the browser instead. */
  | { kind: 'browser' }
  | { kind: 'error'; message: string };

/**
 * A pasted invite link, end to end: accept it in the app, set it up on
 * this Mac. Without a usable sign-in it opens the website's join page,
 * which can sign in there. The link carries the invite's secret, so no
 * message here ever repeats it.
 */
export async function joinWithInviteLink(value: string, queryClient: QueryClient): Promise<JoinWithLinkOutcome> {
  const url = normalizeJoinLink(value);
  if (!url) return { kind: 'error', message: "That doesn't look like a Rig invite link." };
  const joined = await rpc.rig.share.acceptInviteLink({ link: url });
  if (!joined.success) {
    if (joined.error.kind !== 'notSignedIn') return { kind: 'error', message: joined.error.message };
    const opened = await rpc.app.openExternal(url);
    return opened.success ? { kind: 'browser' } : { kind: 'error', message: opened.error ?? "Couldn't open the browser." };
  }
  void queryClient.invalidateQueries({ queryKey: ['rig', 'account'] });
  void queryClient.invalidateQueries({ queryKey: MY_INVITES_KEY_PREFIX });
  const { bindingId, spaceName, kind } = joined.data;
  const attached = await rpc.rig.join.attach({ bindingId, name: spaceName });
  if (!attached.success) {
    // Joined server-side either way: it shows on Home to set up from there.
    return {
      kind: 'error',
      message: `You joined ${inviteTargetLabel(kind, spaceName)}, but it couldn't be set up here: ${attached.error.message}`,
    };
  }
  markJustAttachedSyncing(attached.data.localPath, attached.data.syncing);
  return { kind: 'opened', path: attached.data.localPath, space: kind !== 'rig' };
}
