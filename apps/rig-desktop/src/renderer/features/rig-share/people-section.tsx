import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Link2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { relativeTime } from '@renderer/features/chat/session-history';
import { isOfflineError } from '@renderer/features/docs/comments/comments-cache';
import { memberName } from '@renderer/features/people/people-state';
import { PEOPLE_LAYER_CLASS, PersonCardPopover } from '@renderer/features/people/person-card';
import { PEOPLE_QUERY_KEY } from '@renderer/features/people/use-people';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { Popover, PopoverMenuItem, PopoverSeparator } from '@renderer/lib/ui/popover';
import { cn } from '@renderer/lib/utils';
import type { RigInviteRole, RigMember, RigMemberList } from '@shared/rig/rig-share';
import { excludeInvitesToMembers, type PendingInvite, shapePendingInvites } from './invite-state';

/**
 * Who's in a space (board 26, panel 3): the members, and for the owner
 * their actions (Can edit, Can view, Make owner, Remove from space) plus the
 * pending invites with Resend and Revoke. Everyone else sees the same list
 * read only. A member's name or face opens their person card.
 */

export function roleLabel(role: string | null): string {
  if (role === 'owner') return 'Owner';
  if (role === 'editor') return 'Can edit';
  if (role === 'viewer') return 'Can view';
  return 'Link';
}

export const membersKey = (root: string) => ['rig', 'share', 'members', root] as const;
export const invitesKey = (root: string) => ['rig', 'share', 'invites', root] as const;

/** The owner's pending invites, minus any whose person already joined. Owner-only on the relay. */
export function usePendingInvites(root: string, members: RigMember[], enabled: boolean) {
  const query = useQuery({
    queryKey: invitesKey(root),
    queryFn: () => rpc.rig.share.listInvites({ root }),
    enabled,
  });
  const pending =
    enabled && query.data?.success
      ? excludeInvitesToMembers(shapePendingInvites(query.data.data.invites, Date.now()), members)
      : [];
  const error = enabled && query.data && !query.data.success ? query.data.error : null;
  return { pending, error };
}

/** Quieter than a member's name: muted, on a subtle fill. */
function RolePill({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-chip bg-bg-2 px-1.5 py-0.5 text-2xs text-text-muted">
      {children}
    </span>
  );
}

export function MemberList({
  root,
  spaceName,
  memberList,
  canManage,
  compact = false,
}: {
  root: string;
  spaceName: string | null;
  memberList: RigMemberList;
  /** The owner (or a caller whose role couldn't be read: the relay's 403 then answers). */
  canManage: boolean;
  compact?: boolean;
}) {
  const { pending, error } = usePendingInvites(root, memberList.members, canManage);
  return (
    <div
      className={cn(
        'flex flex-col',
        // The popover's one scroll region: about six rows, then it scrolls.
        !compact && '-mx-2 max-h-[216px] overflow-y-auto'
      )}
      data-testid="member-list"
    >
      {memberList.members.map((member) => (
        <MemberRow
          key={member.userId}
          root={root}
          spaceName={spaceName}
          member={member}
          isSelf={memberList.selfUserId === member.userId}
          canManage={canManage}
          compact={compact}
        />
      ))}
      {pending.map((invite) => (
        <PendingInviteRow key={invite.id} root={root} invite={invite} compact={compact} />
      ))}
      {error && (
        <p
          className={cn('text-text-muted px-2 py-1 text-xs', isOfflineError(error) && 'font-mono')}
        >
          {isOfflineError(error) ? 'offline · invites unavailable' : error.message}
        </p>
      )}
    </div>
  );
}

type Confirm = 'remove' | 'owner' | null;

