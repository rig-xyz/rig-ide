import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { relativeTime } from '@renderer/features/chat/session-history';
import { InviteRow } from '@renderer/features/shell/invites-bell';
import { deriveBellState, emptyInvitesMessage, myInvitesQueryKey, shapeMyInvites } from '@renderer/features/shell/invites-inbox';
import { events, rpc } from '@renderer/lib/ipc';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { Popover } from '@renderer/lib/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import {
  openTargetOf,
  rigOpenInvitesChannel,
  type OpenSpaceAt,
  type RigNotification,
} from '@shared/rig/notifications';
import type { RigMyInvite } from '@shared/rig/rig-share';
import { NOTIFICATION_ACTIVITY_KEY, NOTIFICATION_SUMMARY_KEY, useNotificationSummary } from './use-notifications';

/**
 * The topbar Activity bell — `invites-bell.tsx`'s replacement
 * (`notifications-spec.md` §5, "Activity list"). Pending invites still come
 * first, unchanged (same relay calls, same post-accept "Set up locally"),
 * with a new Activity section underneath: direct notifications — mentions,
 * replies, your agents' news, requests — newest first, from
 * `rpc.rig.notifications.activity`.
 *
 * Invite rows are `invites-bell.tsx`'s own `InviteRow`; the data comes from
 * the same helpers the old invites bell polled with (`invites-inbox.ts`):
 * focus refetch plus a slow 5-minute interval, under an account-scoped key.
 *
 * The bell's count is pending invites plus `summary.directUnreadTotal` —
 * the same count the Dock badge and the rail's red numbers use
 * (`space-unread-marker.ts`), so every surface agrees.
 */

const POLL_INTERVAL_MS = 5 * 60_000;

