import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { relativeTime } from '@renderer/features/chat/session-history';
import {
  NOTIFICATION_ACTIVITY_KEY,
  NOTIFICATION_SUMMARY_KEY,
  useActivity,
} from '@renderer/features/notifications/use-notifications';
import { MY_INVITES_KEY_PREFIX, myInvitesQueryKey, shapeMyInvites } from '@renderer/features/shell/invites-inbox';
import { approveOption } from '@renderer/features/spaces/approval-options';
import { roomTextMessage } from '@renderer/features/spaces/room-send';
import { rpc } from '@renderer/lib/ipc';
import { markJustAttachedSyncing } from '@renderer/lib/just-attached';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { cn } from '@renderer/lib/utils';
import type { RigSpaceStatus } from '@shared/rig/space-status';
import type { HomeRigRow } from './home-sections';
import { HomeFeedLabel } from './home-feed-label';
import {
  contextLine,
  deriveWaitingItems,
  doneLine,
  pendingRequestOf,
  waitingAction,
  type PendingRequest,
  type WaitingAction,
  type WaitingItem,
} from './waiting-on-you';

/** How long a done item stays, faded, before it clears. */
const DONE_LINGER_MS = 4_000;

/**
 * "Waiting on you" (Home "lighter pass"): under Ask, above "Across your
 * spaces today". Only direct, unread things, each with its quote, the
 * message before it as context, and one action (`waiting-on-you.ts`):
 * Reply inline through the Room's own send (`roomTextMessage`), Accept an
 * invite, Approve your own agent's request from this computer's copy of the
 * run, or Open the space. A done item fades with a line saying so, then
 * clears. With nothing waiting, one line says so.
 */
