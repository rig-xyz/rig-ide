import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Share2, UserPlus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { insidePeopleLayer } from '@renderer/features/people/person-card';
import { useRigSignIn } from '@renderer/features/rig-account/use-rig-sign-in';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { Popover } from '@renderer/lib/ui/popover';
import { cn } from '@renderer/lib/utils';
import type { RigMemberList } from '@shared/rig/rig-share';
import { deriveAvatarStack } from './avatar-stack';
import { onOpenInviteForm } from './open-invite';
import { InviteByName } from './invite-field';
import { MemberList } from './people-section';
import { deriveSharePopoverPhase } from './share-sync-state';

/**
 * The rig-level Share button in the file browser header: its trigger shows
 * who's on the rig (stacked member avatars, capped +N) next to the word
 * Share; the popover lists members, and — for the rig's owner — its pending
 * outgoing invites and an invite form. Portal/dismissal/positioning come
 * from the shared `Popover` primitive (`@renderer/lib/ui/popover`), same as
 * `share-popover.tsx` — this popover has real interactive surface (a
 * permission choice, a Create button, per-link Revoke buttons).
 *
 * Relay contract mirrored from the web hub's InviteModal (user plane,
 * `/v1/me/bindings/:bindingId/*` over the trust-gated PAT — see
 * `main/rig/rig-share.ts`): invite list/mint/revoke are owner-only on the
 * relay, so those sections only render when `selfRole === 'owner'`. The
 * user-plane mint sends NO email even for an email-constrained invite — the
 * minted link is the deliverable, and the UI says so rather than pretending
 * an email went out.
 *
 * Onboarding-flow spec, Rollout step 2 ("deferred share/sync"): a rig
 * created local-only has no relay binding yet, so `rig.share.members`
 * answers `notBound` — this popover IS the deferred moment, decided only
 * when someone actually opens it. `deriveSharePopoverPhase` turns
 * (signed-in?, that error) into what to show: signed out still offers
 * sign-in first; signed in and local-only offers to turn sync on right
 * here (that click is the consent — `rpc.rig.create.enableSync`, the same
 * driver the old create dialog's own "Turn on sync" used); signed in and
 * already-synced renders exactly as before.
 */
