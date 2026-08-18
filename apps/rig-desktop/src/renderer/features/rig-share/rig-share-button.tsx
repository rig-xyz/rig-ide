import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Share2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { relativeTime } from '@renderer/features/chat/session-history';
import { isOfflineError } from '@renderer/features/docs/comments/comments-cache';
import { useRigSignIn } from '@renderer/features/rig-account/use-rig-sign-in';
import { useAnchorRect } from '@renderer/lib/hooks/use-anchor-rect';
import { useClipboard } from '@renderer/lib/hooks/use-clipboard';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { cn } from '@renderer/lib/utils';
import type { RigInviteMinted, RigInviteRole, RigMember } from '@shared/rig/rig-share';
import { deriveAvatarStack } from './avatar-stack';
import { mintedInviteMatchesRole, shapePendingInvites, suggestCollaborators } from './invite-state';

/**
 * The rig-level Share button in the file browser header: its trigger shows
 * who's on the rig (stacked member avatars, capped +N) next to the word
 * Share; the popover lists members, and — for the rig's owner — its pending
 * outgoing invites and an invite form. Portal/dismissal conventions follow
 * `share-popover.tsx` exactly (document-level mousedown/Escape, not
 * blur-to-dismiss: this popover has real interactive surface).
 *
 * Relay contract mirrored from the web hub's InviteModal (user plane,
 * `/v1/me/bindings/:bindingId/*` over the trust-gated PAT — see
 * `main/rig/rig-share.ts`): invite list/mint/revoke are owner-only on the
 * relay, so those sections only render when `selfRole === 'owner'`. The
 * user-plane mint sends NO email even for an email-constrained invite — the
 * minted link is the deliverable, and the UI says so rather than pretending
 * an email went out.
 */
export function RigShareButton({ root, name }: { root: string; name: string | null }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const rect = useAnchorRect(open, triggerRef, { gap: 6, estimatedHeight: 360, estimatedWidth: 320, align: 'right' });

  const membersQuery = useQuery({
    queryKey: ['rig', 'share', 'members', root],
    queryFn: () => rpc.rig.share.members({ root }),
    // The trigger's avatar stack wants this before the popover ever opens;
    // membership changes rarely, so a quiet minute of staleness is fine.
    staleTime: 60_000,
  });
  const memberList = membersQuery.data?.success ? membersQuery.data.data : null;

  useEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(false);
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popupRef.current?.contains(target)) return;
      dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const stack = deriveAvatarStack(memberList?.members ?? []);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        className="border-border-hairline text-text-secondary hover:bg-bg-2 hover:text-text-primary rounded-control flex shrink-0 items-center gap-1.5 border bg-transparent px-2 py-1 text-xs transition-colors"
      >
        {stack.visible.length > 0 ? (
          <span className="flex items-center">
            {stack.visible.map((member, index) => (
              <IdentityAvatar
                key={member.userId}
                name={member.name ?? member.email}
                avatarUrl={member.avatarUrl}
                sizeClassName="size-4"
                textClassName="text-[8px]"
                className={cn('ring-bg-1 ring-1', index > 0 && '-ml-1')}
              />
            ))}
            {stack.overflow > 0 && (
              <span className="bg-bg-2 text-text-muted ring-bg-1 -ml-1 flex size-4 shrink-0 items-center justify-center rounded-chip text-[8px] font-medium ring-1">
                +{stack.overflow}
              </span>
            )}
          </span>
        ) : (
          <Share2 className="size-3.5" strokeWidth={1.5} />
        )}
        Share
      </button>

      {open &&
        rect &&
        createPortal(
          <div
            ref={popupRef}
            style={{
              position: 'fixed',
              width: 320,
              maxHeight: rect.maxHeight,
              overflowY: 'auto',
              ...(rect.placement === 'below' ? { top: rect.top } : { bottom: rect.bottom }),
              ...(rect.align === 'left' ? { left: rect.left } : { right: rect.right }),
            }}
            className="border-border-hairline bg-bg-1 rounded-card shadow-soft z-50 overflow-hidden border"
          >
            <RigSharePopoverContent root={root} name={name} />
          </div>,
          document.body
        )}
    </>
  );
}