function MemberRow({
  root,
  spaceName,
  member,
  isSelf,
  canManage,
  compact,
}: {
  root: string;
  spaceName: string | null;
  member: RigMember;
  isSelf: boolean;
  canManage: boolean;
  compact: boolean;
}) {
  const queryClient = useQueryClient();
  const personRef = useRef<HTMLButtonElement>(null);
  const roleRef = useRef<HTMLButtonElement>(null);
  const [cardOpen, setCardOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const name = memberName(member);
  const first = name.split(/\s+/)[0] ?? name;
  const manageable = canManage && !isSelf && member.role !== 'owner';

  const run = async (call: () => Promise<{ success: boolean; error?: { message: string } }>) => {
    setBusy(true);
    setError(null);
    const result = await call();
    setBusy(false);
    if (!result.success) {
      setError(result.error?.message ?? 'Something went wrong.');
      return;
    }
    setConfirm(null);
    void queryClient.invalidateQueries({ queryKey: membersKey(root) });
    void queryClient.invalidateQueries({ queryKey: PEOPLE_QUERY_KEY });
  };

  const setRole = (role: RigInviteRole) => {
    setMenuOpen(false);
    if (role === member.role) return;
    void run(() => rpc.rig.share.setMemberRole({ root, userId: member.userId, role }));
  };

  const avatarSize = compact ? 'size-4' : 'size-6';
  const identity = (
    <>
      <IdentityAvatar
        name={name}
        avatarUrl={member.avatarUrl}
        sizeClassName={avatarSize}
        textClassName="text-2xs"
      />
      <span className="min-w-0 truncate text-xs text-text-primary">{name}</span>
      {isSelf && <span className="shrink-0 text-2xs text-text-muted">You</span>}
    </>
  );

  return (
    <div className="flex flex-col">
      <div className={cn('flex items-center gap-2', compact ? 'h-7 pr-2 pl-8' : 'h-9 px-2')}>
        {isSelf ? (
          <span className="flex min-w-0 flex-1 items-center gap-2">{identity}</span>
        ) : (
          <button
            ref={personRef}
            type="button"
            onClick={() => setCardOpen((v) => !v)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left hover:underline"
            aria-label={`About ${name}`}
          >
            {identity}
          </button>
        )}
        {manageable ? (
          <button
            ref={roleRef}
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            disabled={busy}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`${roleLabel(member.role)}, change for ${name}`}
            className="flex shrink-0 items-center gap-0.5 rounded-chip bg-bg-2 px-1.5 py-0.5 text-2xs text-text-secondary transition-colors hover:text-text-primary"
          >
            {roleLabel(member.role)}
            <ChevronDown className="size-3" strokeWidth={1.5} />
          </button>
        ) : compact ? (
          <span className="shrink-0 text-2xs text-text-muted">{roleLabel(member.role)}</span>
        ) : (
          <RolePill>{roleLabel(member.role)}</RolePill>
        )}
      </div>

      {confirm && (
        <div className="bg-bg-2 rounded-control mx-2 mb-1 flex flex-col gap-2 p-2">
          <p className="text-xs text-text-secondary">
            {confirm === 'remove'
              ? `Remove ${name} from ${spaceName ?? 'this space'}? They lose access to its files and Room.`
              : `Make ${name} the owner of ${spaceName ?? 'this space'}? You become an editor, and ${first} manages who's in it.`}
          </p>
          <div className="flex gap-1.5">
            <Button
              size="xs"
              variant={confirm === 'remove' ? 'destructive' : 'default'}
              disabled={busy}
              onClick={() =>
                void run(() =>
                  confirm === 'remove'
                    ? rpc.rig.share.removeMember({ root, userId: member.userId })
                    : rpc.rig.share.makeOwner({ root, userId: member.userId })
                )
              }
            >
              {confirm === 'remove' ? 'Remove' : 'Make owner'}
            </Button>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p className={cn('text-danger pb-1 text-xs', compact ? 'px-8' : 'px-2')}>{error}</p>
      )}

      {manageable && (
        <Popover
          anchor={roleRef}
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          align="right"
          minWidth={170}
          estimatedWidth={170}
          ariaLabel={`Actions for ${name}`}
          className={PEOPLE_LAYER_CLASS}
        >
          <PopoverMenuItem
            role="menuitemradio"
            label="Can edit"
            selected={member.role === 'editor'}
            onSelect={() => setRole('editor')}
          />
          <PopoverMenuItem
            role="menuitemradio"
            label="Can view"
            selected={member.role === 'viewer'}
            onSelect={() => setRole('viewer')}
          />
          <PopoverSeparator />
          <PopoverMenuItem
            label="Make owner"
            onSelect={() => {
              setMenuOpen(false);
              setConfirm('owner');
            }}
          />
          <PopoverMenuItem
            label="Remove from space"
            danger
            onSelect={() => {
              setMenuOpen(false);
              setConfirm('remove');
            }}
          />
        </Popover>
      )}
      {!isSelf && (
        <PersonCardPopover
          person={{ userId: member.userId, name: member.name, avatarUrl: member.avatarUrl }}
          anchor={personRef}
          open={cardOpen}
          onClose={() => setCardOpen(false)}
        />
      )}
    </div>
  );
}

function inviteAge(createdAt: string): string {
  const age = relativeTime(Date.parse(createdAt), Date.now());
  return age === 'now' ? 'just now' : age;
}

function PendingInviteRow({
  root,
  invite,
  compact,
}: {
  root: string;
  invite: PendingInvite;
  compact: boolean;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<'resend' | 'revoke' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = invite.targetName ?? invite.email ?? 'Anyone with the link';
  const canResend = invite.targetUserId !== null || invite.email !== null;

  const refresh = () => void queryClient.invalidateQueries({ queryKey: invitesKey(root) });

  const revoke = async () => {
    setBusy('revoke');
    setError(null);
    const result = await rpc.rig.share.revokeInvite({ root, id: invite.id });
    setBusy(null);
    if (!result.success) setError(result.error.message);
    else refresh();
  };

  // Mint the new one first, so a failed resend never leaves them with nothing.
  const resend = async () => {
    setBusy('resend');
    setError(null);
    const minted = await rpc.rig.share.createInvite({
      root,
      email: invite.email,
      targetUserId: invite.targetUserId,
      role: invite.role === 'viewer' ? 'viewer' : 'editor',
    });
    if (!minted.success) {
      setBusy(null);
      setError(minted.error.message);
      return;
    }
    await rpc.rig.share.revokeInvite({ root, id: invite.id });
    setBusy(null);
    refresh();
  };

  return (
    <div className="flex flex-col" data-testid="pending-invite">
      <div className={cn('flex items-center gap-2', compact ? 'min-h-7 pr-2 pl-8' : 'min-h-9 px-2')}>
        {invite.targetUserId || invite.email ? (
          <IdentityAvatar
            name={label}
            avatarUrl={invite.targetAvatarUrl}
            sizeClassName={compact ? 'size-4' : 'size-6'}
            textClassName="text-2xs"
            className="opacity-70"
          />
        ) : (
          <Link2
            className={cn('text-text-muted shrink-0', compact ? 'size-4' : 'size-6 p-1')}
            strokeWidth={1.5}
          />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-xs text-text-secondary">{label}</span>
          <span className="truncate text-2xs text-text-muted">
            Invited {inviteAge(invite.createdAt)} · {roleLabel(invite.role)}
          </span>
        </span>
        {canResend && (
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void resend()}
          >
            {busy === 'resend' ? 'Resending…' : 'Resend'}
          </Button>
        )}
        <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => void revoke()}>
          {busy === 'revoke' ? 'Revoking…' : 'Revoke'}
        </Button>
      </div>
      {error && (
        <p className={cn('text-danger pb-1 text-xs', compact ? 'px-8' : 'px-2')}>{error}</p>
      )}
    </div>
  );
}