export function WaitingOnYouSection({
  spaceRows,
  statusByBinding,
  selfUserId,
  onOpenPath,
}: {
  spaceRows: readonly HomeRigRow[];
  statusByBinding: ReadonlyMap<string, RigSpaceStatus>;
  selfUserId: string | null;
  onOpenPath: (path: string) => void;
}) {
  const queryClient = useQueryClient();
  const activity = useActivity(selfUserId !== null);
  const invitesQuery = useQuery({
    queryKey: myInvitesQueryKey(selfUserId),
    queryFn: () => rpc.rig.share.listMyInvites(),
    enabled: selfUserId !== null,
  });
  const invites = invitesQuery.data?.success ? shapeMyInvites(invitesQuery.data.data.invites) : [];
  const items = deriveWaitingItems({
    activity,
    invites,
    spaces: spaceRows,
    statusByBinding,
    selfUserId,
  });

  // Your agents' approvals, read from this computer's own copy of each run.
  const approvals = items.filter((i): i is Extract<WaitingItem, { kind: 'approval' }> => i.kind === 'approval');
  const localRuns = useQueries({
    queries: approvals.map((item) => ({
      queryKey: ['rig', 'spacesDispatch', 'localRunEvents', item.runId],
      queryFn: () => rpc.rig.spacesDispatch.localRunEvents({ runId: item.runId }),
      staleTime: 2_000,
    })),
  });
  const pendingByRun = new Map(
    approvals.map((item, i) => [item.runId, pendingRequestOf(localRuns[i]?.data?.events ?? null)])
  );

  // The message before each quoted one, as context.
  const replies = items.filter(
    (i): i is Extract<WaitingItem, { kind: 'reply' }> => i.kind === 'reply' && i.messageSeq !== null
  );
  const previous = useQueries({
    queries: replies.map((item) => ({
      queryKey: ['rig', 'spacesConnection', 'messageBefore', item.bindingId, item.messageSeq],
      queryFn: () =>
        rpc.rig.spacesConnection.listMessages({
          bindingId: item.bindingId,
          query: { before: String(item.messageSeq), latest: 1 },
        }),
      staleTime: Infinity,
    })),
  });
  const contextByKey = new Map(
    replies.map((item, i) => {
      const result = previous[i]?.data;
      const prev = result?.success ? (result.data[result.data.length - 1] ?? null) : null;
      return [item.key, contextLine(prev ? { authorName: prev.author.name, body: prev.body } : null)];
    })
  );

  // Done items stay, faded, for a moment, then clear for this visit.
  const [done, setDone] = useState<ReadonlyMap<string, { item: WaitingItem; line: string }>>(new Map());
  const [cleared, setCleared] = useState<ReadonlySet<string>>(new Set());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const live = timers.current;
    return () => live.forEach(clearTimeout);
  }, []);
  const doneKeyOf = (item: WaitingItem) =>
    item.kind === 'approval' ? `${item.key}:${pendingByRun.get(item.runId)?.requestId ?? ''}` : item.key;
  const finish = (item: WaitingItem) => {
    const key = doneKeyOf(item);
    setDone((current) => new Map(current).set(key, { item, line: doneLine(item) }));
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setCleared((current) => new Set(current).add(key));
      setDone((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
    }, DONE_LINGER_MS);
    timers.current.add(timer);
  };

  const open = items.filter((i) => !done.has(doneKeyOf(i)) && !cleared.has(doneKeyOf(i)));
  const shown = [
    ...open.map((item) => ({ item, line: null as string | null })),
    ...[...done.values()],
  ].sort((a, b) => b.item.at.localeCompare(a.item.at));

  const pathOf = (bindingId: string) => {
    const row = spaceRows.find((r) => r.bindingId === bindingId);
    return row?.kind === 'local' ? row.path : (row?.localPath ?? null);
  };
  const refreshInbox = () => {
    void queryClient.invalidateQueries({ queryKey: NOTIFICATION_ACTIVITY_KEY });
    void queryClient.invalidateQueries({ queryKey: NOTIFICATION_SUMMARY_KEY });
  };
  const markRead = async (notificationId: string) => {
    await rpc.rig.notifications.markRead({ ids: [notificationId] }).catch(() => null);
    refreshInbox();
  };

  return (
    <section className="flex flex-col gap-1.5" data-testid="waiting-on-you">
      <div className="pb-1">
        <HomeFeedLabel aside={open.length > 0 ? <WaitingCount count={open.length} /> : undefined}>
          Waiting on you
        </HomeFeedLabel>
      </div>
      {shown.length === 0 ? (
        <p className="text-text-muted py-0.5 text-sm" data-testid="waiting-empty">
          Nothing&rsquo;s waiting on you.
        </p>
      ) : (
        <div className="border-border-hairline bg-bg-1 divide-border-hairline divide-y overflow-hidden rounded-[14px] border shadow-[0_1px_2px_rgba(22,24,29,.04)]">
          {shown.map(({ item, line }) => (
            <WaitingRow
              key={item.key}
              item={item}
              context={contextByKey.get(item.key) ?? null}
              pending={item.kind === 'approval' ? (pendingByRun.get(item.runId) ?? null) : null}
              doneText={line}
              spacePath={pathOf(item.bindingId)}
              onOpenPath={onOpenPath}
              onMarkRead={markRead}
              onDone={() => finish(item)}
              onInvitesChanged={() => {
                void queryClient.invalidateQueries({ queryKey: MY_INVITES_KEY_PREFIX });
                void queryClient.invalidateQueries({ queryKey: ['rig', 'account'] });
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function WaitingCount({ count }: { count: number }) {
  return (
    <span className="bg-accent text-accent-ink inline-flex h-4 min-w-[18px] items-center justify-center rounded-full px-[5px] font-sans text-2xs font-medium">
      {count}
    </span>
  );
}

function WaitingRow({
  item,
  context,
  pending,
  doneText,
  spacePath,
  onOpenPath,
  onMarkRead,
  onDone,
  onInvitesChanged,
}: {
  item: WaitingItem;
  context: string | null;
  pending: PendingRequest | null;
  /** Set once its action went through: the row fades and says so. */
  doneText: string | null;
  spacePath: string | null;
  onOpenPath: (path: string) => void;
  onMarkRead: (notificationId: string) => Promise<void>;
  onDone: () => void;
  onInvitesChanged: () => void;
}) {
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const approve = pending ? approveOption(pending.options) : undefined;
  const action: WaitingAction = waitingAction(item, { approvable: !!approve });
  const done = doneText !== null;
  // Open needs the space's folder on this computer; without it there's nothing to press.
  const canAct = action !== 'Open' || spacePath !== null;

  useEffect(() => {
    if (replying) inputRef.current?.focus();
  }, [replying]);

  const run = async (work: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    try {
      const failure = await work();
      if (failure) setError(failure);
      else onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not go through.');
    } finally {
      setBusy(false);
    }
  };

  const sendReply = () => {
    if (item.kind !== 'reply' || !item.messageId) return;
    const text = draft.trim();
    if (!text || busy) return;
    void run(async () => {
      const result = await rpc.rig.spacesConnection.postMessage({
        bindingId: item.bindingId,
        ...roomTextMessage(text, {
          id: item.messageId!,
          authorId: item.who.userId ?? '',
          label: item.who.name,
          excerpt: excerpt(item.quote),
        }),
      });
      if (!result.success) return "Your reply didn't send. Try again.";
      setReplying(false);
      setDraft('');
      await onMarkRead(item.notificationId);
      return null;
    });
  };

  const onAction = () => {
    if (action === 'Reply') {
      setReplying(true);
      return;
    }
    if (action === 'Open') {
      if (!spacePath) return;
      if (item.kind === 'reply') void onMarkRead(item.notificationId);
      onOpenPath(spacePath);
      return;
    }
    if (action === 'Accept' && item.kind === 'invite') {
      void run(async () => {
        const accepted = await rpc.rig.share.acceptMyInvite({ id: item.inviteId });
        if (!accepted.success) return accepted.error.message;
        onInvitesChanged();
        const attached = await rpc.rig.join.attach({ bindingId: item.bindingId });
        if (attached.success) markJustAttachedSyncing(attached.data.localPath, attached.data.syncing);
        return null;
      });
      return;
    }
    if (action === 'Approve' && item.kind === 'approval' && pending && approve) {
      void run(async () => {
        const answer = await rpc.rig.spacesDispatch.resolvePermission({
          runId: item.runId,
          requestId: pending.requestId,
          optionId: approve.optionId,
        });
        return answer.resolved ? null : "Your answer didn't reach your agent. Try again.";
      });
    }
  };

  const quote = item.kind === 'reply' ? item.quote : item.kind === 'approval' ? (pending?.title ?? item.title) : null;
  const ctx =
    item.kind === 'reply'
      ? context
      : item.kind === 'invite'
        ? 'Accept to join it and set it up on this computer.'
        : null;

  return (
    <div
      className={cn(
        'relative grid grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-3.5 py-3 transition-opacity',
        done
          ? 'opacity-60'
          : "bg-accent/5 before:bg-accent before:absolute before:top-3 before:bottom-3 before:-left-px before:w-[3px] before:rounded-full before:content-['']"
      )}
      data-testid="waiting-item"
      data-kind={item.kind}
      data-done={done || undefined}
    >
      {item.kind === 'approval' ? (
        <span className="bg-bg-2 text-text-secondary flex size-7 items-center justify-center rounded-full">
          <Bot className="size-3.5" strokeWidth={1.5} />
        </span>
      ) : (
        <IdentityAvatar name={item.who.name} avatarUrl={null} sizeClassName="size-7" textClassName="text-2xs" />
      )}
      <div className="min-w-0 text-sm">
        <p className="min-w-0">
          {item.kind === 'approval' ? (
            <>
              <span className="font-semibold">Your {item.agent}</span>{' '}
              <span className="text-text-secondary">
                is waiting for your approval in <span className="text-text-muted font-mono">#</span>
                {item.spaceName}
              </span>
            </>
          ) : (
            <>
              <span className="font-semibold">{item.who.name}</span>{' '}
              <span className="text-text-secondary">
                {item.kind === 'invite' ? 'invited you to' : item.verb}{' '}
                <span className="text-text-muted font-mono">#</span>
                {item.spaceName}
              </span>
            </>
          )}
          <span className="text-text-muted ml-1.5 font-mono text-2xs whitespace-nowrap">
            {relativeTime(Date.parse(item.at), Date.now())}
          </span>
        </p>
        {quote && (
          <p className="text-text-prose border-border-hairline mt-1 border-l-2 pl-2.5 whitespace-pre-wrap" data-testid="waiting-quote">
            {quote}
          </p>
        )}
        {ctx && (
          <p className="text-text-muted mt-1 text-xs" data-testid="waiting-context">
            {ctx}
          </p>
        )}
      </div>
      <div className="flex justify-end">
        {!done && canAct && !replying && (
          <button
            type="button"
            onClick={onAction}
            disabled={busy}
            className="bg-accent text-accent-ink h-7 rounded-control px-3 text-xs font-medium whitespace-nowrap transition-[filter] hover:brightness-105 disabled:opacity-60"
          >
            {busy ? workingLabel(action) : action}
          </button>
        )}
      </div>
      {replying && !done && (
        <form
          className="col-span-2 col-start-2 mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            sendReply();
          }}
        >
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setReplying(false);
            }}
            disabled={busy}
            placeholder={item.kind === 'reply' ? `Reply to ${item.who.name.split(/\s+/)[0]} in #${item.spaceName}` : undefined}
            aria-label="Reply"
            className="border-border-hairline bg-bg-1 focus:border-accent text-text-primary placeholder:text-text-muted h-[30px] min-w-0 flex-1 rounded-control border px-2.5 text-sm outline-none transition-colors"
          />
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            className="bg-accent text-accent-ink flex h-[30px] items-center gap-1.5 rounded-control px-3 text-xs font-medium transition-[filter] hover:brightness-105 disabled:opacity-60"
          >
            <Send className="size-3" strokeWidth={1.5} />
            {busy ? 'Sending…' : 'Send'}
          </button>
        </form>
      )}
      {done && (
        <p className="text-success col-span-2 col-start-2 text-xs" data-testid="waiting-done">
          {doneText}
        </p>
      )}
      {error && !done && (
        <p className="text-danger col-span-2 col-start-2 text-xs" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function workingLabel(action: WaitingAction): string {
  return action === 'Accept' ? 'Joining…' : action === 'Approve' ? 'Approving…' : 'Working…';
}

function excerpt(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
