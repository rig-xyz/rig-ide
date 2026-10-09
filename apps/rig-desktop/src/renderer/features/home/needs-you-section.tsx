import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { CornerDownRight } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  NOTIFICATION_ACTIVITY_KEY,
  NOTIFICATION_SUMMARY_KEY,
  useActivity,
} from '@renderer/features/notifications/use-notifications';
import { MY_INVITES_KEY_PREFIX, myInvitesQueryKey, shapeMyInvites } from '@renderer/features/shell/invites-inbox';
import { approveOption } from '@renderer/features/spaces/approval-options';
import { connectorsApi } from '@renderer/features/spaces/connectors-api';
import { ConnectorLogo } from '@renderer/features/spaces/logos';
import { AgentAvatar } from '@renderer/features/spaces/components/identity';
import { mentionAt } from '@renderer/features/spaces/message-tokens';
import type { RoomMember } from '@renderer/features/spaces/types';
import { roomTextMessage } from '@renderer/features/spaces/room-send';
import { rpc } from '@renderer/lib/ipc';
import { markJustAttachedSyncing } from '@renderer/lib/just-attached';
import { Button } from '@renderer/lib/ui/button';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { cn } from '@renderer/lib/utils';
import { connectorById, type ConnectorId } from '@shared/spaces/connectors';
import type { RigSpaceStatus } from '@shared/rig/space-status';
import type { HomeRigRow } from './home-sections';
import { HomeFeedLabel } from './home-feed-label';
import { shortAge } from './recent-themes-state';
import {
  contextLine,
  deriveWaitingItems,
  doneLine,
  pendingRequestOf,
  usedInLabel,
  waitingAction,
  type ExpiredConnector,
  type PendingRequest,
  type WaitingAction,
  type WaitingItem,
} from './waiting-on-you';

/** How long a done item stays, faded, before it clears. */
const DONE_LINGER_MS = 4_000;
/** How long it takes to fold away at the end of that. */
const COLLAPSE_MS = 300;

/**
 * How many spaces are asked "do you use this connector", per expired
 * connector: enough to name where it's used, without asking every space
 * this account has ever touched.
 */
const MAX_SPACES_CHECKED = 24;
const CONNECTIONS_KEY = ['rig', 'connectors', 'list'];

/** Who's asking: a name, and their picture when Home knows one. */
type AvatarOf = (who: { userId: string | null; name: string }) => string | null;

/**
 * "Waiting on you" (Home "lighter pass"): under Ask, above "Across your
 * spaces today", drawn as flat rows like the topics under it. Only direct,
 * unread things, each with its message, the message before it as context,
 * and one action (`waiting-on-you.ts`): Reply inline through the Room's own
 * send (`roomTextMessage`), Accept an invite, Approve your own agent's
 * request from this computer's copy of the run, or Open the space. A done
 * item fades with a line saying so, then folds away. With nothing waiting,
 * one line says so.
 */