function RigSharePopoverContent({ root, name }: { root: string; name: string | null }) {
  const queryClient = useQueryClient();

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

  if (authQuery.isLoading) return null;

  if (!signedIn) {
    return (
      <div className="flex flex-col gap-2 p-3">
        <p className="text-text-muted text-xs">Sign in to Rig to see who's on this rig.</p>
        <Button variant="outline" size="xs" onClick={() => void signIn()} disabled={signInPhase !== 'idle'}>
          {signInPhase === 'idle' ? 'Sign in to Rig' : 'Waiting for sign-in…'}
        </Button>
      </div>
    );
  }

  const membersError = membersQuery.data && !membersQuery.data.success ? membersQuery.data.error : null;
  if (membersError) {
    const offline = isOfflineError(membersError);
    return (
      <p className={cn('text-text-muted p-3 text-xs', offline && 'font-mono')}>
        {offline ? 'offline · members unavailable' : membersError.message}
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

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-col gap-1">
        <p className="text-text-muted px-0.5 font-mono text-xs tracking-wide uppercase">
          {name ? `People on ${name}` : 'People'}
        </p>
        {memberList.members.map((member) => (
          <MemberRow key={member.userId} member={member} />
        ))}
      </div>
      {/* Invite management is owner-only ON THE RELAY (list/mint/revoke all
          answer 403 `forbidden` for an editor) — hidden only when the caller
          is POSITIVELY known to be a non-owner; see `showInvites` above. */}
      {showInvites && <InviteSection root={root} currentMembers={memberList.members} />}
    </div>
  );
}

function MemberRow({ member }: { member: RigMember }) {
  const display = member.name ?? member.email ?? member.userId;
  return (
    <div className="flex items-center gap-2 px-0.5 py-1">
      <IdentityAvatar
        name={member.name ?? member.email}
        avatarUrl={member.avatarUrl}
        sizeClassName="size-5"
        textClassName="text-[9px]"
      />
      <span className="text-text-primary min-w-0 flex-1 truncate text-xs">{display}</span>
      <span className="bg-bg-2 text-text-secondary rounded-chip shrink-0 px-1.5 py-0.5 font-mono text-xs">
        {member.role}
      </span>
    </div>
  );
}

function InviteSection({ root, currentMembers }: { root: string; currentMembers: RigMember[] }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [emailFocused, setEmailFocused] = useState(false);
  const [role, setRole] = useState<RigInviteRole>('editor');
  const [creating, setCreating] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [minted, setMinted] = useState<RigInviteMinted | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const invitesKey = ['rig', 'share', 'invites', root] as const;
  const invitesQuery = useQuery({
    queryKey: invitesKey,
    queryFn: () => rpc.rig.share.listInvites({ root }),
  });

  // People suggestions (Dylan's "a quick way to invite people he's already
  // worked with"): every rig the caller has, gathered once when the popover
  // opens — `workspaces` is the same account-plane read Home's rigs rail
  // already does, so this is usually a cache hit, not a fresh request.
  const workspacesQuery = useQuery({
    queryKey: ['rig', 'account', 'workspaces'],
    queryFn: () => rpc.rig.account.workspaces(),
  });
  const bindingIds = workspacesQuery.data?.success
    ? workspacesQuery.data.data.map((binding) => binding.id)
    : [];
  const collaboratorsQuery = useQuery({
    queryKey: ['rig', 'share', 'collaborators', ...bindingIds],
    queryFn: () => rpc.rig.share.collaborators({ bindingIds }),
    enabled: bindingIds.length > 0,
    staleTime: 60_000,
  });
  const collaborators = collaboratorsQuery.data?.success ? collaboratorsQuery.data.data : [];
  const currentMemberIds = new Set(currentMembers.map((member) => member.userId));
  const suggestions = suggestCollaborators(collaborators, currentMemberIds, email);

  const createInvite = async () => {
    setCreating(true);
    setInviteError(null);
    const result = await rpc.rig.share.createInvite({
      root,
      email: email.trim() ? email.trim() : null,
      role,
    });
    setCreating(false);
    if (!result.success) {
      setInviteError(result.error.message);
      return;
    }
    setMinted(result.data);
    setEmail('');
    void queryClient.invalidateQueries({ queryKey: invitesKey });
  };

  const revoke = async (id: string) => {
    setRevokingId(id);
    const result = await rpc.rig.share.revokeInvite({ root, id });
    setRevokingId(null);
    if (!result.success) {
      setInviteError(result.error.message);
      return;
    }
    void queryClient.invalidateQueries({ queryKey: invitesKey });
  };

  const pending = invitesQuery.data?.success
    ? shapePendingInvites(invitesQuery.data.data.invites, Date.now())
    : [];
  // The relay's own verdict on whether this caller may manage invites —
  // rendered as-is (a non-owner on the honest-degradation path sees the
  // 403's message here instead of a silently missing section).
  const listError =
    invitesQuery.data && !invitesQuery.data.success ? invitesQuery.data.error : null;

  // A minted link's role is fixed at mint time — the moment the toggle below
  // no longer matches what THIS link grants, stop showing it rather than let
  // a stale, now-wrong link sit on screen (`mintedInviteMatchesRole`'s own
  // doc comment has the reasoning for why this clears instead of re-minting).
  const displayedMinted = minted && mintedInviteMatchesRole(minted.invite.role, role) ? minted : null;

  return (
    <div className="border-border-hairline flex flex-col gap-2 border-t pt-2">
      <p className="text-text-muted px-0.5 font-mono text-xs tracking-wide uppercase">
        Invite someone
      </p>
      {/* One helper line, honest about both modes: with an email the invite
          is emailed AND locked to that account; without one it's an open
          link anyone can use. */}
      <p className="text-text-muted px-0.5 text-xs">
        Invite by email, and they get a link only their account can use. Leave it empty for an open
        link.
      </p>

      <div className="relative flex flex-col gap-1">
        <input
          type="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            // Typing resumes the suggestion list even right after picking
            // one (which hides it) — the field keeps focus across that
            // click (see the suggestion button's `onMouseDown` below), so
            // a plain `onFocus` re-check alone would never fire again.
            setEmailFocused(true);
          }}
          onFocus={() => setEmailFocused(true)}
          onBlur={() => setEmailFocused(false)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !creating) {
              event.preventDefault();
              void createInvite();
            }
          }}
          placeholder="email (optional)"
          className="border-border-hairline bg-bg-1 text-text-primary placeholder:text-text-muted rounded-control border px-2 py-1 text-xs outline-none"
        />
        {emailFocused && suggestions.length > 0 && (
          <div className="border-border-hairline bg-bg-1 rounded-control shadow-soft flex flex-col gap-0.5 border p-1">
            {suggestions.map((person) => (
              <button
                key={person.userId}
                type="button"
                onMouseDown={(event) => {
                  // Same trick the other pickers use — keeps the input
                  // focused so this click doesn't blur-and-hide the list
                  // before the click itself is handled.
                  event.preventDefault();
                  setEmail(person.email ?? '');
                  setEmailFocused(false);
                }}
                className="hover:bg-bg-2 rounded-control flex items-center gap-2 px-1.5 py-1 text-left transition-colors"
              >
                <IdentityAvatar
                  name={person.name ?? person.email}
                  avatarUrl={person.avatarUrl}
                  sizeClassName="size-5"
                  textClassName="text-[9px]"
                />
                <span className="min-w-0 flex-1">
                  <span className="text-text-primary block truncate text-xs">
                    {person.name ?? person.email}
                  </span>
                  {person.name && (
                    <span className="text-text-muted block truncate text-xs">{person.email}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="rounded-control border-border-hairline grid grid-cols-2 gap-1 border p-1">
        {(
          [
            ['editor', 'Can edit'],
            ['viewer', 'Can view'],
          ] as const
        ).map(([option, label]) => (
          <button
            key={option}
            type="button"
            onClick={() => setRole(option)}
            className={cn(
              'rounded-control px-2 py-1 text-xs transition-colors',
              role === option
                ? 'bg-bg-2 text-text-primary'
                : 'text-text-secondary hover:text-text-primary'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {listError && (
        <p className={cn('text-text-muted text-xs', isOfflineError(listError) && 'font-mono')}>
          {isOfflineError(listError) ? 'offline · invites unavailable' : listError.message}
        </p>
      )}
      {inviteError && <p className="text-danger text-xs">{inviteError}</p>}

      <Button size="sm" onClick={() => void createInvite()} disabled={creating}>
        {creating ? (email.trim() ? 'Sending…' : 'Creating…') : email.trim() ? 'Send invite' : 'Create link'}
      </Button>

      {displayedMinted && <MintedInvite minted={displayedMinted} />}

      {pending.length > 0 && (
        <div className="flex flex-col gap-1 pt-1">
          <p className="text-text-muted px-0.5 font-mono text-xs tracking-wide uppercase">
            Pending invites
          </p>
          {pending.map((invite) => (
            <div key={invite.id} className="flex items-center gap-2 px-0.5 py-1">
              <span className="text-text-secondary min-w-0 flex-1 truncate text-xs">
                {invite.email ?? 'Anyone with the link'}
              </span>
              <span className="bg-bg-2 text-text-secondary rounded-chip shrink-0 px-1.5 py-0.5 font-mono text-xs">
                {invite.roleLabel}
              </span>
              <span className="text-text-muted shrink-0 font-mono text-xs">
                {relativeTime(Date.parse(invite.createdAt), Date.now())}
              </span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => void revoke(invite.id)}
                disabled={revokingId === invite.id}
                className="shrink-0"
              >
                <X className="size-3" />
                {revokingId === invite.id ? 'Revoking…' : 'Revoke'}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The post-mint state — the one moment the secret-bearing link exists
 * client-side (the invites list never carries it again). `minted.url` is the
 * CANONICAL hub join page (`userig.xyz/join/<secret>`, the same URL the
 * relay's own invite email links — see `main/rig/rig-share.ts`). Leads with
 * what actually happened: the relay's `email.sent` verdict when an email
 * went out, an honest fallback line when it didn't.
 */
function MintedInvite({ minted }: { minted: RigInviteMinted }) {
  const clipboard = useClipboard();
  const constrainedTo = minted.invite.emailConstraint;
  return (
    <div className="flex flex-col gap-1">
      {minted.email.sent && minted.email.to && (
        <p className="text-text-secondary text-xs">Invite emailed to {minted.email.to}.</p>
      )}
      <div className="border-border-hairline bg-bg-2 flex items-center gap-2 rounded-control border px-2 py-1.5">
        <span className="text-text-secondary min-w-0 flex-1 truncate font-mono text-xs">
          {minted.url}
        </span>
        <button
          type="button"
          onClick={() => clipboard.copy(minted.url)}
          aria-label={clipboard.copied ? 'Copied' : 'Copy link'}
          className="text-text-muted hover:text-text-primary flex shrink-0 items-center gap-1 text-xs transition-colors"
        >
          {clipboard.copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {clipboard.copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {!minted.email.sent && (
        <p className="text-text-muted text-xs">
          {constrainedTo
            ? `Email couldn’t be sent. Copy the link and send it to ${constrainedTo} yourself; only they can use it.`
            : 'Anyone with this link can join, so send it to whoever you’re inviting.'}
        </p>
      )}
    </div>
  );
}
