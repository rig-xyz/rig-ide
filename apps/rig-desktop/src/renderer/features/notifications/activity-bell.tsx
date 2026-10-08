import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { relativeTime } from '@renderer/features/chat/session-history';
import { InviteRow } from '@renderer/features/shell/invites-bell';
import { deriveBellState, emptyInvitesMessage, myInvitesQueryKey, shapeMyInvites } from '@renderer/features/shell/invites-inbox';
import { events, rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
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
import { leftOutLine, shapeBell, type BellContext } from './bell-model';
import {
  NOTIFICATION_ACTIVITY_KEY,
  NOTIFICATION_AWAY_KEY,
  NOTIFICATION_SUMMARY_KEY,
  useNotificationPermission,
  useNotificationSummary,
  useRequestNotificationPermission,
} from './use-notifications';

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
 * The bell's count is the unread rows it keeps (`shapeBell`), and main
 * puts the same number on the Dock (`dockCount`, same rows, same rule).
 * Home's space rows fold the same rows into their status line ("Hugo
 * mentioned you"), so every surface agrees.
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
    queryFn: () => rpc.rig.notifications.activity({ limit: ACTIVITY_PAGE }),
    enabled: signedIn,
    // Main pushes a change event (`rigNotificationsChangedChannel`) that
    // invalidates this key app-wide (`use-notifications.ts`), so there's
    // nothing more to poll for here.
    staleTime: Infinity,
  });
  const activity = activityQuery.data?.success ? activityQuery.data.data : null;
  // Which rows came in while you were away: your own agents finishing then
  // stay in the bell, the ones you were here for don't (`bell-model.ts`).
  const awayQuery = useQuery({
    queryKey: NOTIFICATION_AWAY_KEY,
    queryFn: () => rpc.rig.notifications.arrivedWhileAway(),
    enabled: signedIn,
    staleTime: Infinity,
  });
  const bellCtx: BellContext = { selfUserId: accountId, awayIds: new Set(awayQuery.data ?? []) };

  // A banner click for an invite focuses the window and asks the bell to
  // show its invite list rather than trying to open a space that doesn't
  // exist yet for the invitee.
  useEffect(() => events.on(rigOpenInvitesChannel, () => setOpen(true)), []);

  // Reuses `deriveBellState` for the signed-out carve-out only. Its count is
  // the unread rows the bell keeps for you (`shapeBell`), invite rows
  // included; until they load, the summary's unread rows about you. A
  // pending invite you've already seen stays listed below, it just isn't
  // counted again.
  // The count is what the bell keeps for you, once its rows are in.
  const bell = deriveBellState(signedIn, activity ? shapeBell(activity, bellCtx).unread : summary.directUnreadTotal);
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
          <PermissionCard hasActivity={(activity?.length ?? 0) > 0} />
          <ActivitySection
            activity={activity}
            error={activityQuery.isError || activityQuery.data?.success === false}
            directUnreadTotal={summary.directUnreadTotal}
            ctx={bellCtx}
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

const ASK_DISMISSED_KEY = 'rig-notifications-ask-dismissed';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(ASK_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * macOS's side, where it matters (spec §5, onboarding; Dylan 2026-10-01:
 * ask when it first matters). Banners only show once macOS allows them,
 * and Electron never asks on its own:
 *   - never asked, and something about you has arrived: ask, in context,
 *     once (Not now is remembered on this computer);
 *   - turned off: say so, with rig's page in System Settings one click away;
 *   - Turn on pressed, and macOS still hasn't answered a few seconds later
 *     (it showed no prompt, as for an unsigned dev build): the same System
 *     Settings card, since asking again would do nothing.
 * Allowed, or not a Mac: nothing.
 */
export const NO_PROMPT_AFTER_MS = 3_000;