export function WaitingOnYouSection({
  spaceRows,
  statusByBinding,
  selfUserId,
  self = null,
  avatarOf,
  onOpenPath,
}: {
  spaceRows: readonly HomeRigRow[];
  statusByBinding: ReadonlyMap<string, RigSpaceStatus>;
  selfUserId: string | null;
  /** You: your name lights up mentions of you, your picture badges your agents. */
  self?: { name: string | null; avatarUrl: string | null } | null;
  avatarOf?: AvatarOf;
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
  const connectors = useExpiredConnectors(spaceRows);
  const items = deriveWaitingItems({
    activity,
    invites,
    spaces: spaceRows,
    statusByBinding,
    selfUserId,
    connectors,
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

  // Done items stay, faded, for a moment, fold away, then clear for this visit.
  const [done, setDone] = useState<ReadonlyMap<string, { item: WaitingItem; line: string }>>(new Map());
  const [collapsing, setCollapsing] = useState<ReadonlySet<string>>(new Set());
  const [cleared, setCleared] = useState<ReadonlySet<string>>(new Set());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const live = timers.current;
    return () => live.forEach(clearTimeout);
  }, []);
  const later = (ms: number, then: () => void) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      then();
    }, ms);
    timers.current.add(timer);
  };
  const doneKeyOf = (item: WaitingItem) =>
    item.kind === 'approval' ? `${item.key}:${pendingByRun.get(item.runId)?.requestId ?? ''}` : item.key;
  const finish = (item: WaitingItem) => {
    const key = doneKeyOf(item);
    setDone((current) => new Map(current).set(key, { item, line: doneLine(item) }));
    later(DONE_LINGER_MS - COLLAPSE_MS, () => setCollapsing((current) => new Set(current).add(key)));
    later(DONE_LINGER_MS, () => {
      setCleared((current) => new Set(current).add(key));
      setDone((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
    });
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
  const now = Date.now();
  // Nothing waiting: the section steps out of the way entirely.
  if (shown.length === 0) return null;

  return (
    <section className="flex flex-col gap-1.5" data-testid="waiting-on-you">
      <div className="pb-1">
        <HomeFeedLabel aside={open.length > 0 ? String(open.length) : undefined}>Waiting on you</HomeFeedLabel>
      </div>
      <ul className="flex flex-col">
        {shown.map(({ item, line }, index) => (
          <WaitingRow
            key={item.key}
            item={item}
            first={index === 0}
            now={now}
            selfUserId={selfUserId}
            self={self}
            avatarOf={avatarOf}
            context={contextByKey.get(item.key) ?? null}
            pending={item.kind === 'approval' ? (pendingByRun.get(item.runId) ?? null) : null}
            doneText={line}
            collapsing={collapsing.has(doneKeyOf(item))}
            spacePath={pathOf(item.bindingId)}
            onOpenPath={onOpenPath}
            onMarkRead={markRead}
            onDone={() => finish(item)}
            onInvitesChanged={() => {
              void queryClient.invalidateQueries({ queryKey: MY_INVITES_KEY_PREFIX });
              void queryClient.invalidateQueries({ queryKey: ['rig', 'account'] });
            }}
            onConnectionsChanged={() => void queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY })}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * Your connector logins that expired or signed you out, each with the
 * spaces here that use it (`listConnectors`, one small read per space).
 * One no space uses isn't waiting on you.
 */
function useExpiredConnectors(spaceRows: readonly HomeRigRow[]): ExpiredConnector[] {
  const connectionsQuery = useQuery({
    queryKey: CONNECTIONS_KEY,
    queryFn: () => connectorsApi.list(),
    staleTime: 60_000,
  });
  const expiredIds = (connectionsQuery.data ?? []).filter((c) => c.state === 'expired').map((c) => c.id);
  const candidates = spaceRows.slice(0, MAX_SPACES_CHECKED);
  const listings = useQueries({
    queries: candidates.map((row) => ({
      queryKey: ['rig', 'spacesConnection', 'listConnectors', row.bindingId],
      queryFn: () => rpc.rig.spacesConnection.listConnectors({ bindingId: row.bindingId }),
      staleTime: 60_000,
      enabled: expiredIds.length > 0,
    })),
  });
  return expiredIds.flatMap((id): ExpiredConnector[] => {
    const def = connectorById(id);
    if (!def) return [];
    const spaces = candidates
      .filter((_, i) => {
        const result = listings[i]?.data;
        return result?.success && result.data.some((c) => c.connectorId === id);
      })
      .map((row) => ({ bindingId: row.bindingId, name: row.name ?? row.bindingId }));
    return spaces.length > 0 ? [{ connectorId: id, name: def.name, brand: def.brand, spaces }] : [];
  });
}

/** A person's first name; an email or a single word stays whole. */
function firstName(name: string): string {
  return name.includes('@') ? name : (name.trim().split(/\s+/)[0] ?? name);
}

/** Enough of a person for an agent's owner badge. */
function badgeMember(id: string | null, name: string, avatarUrl: string | null): RoomMember {
  return { id: id ?? name, name, email: '', role: '', initial: name.slice(0, 1).toUpperCase(), avatarUrl, status: 'here' };
}

function WaitingRow({
  item,
  first,
  now,
  selfUserId,
  self,
  avatarOf,
  context,
  pending,
  doneText,
  collapsing,
  spacePath,
  onOpenPath,
  onMarkRead,
  onDone,
  onInvitesChanged,
  onConnectionsChanged,
}: {
  item: WaitingItem;
  first: boolean;
  now: number;
  selfUserId: string | null;
  self: { name: string | null; avatarUrl: string | null } | null;
  avatarOf?: AvatarOf;
  context: string | null;
  pending: PendingRequest | null;
  /** Set once its action went through: the row fades and says so. */
  doneText: string | null;
  /** At the end of being done: the row folds away. */
  collapsing: boolean;
  spacePath: string | null;
  onOpenPath: (path: string) => void;
  onMarkRead: (notificationId: string) => Promise<void>;
  onDone: () => void;
  onInvitesChanged: () => void;
  onConnectionsChanged: () => void;
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
    if (action === 'Reconnect' && item.kind === 'connector') {
      // The same browser sign-in the connector gallery runs.
      void run(async () => {
        const result = await connectorsApi.connect(item.connectorId as ConnectorId);
        onConnectionsChanged();
        if (result.ok) return null;
        return result.reason === 'cancelled' || result.reason === 'timeout'
          ? `You didn't finish signing in to ${item.name}. Try again.`
          : (result.message ?? `${item.name} didn't sign you in. Try again.`);
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

  const selfMember = badgeMember(selfUserId, self?.name ?? 'You', self?.avatarUrl ?? null);
  const avatar =
    item.kind === 'connector' ? (
      <ConnectorLogo id={item.connectorId} name={item.name} brand={item.brand} size={28} />
    ) : item.kind === 'approval' ? (
      <AgentAvatar agent={item.agentKind} owner={selfMember} badgeRingClassName="ring-bg-0" />
    ) : item.kind === 'reply' && item.who.agent ? (
      <AgentAvatar
        agent={item.who.agent}
        owner={badgeMember(
          item.who.userId,
          item.who.owner ?? 'Someone',
          avatarOf?.({ userId: item.who.userId, name: item.who.owner ?? '' }) ?? null
        )}
        badgeRingClassName="ring-bg-0"
      />
    ) : (
      <IdentityAvatar
        name={item.who.name}
        avatarUrl={avatarOf?.({ userId: item.who.userId, name: item.who.name }) ?? null}
        sizeClassName="size-7"
        textClassName="text-2xs"
      />
    );

  const who =
    item.kind === 'connector'
      ? item.name
      : item.kind === 'approval'
        ? `Your ${item.agent}`
        : item.kind === 'reply' && item.who.agent
          ? item.who.name
          : firstName(item.who.name);
  const verb =
    item.kind === 'connector'
      ? 'signed you out'
      : item.kind === 'approval'
        ? 'needs your approval'
        : item.kind === 'invite'
          ? 'invited you'
          : item.verb;
  const where =
    item.kind === 'connector'
      ? `used in ${usedInLabel(item.spaces)}`
      : item.kind === 'invite'
        ? item.label
        : `#${item.spaceName}`;
  const age = shortAge(item.at, now);

  const message: ReactNode =
    item.kind === 'reply' ? (
      <MessageText
        text={item.quote}
        people={[
          ...(self?.name ? [{ id: selfUserId ?? 'self', name: self.name }] : []),
          ...(item.who.agent ? [] : [{ id: item.who.userId ?? 'them', name: item.who.name }]),
        ]}
        selfId={selfUserId ?? 'self'}
      />
    ) : item.kind === 'connector' ? (
      `Your agents can't use ${item.name} until you sign in again.`
    ) : item.kind === 'approval' ? (
      (pending?.title ?? item.title ?? 'It needs your answer before it goes on.')
    ) : (
      'Accept to join it and set it up on this computer.'
    );

  return (
    <li
      className={cn(
        '-mx-3 grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none',
        collapsing ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr]',
        done && !collapsing && 'opacity-60'
      )}
      data-testid="waiting-item"
      data-kind={item.kind}
      data-done={done || undefined}
    >
      <div className={cn('min-h-0 overflow-hidden', !first && 'pt-1.5')}>
        <div
          className={cn(
            'flex gap-3 rounded-[12px] px-3 py-2.5 leading-normal transition-colors',
            !done && 'bg-accent/[.05] hover:bg-accent/[.09]'
          )}
        >
          <span className="mt-px flex shrink-0">{avatar}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="truncate text-xs text-text-muted" data-testid="waiting-meta">
                  <span className="font-medium text-text-primary">{who}</span> {verb} · {where}
                  {age && <> · {age}</>}
                </p>
                <p
                  className={cn(
                    'line-clamp-3 text-sm break-words whitespace-pre-line',
                    item.kind === 'invite' || item.kind === 'connector' ? 'text-text-secondary' : 'text-text-primary'
                  )}
                  data-testid="waiting-quote"
                >
                  {message}
                </p>
                {context && (
                  <p className="flex min-w-0 items-center gap-1.5 text-xs text-text-muted" data-testid="waiting-context">
                    <CornerDownRight className="size-3 shrink-0" strokeWidth={1.5} aria-hidden />
                    <span className="min-w-0 truncate">{context}</span>
                  </p>
                )}
              </div>
              {!done && canAct && !replying && (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={onAction}
                  disabled={busy}
                  className={cn('mt-0.5', action === 'Open' && 'cursor-pointer')}
                >
                  {busy ? workingLabel(action) : action}
                </Button>
              )}
            </div>
            {replying && !done && (
              <form
                className="mt-1.5 flex gap-2"
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
                  placeholder={item.kind === 'reply' ? `Reply to ${item.who.agent ? item.who.name : firstName(item.who.name)} in #${item.spaceName}` : undefined}
                  aria-label="Reply"
                  className="h-7 min-w-0 flex-1 rounded-control border border-border-hairline bg-bg-1 px-2.5 text-sm text-text-primary transition-colors outline-none placeholder:text-text-muted focus-visible:border-accent disabled:opacity-50"
                />
                <Button type="submit" size="xs" disabled={busy || !draft.trim()} className="h-7">
                  {busy ? 'Sending…' : 'Send'}
                </Button>
              </form>
            )}
            {done && (
              <p className="text-xs text-success" data-testid="waiting-done">
                {doneText}
              </p>
            )}
            {error && !done && (
              <p className="text-xs text-danger" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

/** Starts an @mention: after the start, a space or opening punctuation, never inside an email. */
const MENTION_AT = /(?<![\w.@/:-])@/g;
const AGENT_HANDLES = ['claude', 'codex'];

/** The message, with @mentions drawn the way the Room draws them; one of you is tinted. */
function MessageText({
  text,
  people,
  selfId,
}: {
  text: string;
  people: readonly { id: string; name: string }[];
  selfId: string;
}) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION_AT)) {
    const at = match.index ?? 0;
    if (at < last) continue;
    const mention = mentionAt(text, at, people, [], AGENT_HANDLES);
    if (!mention) continue;
    if (at > last) parts.push(text.slice(last, at));
    const mine = mention.memberId === selfId;
    parts.push(
      <span
        key={at}
        className={cn('font-medium text-accent', mine && 'rounded-control bg-accent-subtle px-0.5')}
        data-testid="waiting-mention"
      >
        {mention.token}
      </span>
    );
    last = at + mention.token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function workingLabel(action: WaitingAction): string {
  return action === 'Accept'
    ? 'Joining…'
    : action === 'Approve'
      ? 'Approving…'
      : action === 'Reconnect'
        ? 'Waiting for your browser…'
        : 'Working…';
}

function excerpt(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