export function RigShareButton({
  root,
  name,
  variant = 'default',
  pendingReason,
}: {
  root: string;
  name: string | null;
  /**
   * `'pill'`: a space's top bar (Dylan, 2026-09-26: people and invite are
   * one thing): the member faces on the left of an accent "Invite" pill,
   * one trigger for one popover (who's here, and inviting someone new).
   * `'default'` keeps the avatar-stack-or-icon "Share" trigger the rig file
   * browser header uses.
   */
  variant?: 'default' | 'pill';
  /**
   * Instant new space: set while the space is still being set up — the
   * pill shows, disabled, with this as its reason, and nothing is asked of
   * the relay (the folder has no binding yet; a cached "not bound" answer
   * would outlive the setup).
   */
  pendingReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const membersQuery = useQuery({
    queryKey: ['rig', 'share', 'members', root],
    queryFn: () => rpc.rig.share.members({ root }),
    enabled: !pendingReason,
    // The trigger's avatar stack wants this before the popover ever opens;
    // membership changes rarely, so a quiet minute of staleness is fine.
    staleTime: 60_000,
  });
  const memberList = membersQuery.data?.success ? membersQuery.data.data : null;

  const stack = deriveAvatarStack(memberList?.members ?? []);

  // The space's pill opens when something asks for the invite form (the empty Room's "Invite someone").
  useEffect(() => {
    if (variant !== 'pill' || pendingReason) return;
    return onOpenInviteForm(() => setOpen(true));
  }, [variant, pendingReason]);

  if (variant === 'pill') {
    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => {
            if (!pendingReason) setOpen((v) => !v);
          }}
          aria-haspopup="true"
          aria-expanded={open}
          aria-label="People and invites"
          // Not `disabled`: a disabled button shows no tooltip, and the tooltip says why.
          aria-disabled={pendingReason ? true : undefined}
          title={pendingReason}
          data-testid="invite-pill"
          className={cn(
            'group rounded-chip flex shrink-0 items-center gap-1.5 py-0.5 pr-0.5 pl-1 ring-1 ring-transparent transition-colors',
            pendingReason ? 'cursor-default opacity-50' : 'hover:bg-bg-2 hover:ring-border-hairline',
            open && 'bg-bg-2 ring-border-hairline'
          )}
        >
          {stack.visible.length > 0 && (
            <span className="flex items-center">
              {stack.visible.map((member, index) => (
                <IdentityAvatar
                  key={member.userId}
                  name={member.name ?? member.email}
                  avatarUrl={member.avatarUrl}
                  sizeClassName="size-6"
                  textClassName="text-2xs"
                  className={cn('ring-bg-1 ring-1', index > 0 && '-ml-1.5')}
                />
              ))}
              {stack.overflow > 0 && (
                <span className="bg-bg-2 text-text-muted ring-bg-1 -ml-1.5 flex size-6 shrink-0 items-center justify-center rounded-full text-2xs font-medium ring-1">
                  +{stack.overflow}
                </span>
              )}
            </span>
          )}
          <span
            className={cn(
              'bg-accent text-bg-0 rounded-chip flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium transition-opacity',
              !pendingReason && 'group-hover:opacity-90'
            )}
          >
            <UserPlus className="size-3.5" strokeWidth={1.5} />
            Invite
          </span>
        </button>
        <Popover
          anchor={triggerRef}
          open={open}
          onClose={() => setOpen(false)}
          role="dialog"
          align="right"
          gap={6}
          estimatedWidth={POPOVER_WIDTH}
          minWidth={POPOVER_WIDTH}
          className="py-0"
          ariaLabel="People and invites"
          keepOpenOn={insidePeopleLayer}
        >
          <RigSharePopoverContent root={root} name={name} isSpace />
        </Popover>
      </>
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        className="border-border-hairline text-text-secondary hover:bg-bg-2 hover:text-text-primary rounded-control flex shrink-0 items-center gap-1.5 border bg-bg-1 px-2 py-1 text-xs transition-colors"
      >
        {stack.visible.length > 0 ? (
            <span className="flex items-center">
              {stack.visible.map((member, index) => (
                <IdentityAvatar
                  key={member.userId}
                  name={member.name ?? member.email}
                  avatarUrl={member.avatarUrl}
                  sizeClassName="size-5"
                  textClassName="text-2xs"
                  className={cn('ring-bg-1 ring-1', index > 0 && '-ml-1')}
                />
              ))}
              {stack.overflow > 0 && (
                <span className="bg-bg-2 text-text-muted ring-bg-1 -ml-1 flex size-5 shrink-0 items-center justify-center rounded-chip text-2xs font-medium ring-1">
                  +{stack.overflow}
                </span>
              )}
            </span>
          ) : (
            <Share2 className="size-3.5" strokeWidth={1.5} />
          )}
        Share
      </button>

      <Popover
        anchor={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        role="dialog"
        align="right"
        gap={6}
        estimatedWidth={POPOVER_WIDTH}
        minWidth={POPOVER_WIDTH}
        className="py-0"
        ariaLabel="Share"
        keepOpenOn={insidePeopleLayer}
      >
        <RigSharePopoverContent root={root} name={name} />
      </Popover>
    </>
  );
}

const POPOVER_WIDTH = 400;

/** How a space or rig is named in this surface: a space with `#`. */
function placeLabel(name: string | null, isSpace: boolean): string | null {
  if (!name) return null;
  const bare = name.replace(/^#/, '');
  return isSpace ? `#${bare}` : bare;
}

/**
 * Exported for the pinned card's People row — same surface, second anchor.
 *
 * `variant`: `'full'` (default, the top-bar popover's own shape, board 26
 * panels 1 and 3): for an owner, "Invite to #name" first (the field, its
 * suggestions in the flow, the role and Send), then a divider and "In this
 * space · N", the members and pending invites, the popover's one scroll
 * region. Everyone else sees only the members. `'compact'` (the space
 * panel's People row) shows only the member list; invite management collapses
 * into a single "Invite people" pill that expands the same invite form in
 * place, so the row doesn't default to showing a full form nobody asked for.
 */
export function RigSharePopoverContent({
  root,
  name,
  variant = 'full',
  isSpace = false,
}: {
  root: string;
  name: string | null;
  variant?: 'full' | 'compact';
  /** A space is named with `#`. */
  isSpace?: boolean;
}) {
  const queryClient = useQueryClient();
  const [enablingSync, setEnablingSync] = useState(false);
  const [enableSyncError, setEnableSyncError] = useState<string | null>(null);

  const authQuery = useQuery({
    queryKey: ['rig', 'auth', 'status'],
    queryFn: () => rpc.rig.auth.status(),
  });
  const signedIn = authQuery.data?.signedIn ?? false;

  const membersKey = ['rig', 'share', 'members', root] as const;
  const membersQuery = useQuery({
    queryKey: membersKey,
    queryFn: () => rpc.rig.share.members({ root }),
    enabled: signedIn,
  });

  const { signIn, phase: signInPhase } = useRigSignIn(() => {
    void queryClient.invalidateQueries({ queryKey: membersKey });
  });

  const membersError = membersQuery.data && !membersQuery.data.success ? membersQuery.data.error : null;
  const phase = deriveSharePopoverPhase({
    authLoading: authQuery.isLoading,
    signedIn,
    membersError,
  });

  if (phase.kind === 'loading') return null;

  if (phase.kind === 'signedOut') {
    return (
      <div className="flex flex-col gap-2 p-3">
        <p className="text-text-muted text-xs">Sign in to Rig to share this rig.</p>
        <Button variant="outline" size="xs" onClick={() => void signIn()} disabled={signInPhase !== 'idle'}>
          {signInPhase === 'idle' ? 'Sign in to share' : 'Waiting for sign-in…'}
        </Button>
      </div>
    );
  }

  // Local-only: signed in, but this workspace has no relay binding yet
  // (`rig.share.members` answers `notBound`). Enabling sync HERE, on this
  // click, is the consent the onboarding spec asks for — no separate
  // toggle, no new screen. A success just re-fetches `members`, which then
  // finds the fresh binding and falls through to the normal owner/invite
  // rendering below.
  if (phase.kind === 'localOnly') {
    const turnOnSync = async () => {
      setEnablingSync(true);
      setEnableSyncError(null);
      const result = await rpc.rig.create.enableSync({ dir: root });
      setEnablingSync(false);
      if (!result.success) {
        setEnableSyncError(result.error.message);
        return;
      }
      void queryClient.invalidateQueries({ queryKey: membersKey });
    };

    return (
      <div className="flex flex-col gap-2 p-3">
        <p className="text-text-muted text-xs">Sharing turns on sync for this rig.</p>
        {enableSyncError && <p className="text-danger text-xs">{enableSyncError}</p>}
        <Button size="xs" onClick={() => void turnOnSync()} disabled={enablingSync}>
          {enablingSync ? 'Turning on…' : 'Share'}
        </Button>
      </div>
    );
  }

  if (phase.kind === 'offline' || phase.kind === 'error') {
    return (
      <p className={cn('text-text-muted p-3 text-xs', phase.kind === 'offline' && 'font-mono')}>
        {phase.kind === 'offline' ? 'offline · members unavailable' : phase.message}
      </p>
    );
  }

  const memberList = membersQuery.data?.success ? membersQuery.data.data : null;
  if (!memberList) return <p className="text-text-muted p-3 text-xs">Loading…</p>;

  // Owner-only per the relay's own gating — but when the role could NOT be
  // derived (`selfRole: null`, e.g. the self-identity read failed) the
  // section shows anyway and the relay's 403 speaks through the error
  // surface below: server enforcement is the truth, and hiding management
  // UI on a broken client-side guess is the worse failure.
  const showInvites = memberList.selfRole === 'owner' || memberList.selfRole === null;

  const label = placeLabel(name, isSpace);
  const inviteTitle = label ? `Invite to ${label}` : 'Invite people';

  if (variant === 'compact') {
    return (
      <CompactSharePanel
        root={root}
        name={label}
        inviteTitle={inviteTitle}
        memberList={memberList}
        showInvites={showInvites}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* Invite and member management are owner-only ON THE RELAY (403
          `forbidden` for an editor), hidden only when the caller is
          POSITIVELY known to be a non-owner; see `showInvites` above. */}
      {showInvites && (
        <>
          <InviteByName root={root} title={inviteTitle} currentMembers={memberList.members} />
          <div className="bg-border-hairline -mx-4 h-px" />
        </>
      )}
      <div className="flex flex-col gap-1">
        <p className="flex h-6 items-center text-2xs text-text-muted" data-testid="members-label">
          {`${isSpace ? 'In this space' : 'People'} · ${memberList.members.length}`}
        </p>
        <MemberList root={root} spaceName={label} memberList={memberList} canManage={showInvites} />
      </div>
    </div>
  );
}

/**
 * `variant: 'compact'`'s own shape: just the people (the panel's h-7 row
 * grammar), plus one pill that expands the full invite form in place. No
 * header (the space panel's own row already says who this is).
 */
function CompactSharePanel({
  root,
  name,
  inviteTitle,
  memberList,
  showInvites,
}: {
  root: string;
  name: string | null;
  inviteTitle: string;
  memberList: RigMemberList;
  showInvites: boolean;
}) {
  const [inviting, setInviting] = useState(false);
  return (
    <div className="flex flex-col">
      <MemberList root={root} spaceName={name} memberList={memberList} canManage={showInvites} compact />
      {showInvites &&
        (inviting ? (
          <div className="mt-2 border-t border-border-hairline px-2 pt-3">
            <InviteByName root={root} title={inviteTitle} currentMembers={memberList.members} compact />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setInviting(true)}
            className="text-text-muted hover:text-text-primary flex h-7 shrink-0 items-center gap-2 pr-2 pl-8 text-left text-xs transition-colors"
          >
            <span className="grid size-4 shrink-0 place-items-center">
              <UserPlus className="size-3.5" strokeWidth={1.5} />
            </span>
            Invite people
          </button>
        ))}
    </div>
  );
}