export function ActivityBell({
  onOpenPath,
  onOpenTarget,
}: {
  onOpenPath: (path: string) => void;
  /** Where a non-invite Activity row's target opens — the Room, scrolled to it. */
  onOpenTarget: (target: OpenSpaceAt) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const authQuery = useQuery({
    queryKey: ['rig', 'auth', 'status'],
    queryFn: () => rpc.rig.auth.status(),
  });
  const signedIn = authQuery.data?.signedIn ?? false;

  const meQuery = useQuery({
    queryKey: ['rig', 'account', 'me'],
    queryFn: () => rpc.rig.account.me(),
    enabled: signedIn,
  });
  const me = meQuery.data?.success ? meQuery.data.data : null;
  const accountId = me?.id ?? null;

  const invitesQuery = useQuery({
    queryKey: myInvitesQueryKey(accountId),
    queryFn: () => rpc.rig.share.listMyInvites(),
    enabled: signedIn,
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
  const invites = invitesQuery.data?.success ? invitesQuery.data.data.invites : null;

  const summary = useNotificationSummary();

  const activityQuery = useQuery({
    queryKey: NOTIFICATION_ACTIVITY_KEY,
    queryFn: () => rpc.rig.notifications.activity({ limit: 50 }),
    enabled: signedIn,
    // Main pushes a change event (`rigNotificationsChangedChannel`) that
    // invalidates this key app-wide (`use-notifications.ts`), so there's
    // nothing more to poll for here.
    staleTime: Infinity,
  });
  const activity = activityQuery.data?.success ? activityQuery.data.data : null;

  // A banner click for an invite focuses the window and asks the bell to
  // show its invite list rather than trying to open a space that doesn't
  // exist yet for the invitee.
  useEffect(() => events.on(rigOpenInvitesChannel, () => setOpen(true)), []);

  // Reuses `deriveBellState` for the signed-out carve-out only — its count
  // here is pending invites plus direct unread, not invites alone, so the
  // real total isn't hidden behind the invites fetch still being in flight.
  // `directUnreadTotal` already counts unread invite rows; pending invites
  // are counted from the invite list instead, so take those rows back out.
  const bell = deriveBellState(
    signedIn,
    (invites?.length ?? 0) + summary.directUnreadTotal - summary.invitesUnread
  );
  if (!bell.visible) return null;

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              ref={triggerRef}
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-label={bell.count > 0 ? `Activity (${bell.count})` : 'Activity'}
              aria-haspopup="true"
              aria-expanded={open}
              className="text-text-secondary hover:bg-bg-2 hover:text-text-primary rounded-control relative flex size-7 items-center justify-center transition-colors"
            >
              <Bell size={15} strokeWidth={1.5} />
              {bell.count > 0 && (
                <span className="bg-accent text-accent-ink absolute top-0.5 right-0.5 flex min-w-3.5 items-center justify-center rounded-full px-0.5 text-2xs leading-3.5 font-medium">
                  {bell.count}
                </span>
              )}
            </button>
          }
        />
        <TooltipContent side="bottom">Activity</TooltipContent>
      </Tooltip>

      <Popover
        anchor={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        role="dialog"
        align="right"
        gap={6}
        estimatedWidth={340}
        minWidth={320}
        ariaLabel="Activity"
      >
        <div className="flex max-h-[70vh] flex-col overflow-y-auto">
          <InvitesSection
            invites={invites}
            error={invitesQuery.isError || invitesQuery.data?.success === false}
            email={me?.email ?? null}
            onOpenPath={onOpenPath}
            onClose={() => setOpen(false)}
          />
          <ActivitySection
            activity={activity}
            error={activityQuery.isError || activityQuery.data?.success === false}
            directUnreadTotal={summary.directUnreadTotal}
            onOpenTarget={(target) => {
              setOpen(false);
              onOpenTarget(target);
            }}
          />
        </div>
      </Popover>
    </>
  );
}

const SECTION_LABEL_TEXT = 'font-mono text-xs tracking-wide text-text-muted uppercase';

// ── Invites (unchanged behaviour, see this file's own header comment) ──────

function InvitesSection({
  invites,
  error,
  email,
  onOpenPath,
  onClose,
}: {
  invites: RigMyInvite[] | null;
  error: boolean;
  /** Who the invite search ran for, named in the empty line (an invite sent to another address is the usual "where is it"). */
  email: string | null;
  onOpenPath: (path: string) => void;
  onClose: () => void;
}) {
  if (invites === null) {
    // Loading, or the fetch failed — only worth a line when it actually
    // failed; a brief loading flash isn't.
    return error ? <p className="text-danger px-3 py-2 text-xs">Could not load your invites.</p> : null;
  }
  const rows = shapeMyInvites(invites);
  if (rows.length === 0) {
    return <p className="text-text-muted border-border-hairline border-b px-3.5 py-2 text-xs">{emptyInvitesMessage(email)}</p>;
  }
  return (
    <div className="border-border-hairline flex flex-col gap-1 border-b p-2 pb-2.5">
      <p className={cn('px-1.5 pb-0.5', SECTION_LABEL_TEXT)}>Invites</p>
      {rows.map((row) => (
        <InviteRow key={row.id} row={row} onOpenPath={onOpenPath} onClose={onClose} />
      ))}
    </div>
  );
}

// ── Activity: direct notifications, newest first ───────────────────────────

function ActivitySection({
  activity,
  error,
  directUnreadTotal,
  onOpenTarget,
}: {
  activity: RigNotification[] | null;
  error: boolean;
  directUnreadTotal: number;
  onOpenTarget: (target: OpenSpaceAt) => void;
}) {
  const queryClient = useQueryClient();

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: NOTIFICATION_ACTIVITY_KEY });
    void queryClient.invalidateQueries({ queryKey: NOTIFICATION_SUMMARY_KEY });
  };

  const markAllRead = async () => {
    await rpc.rig.notifications.markRead({ all: true });
    invalidate();
  };

  const openRow = async (row: RigNotification) => {
    await rpc.rig.notifications.markRead({ ids: [row.id] });
    invalidate();
    const target = openTargetOf(row);
    // An invite row has no space to open — leave the popover up so the
    // Invites section above stays reachable for Accept/Decline.
    if (target) onOpenTarget(target);
  };

  return (
    <div className="flex flex-col gap-1 p-2">
      <div className="flex items-center justify-between gap-2 px-1.5 pb-0.5">
        <p className={SECTION_LABEL_TEXT}>Activity</p>
        <button
          type="button"
          onClick={() => void markAllRead()}
          disabled={directUnreadTotal === 0}
          className="text-accent shrink-0 text-xs transition-opacity hover:opacity-80 disabled:pointer-events-none disabled:opacity-40"
        >
          Mark all as read
        </button>
      </div>
      {activity === null ? (
        <p className="text-text-muted px-1.5 py-2 text-xs">{error ? 'Could not load activity.' : 'Loading…'}</p>
      ) : activity.length === 0 ? (
        <p className="text-text-muted px-1.5 py-2 text-xs">
          Nothing new. Mentions, replies and your agents' news show up here.
        </p>
      ) : (
        activity.map((row) => <ActivityRow key={row.id} row={row} onOpen={() => void openRow(row)} />)
      )}
    </div>
  );
}

function ActivityRow({ row, onOpen }: { row: RigNotification; onOpen: () => void }) {
  const unread = !row.readAt;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="hover:bg-bg-2 flex items-start gap-2 rounded-control px-1.5 py-1.5 text-left transition-colors"
    >
      <IdentityAvatar
        name={row.actor.name}
        avatarUrl={null}
        sizeClassName="size-6"
        textClassName="text-2xs"
        className="mt-0.5 shrink-0"
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-start gap-1.5">
          <span
            className={cn(
              // Two lines: the title says who, what and where, and "where" comes last.
              'min-w-0 flex-1 line-clamp-2 text-xs',
              unread ? 'text-text-primary font-medium' : 'text-text-secondary'
            )}
          >
            {row.title}
          </span>
          <span className="text-text-muted shrink-0 font-mono text-2xs">
            {relativeTime(Date.parse(row.createdAt), Date.now())}
          </span>
        </span>
        {row.body && <span className="text-text-muted block truncate text-xs">{row.body}</span>}
      </span>
      {unread && <span aria-hidden="true" className="bg-accent mt-1.5 size-1.5 shrink-0 rounded-full" />}
    </button>
  );
}