export function PermissionCard({ hasActivity, noPromptAfterMs = NO_PROMPT_AFTER_MS }: { hasActivity: boolean; noPromptAfterMs?: number }) {
  const permission = useNotificationPermission();
  const request = useRequestNotificationPermission();
  const [dismissed, setDismissed] = useState(readDismissed);
  const [askedLongAgo, setAskedLongAgo] = useState(false);
  const askTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (askTimer.current) clearTimeout(askTimer.current);
  }, []);
  const turnOn = () => {
    request();
    if (askTimer.current) clearTimeout(askTimer.current);
    askTimer.current = setTimeout(() => setAskedLongAgo(true), noPromptAfterMs);
  };
  const noPrompt = askedLongAgo && permission === 'notDetermined';

  if (permission === 'denied' || noPrompt) {
    return (
      <div className="border-border-hairline flex items-start gap-2 border-b px-3.5 py-2.5" data-testid="notification-permission-card">
        <BellOff className="text-text-muted mt-0.5 size-3.5 shrink-0" strokeWidth={1.5} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p className="text-text-primary text-xs">
            {noPrompt
              ? "macOS didn't ask about banners for rig. Turn them on in System Settings."
              : "Banners are off for rig in macOS, so you won't hear about these."}
          </p>
          <Button
            variant="outline"
            size="xs"
            className="self-start"
            onClick={() => void rpc.rig.notifications.openSystemSettings()}
          >
            Open System Settings
          </Button>
        </div>
      </div>
    );
  }
  if (permission !== 'notDetermined' || !hasActivity || dismissed) return null;
  const notNow = () => {
    setDismissed(true);
    try {
      localStorage.setItem(ASK_DISMISSED_KEY, '1');
    } catch {
      // not remembered: it asks again next time, which is fine
    }
  };
  return (
    <div className="border-border-hairline flex items-start gap-2 border-b px-3.5 py-2.5" data-testid="notification-permission-card">
      <Bell className="text-accent mt-0.5 size-3.5 shrink-0" strokeWidth={1.5} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="text-text-primary text-xs">Get a banner when someone needs you, even with rig in the background.</p>
        <div className="flex items-center gap-1">
          <Button size="xs" onClick={turnOn}>
            Turn on
          </Button>
          <Button variant="ghost" size="xs" onClick={notNow}>
            Not now
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Activity rows per page: the bell's first page and each "Show older". */
const ACTIVITY_PAGE = 50;

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
  ctx,
  onOpenTarget,
}: {
  activity: RigNotification[] | null;
  error: boolean;
  directUnreadTotal: number;
  ctx: BellContext;
  onOpenTarget: (target: OpenSpaceAt) => void;
}) {
  const queryClient = useQueryClient();
  // The latest page comes from the shared query; "Show older" pages back
  // with the relay's `before` cursor. Older pages are kept only while the
  // popover is open (this section unmounts with it).
  const [older, setOlder] = useState<RigNotification[]>([]);
  const [olderState, setOlderState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const rows = activity ? [...activity, ...older.filter((o) => !activity.some((a) => a.id === o.id))] : null;
  const canPage = activity !== null && activity.length >= ACTIVITY_PAGE && olderState !== 'done';
  const model = rows ? shapeBell(rows, ctx) : null;
  const footer = model ? leftOutLine(model.leftOut) : null;

  const loadOlder = async () => {
    const last = rows?.[rows.length - 1];
    if (!last) return;
    setOlderState('loading');
    const result = await rpc.rig.notifications.activity({ before: last.id, limit: ACTIVITY_PAGE }).catch(() => null);
    if (!result?.success) {
      setOlderState('error');
      return;
    }
    setOlder((current) => [...current, ...result.data]);
    setOlderState(result.data.length < ACTIVITY_PAGE ? 'done' : 'idle');
  };

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
      {model === null ? (
        <p className="text-text-muted px-1.5 py-2 text-xs">{error ? 'Could not load activity.' : 'Loading…'}</p>
      ) : model.groups.length === 0 ? (
        <p className="text-text-muted px-1.5 py-2 text-xs">
          Nothing new. Mentions, replies and your agents' news show up here.
        </p>
      ) : (
        model.groups.map((group) => (
          <div key={group.key} className="flex flex-col" data-testid="activity-group">
            <p className="text-text-secondary flex items-center gap-1 px-1.5 pt-1.5 pb-0.5 text-xs font-medium">
              <span className="text-text-muted font-mono">#</span>
              {group.spaceName ?? 'A space'}
            </p>
            {group.rows.map((row) => (
              <ActivityRow key={row.id} row={row} onOpen={() => void openRow(row)} />
            ))}
          </div>
        ))
      )}
      {canPage && (
        <button
          type="button"
          onClick={() => void loadOlder()}
          disabled={olderState === 'loading'}
          className="text-text-muted hover:text-text-primary self-start px-1.5 py-1 text-xs transition-colors disabled:opacity-50"
        >
          {olderState === 'loading' ? 'Loading…' : olderState === 'error' ? "Couldn't load. Try again" : 'Show older'}
        </button>
      )}
      {footer && (
        <p
          className="border-border-hairline text-text-muted -mx-2 mt-1 -mb-2 border-t px-3.5 pt-2 pb-2.5 text-xs leading-normal"
          data-testid="activity-left-out"
        >
          {footer}
        </p>
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
      className={cn(
        'hover:bg-bg-2 flex items-start gap-2 rounded-control px-1.5 py-1.5 text-left transition-colors',
        // An invite row has no space to open: it stays in place.
        openTargetOf(row) && 'cursor-pointer'
      )}
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
