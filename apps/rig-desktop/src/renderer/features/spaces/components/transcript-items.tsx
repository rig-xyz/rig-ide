import { CircleAlert, Copy, UserPlus } from 'lucide-react';
import type { ReactNode } from 'react';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { cn } from '@renderer/lib/utils';
import { formatClock, formatClockShort, formatFull } from '@renderer/lib/time-format';
import { BrandLogo } from '../logos';
import type { RoomConnector, RoomMember, RoomMessage, RoomSnapshot } from '../types';
import { AGENT_NAME, AgentAvatar, PersonAvatar } from './identity';

/**
 * Spaces (lane 2): the non-session transcript row kinds — human message
 * row, typing line, join row, day divider, invite row, connector card, comment-mirror
 * line. All render from a `RoomMessage` + the room's `RoomSnapshot` (for
 * looking up the author, an invite's target member, etc.) — no fetches, no
 * local state. `session` messages are NOT handled here; `room-transcript.tsx`
 * routes those to `SessionCard` instead, since a session card owns
 * meaningfully more state (its own event log).
 */

function memberOf(snapshot: RoomSnapshot, id: string): RoomMember | undefined {
  return snapshot.members.find((m) => m.id === id);
}

/** Inline emphasis for @mentions, /commands and +file.md references — same markup rules as the reference demo's `rich()`, done as React nodes instead of HTML string concatenation. */
function richText(text: string, ownId: string): ReactNode[] {
  const pattern = /(@[a-z]+)|(\/[a-z-]+)|(\+[\w./-]+\.md)|(reviews\/[\w.-]+\.md)/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith('@')) {
      const mentioned = token.slice(1) === ownId;
      nodes.push(
        <span
          key={key++}
          className={cn(
            'text-accent font-medium',
            mentioned && 'bg-accent-subtle rounded-control px-0.5'
          )}
        >
          {token}
        </span>
      );
    } else if (token.startsWith('/')) {
      nodes.push(
        <span key={key++} className="text-accent font-mono font-medium">
          {token}
        </span>
      );
    } else {
      nodes.push(
        <span key={key++} className="bg-bg-2 rounded-control px-1 font-mono text-text-primary">
          {token}
        </span>
      );
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

/**
 * The grid every row in the Room shares: a 28px identity column, then the
 * text column. Keeping it in one place is what lines up messages, joins,
 * invites and doc comments on the same left edge.
 */
export const ROW_GRID = 'grid grid-cols-[28px_minmax(0,1fr)] gap-x-3 px-2';

/** A row's time: hidden until the row is hovered or focused, full date on hover. `short` drops AM/PM for the avatar column. */
export function RowTime({
  message,
  short = false,
  className,
}: {
  /** Anything with a timestamp; `time` is a precomputed label when there is one. */
  message: { createdAt: string; time?: string };
  short?: boolean;
  className?: string;
}) {
  return (
    <time
      dateTime={message.createdAt}
      title={formatFull(message.createdAt)}
      className={cn(
        'text-2xs whitespace-nowrap text-text-muted tabular-nums opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100',
        className
      )}
    >
      {short ? formatClockShort(message.createdAt) || message.time : message.time || formatClock(message.createdAt)}
    </time>
  );
}

/** A person's words sit in a bubble; agents' answers don't. Yours are tinted and sit on the right. */
export function bubbleClass(mine: boolean): string {
  return cn(
    'w-fit max-w-full rounded-2xl px-3 py-1.5 text-sm leading-relaxed break-words whitespace-pre-wrap text-text-primary',
    mine ? 'bg-accent-subtle rounded-tr-md' : 'bg-bg-2 rounded-tl-md'
  );
}

/**
 * A human message: avatar, name and (on hover) time, then the words in a
 * bubble; your own sit on the right with neither. `continued` drops the
 * header for a follow-up from the same person a moment later; its time sits
 * in the avatar column instead.
 */
export function MessageRow({
  message,
  snapshot,
  ownId,
  continued = false,
}: {
  message: RoomMessage;
  snapshot: RoomSnapshot;
  ownId: string;
  continued?: boolean;
}) {
  const author = memberOf(snapshot, message.authorId);
  const mine = message.authorId === ownId;
  const body = message.body ? richText(message.body, ownId) : null;
  if (mine) {
    // Your own words: on the right, no avatar or name, time on hover beside the bubble.
    return (
      <div
        className="group flex items-end justify-end gap-2 py-0.5 pr-2 pl-12"
        data-testid="message-row"
        data-author={message.authorId}
        data-mine="true"
        data-continued={continued}
      >
        <RowTime message={message} className="pb-1" />
        <p className={bubbleClass(true)}>{body}</p>
      </div>
    );
  }
  return (
    <div
      className={cn(ROW_GRID, 'group py-0.5')}
      data-testid="message-row"
      data-author={message.authorId}
      data-mine="false"
      data-continued={continued}
    >
      {continued ? (
        <RowTime message={message} short className="self-center justify-self-center" />
      ) : (
        <PersonAvatar member={author} name={message.authorId} className="mt-0.5" />
      )}
      <div className="flex min-w-0 flex-col gap-1">
        {!continued && (
          <div className="flex items-baseline gap-2">
            <b className="text-sm font-medium text-text-primary">{author?.name ?? message.authorId}</b>
            <RowTime message={message} />
          </div>
        )}
        <p className={bubbleClass(false)}>{body}</p>
      </div>
    </div>
  );
}

function typingLabel(names: string[]): string {
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  return `${names.length} people are typing`;
}

/** Who's typing, as one quiet line under the last message. People only: agents show their own live status. */
export function TypingRow({ personIds, snapshot }: { personIds: string[]; snapshot: RoomSnapshot }) {
  const names = personIds.map((id) => memberOf(snapshot, id)?.name ?? id);
  return (
    <div className={cn(ROW_GRID, 'items-center py-1')} data-testid="typing-row">
      <span className="flex items-center justify-center gap-0.5" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-1 rounded-full bg-text-muted motion-safe:animate-bounce"
            style={{ animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </span>
      <span className="text-2xs text-text-muted">{typingLabel(names)}</span>
    </div>
  );
}

/** Join row — a person arrived in the space. */
export function JoinRow({ message, snapshot }: { message: RoomMessage; snapshot: RoomSnapshot }) {
  const who = memberOf(snapshot, message.authorId);
  return (
    <div className={cn(ROW_GRID, 'group items-center py-1 text-xs text-text-secondary')}>
      <PersonAvatar member={who} name={message.authorId} size="sm" className="justify-self-center" />
      <span className="flex items-baseline gap-2">
        <span>
          <b className="font-medium text-text-primary">{who?.name ?? message.authorId}</b> joined the space
        </span>
        <RowTime message={message} />
      </span>
    </div>
  );
}

/** Day divider — a hairline with a centered day label ("Today", "Yesterday", a weekday, a date). */
export function DayDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 px-2 py-1.5" data-testid="day-divider">
      <span className="bg-border-hairline h-px flex-1" />
      <span className="text-2xs text-text-muted">{label}</span>
      <span className="bg-border-hairline h-px flex-1" />
    </div>
  );
}

/** Invite row — avatar, name, email, role chip, Invite sent/Joined, Copy link. Deliberately no Revoke. */
export function InviteRow({ message, snapshot }: { message: RoomMessage; snapshot: RoomSnapshot }) {
  if (message.meta.kind !== 'invite') return null;
  const invite = snapshot.invitesById[message.meta.inviteId];
  const by = memberOf(snapshot, message.authorId);
  // Scripted demo: `who` is a member id. Live: the invitee's email ('' for an
  // open link); once they join, the member with that email.
  const email = invite?.email ?? null;
  const who = invite
    ? (memberOf(snapshot, invite.who) ??
      (email ? snapshot.members.find((m) => m.email.toLowerCase() === email.toLowerCase()) : undefined))
    : undefined;
  const isLive = invite?.role !== undefined;
  const joined = invite?.status === 'joined';
  const label = who?.name ?? email ?? (invite ? 'Anyone with the link' : message.body);
  const role = invite?.role === 'viewer' ? 'can view' : 'can edit';
  const status = joined ? 'Joined' : isLive && !email ? 'Invite link created' : 'Invite sent by email';
  return (
    <div className={cn(ROW_GRID, 'group py-1')}>
      <PersonAvatar member={by} name={message.authorId} className="mt-0.5" />
      <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-sm text-text-secondary">
          <b className="font-medium text-text-primary">{by?.name ?? message.authorId}</b> invited someone
        </span>
        <RowTime message={message} />
      </div>
    <div className="border-border-hairline bg-bg-1 flex max-w-[420px] flex-col gap-2.5 rounded-card border p-3">
      <div className="flex items-center gap-2.5">
        <IdentityAvatar
          name={label ?? '?'}
          avatarUrl={who?.avatarUrl ?? null}
          sizeClassName={cn('size-8', !joined && 'opacity-45')}
          textClassName="text-xs"
        />
        <div className="flex min-w-0 flex-col">
          <b className="truncate text-sm font-medium text-text-primary">{label}</b>
          {who?.email && who.email !== label && (
            <span className="font-mono text-2xs text-text-muted">{who.email}</span>
          )}
        </div>
        <span className="bg-bg-2 ml-auto rounded-chip px-2 py-1 font-mono text-2xs text-text-secondary">{role}</span>
      </div>
      <div className="border-border-hairline flex items-center gap-2 border-t pt-2.5 text-xs text-text-secondary">
        <span className={cn('size-1.5 shrink-0 rounded-full', joined ? 'bg-success' : 'bg-text-muted')} />
        {status}
        {/* The relay never exposes a live invite's secret, so only the demo can copy a link. */}
        {!isLive && (
          <button
            type="button"
            className="border-border-hairline hover:bg-bg-2 ml-auto flex h-6 items-center gap-1.5 rounded-control border px-2 text-xs text-text-primary transition-colors"
          >
            <Copy className="size-3" strokeWidth={1.5} />
            Copy link
          </button>
        )}
      </div>
    </div>
      </div>
    </div>
  );
}

const CONNECTOR_NOTE = 'Every agent in this space can query these, read-only.';

/** Connector card — announces the tools Someone connected to the space. */
export function ConnectorCard({
  message,
  addedBy,
  connectors,
}: {
  message: RoomMessage;
  addedBy: RoomMember | undefined;
  connectors: RoomConnector[];
}) {
  return (
    <div className={cn(ROW_GRID, 'group py-1')}>
      <PersonAvatar member={addedBy} name={message.authorId} className="mt-0.5" />
      <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-sm text-text-secondary">
          <b className="font-medium text-text-primary">{addedBy?.name ?? message.authorId}</b> connected tools to this space
        </span>
        <RowTime message={message} />
      </div>
    <div className="border-border-hairline bg-bg-1 flex max-w-[420px] flex-col gap-2.5 rounded-card border p-3">
      {connectors.map((c) => (
        <div key={c.id} className="flex items-center gap-2.5 text-sm text-text-primary">
          <BrandLogo id={c.logo} size={16} />
          {c.name}
          <span className="ml-auto font-mono text-2xs text-text-muted">read-only</span>
        </div>
      ))}
      <p className="border-border-hairline border-t pt-2 text-2xs text-text-muted">{CONNECTOR_NOTE}</p>
    </div>
      </div>
    </div>
  );
}

/** Comment-mirror line — a comment on a document that reached an agent, or that agent's reply. */
/**
 * A doc comment (or a reply in its thread), shown in the room where it
 * happened: who, on which file (click to open it), the passage it's
 * anchored to, and what they said. Replies skip the quote; the thread's
 * first comment already showed it.
 */
export function CommentMirrorLine({
  message,
  snapshot,
  onOpenFile,
  inThread = false,
}: {
  message: RoomMessage;
  snapshot: RoomSnapshot;
  onOpenFile?: (relPath: string) => void;
  /** Inside a thread block: a reply is just who, when and what; the file and quote are on the thread's first comment. */
  inThread?: boolean;
}) {
  if (message.meta.kind !== 'comment_mirror') return null;
  const { path, quote, replyFromAgent, isReply } = message.meta;
  const author = memberOf(snapshot, message.authorId);
  const who = author?.name ?? message.authorId;
  const name = replyFromAgent ? `${who}'s ${AGENT_NAME[replyFromAgent]}` : who;
  const avatar = (size: 'md' | 'sm', className?: string) =>
    replyFromAgent ? (
      <AgentAvatar agent={replyFromAgent} owner={author} size={size} className={className} />
    ) : (
      <PersonAvatar member={author} name={message.authorId} size={size} className={className} />
    );
  if (inThread && isReply) {
    return (
      <div className="group flex gap-2" data-testid="comment-thread-reply">
        {avatar('sm', 'mt-0.5')}
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-baseline gap-2 text-xs">
            <b className="font-medium text-text-primary">{name}</b>
            <RowTime message={message} />
          </div>
          <p className={cn('text-sm', replyFromAgent ? 'line-clamp-2 text-text-secondary' : 'text-text-primary')}>
            {message.body}
          </p>
        </div>
      </div>
    );
  }
  const fileChip = onOpenFile ? (
    <button
      type="button"
      onClick={() => onOpenFile(path)}
      className="bg-bg-2 hover:bg-bg-3 rounded-control px-1 font-mono text-xs text-text-primary transition-colors"
      title={`Open ${path}`}
    >
      {path}
    </button>
  ) : (
    <span className="bg-bg-2 rounded-control px-1 font-mono text-xs text-text-primary">{path}</span>
  );
  return (
    <div className={cn(ROW_GRID, 'group py-1')} data-testid="comment-mirror-line">
      {avatar('md', 'mt-0.5')}
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-sm text-text-secondary">
            <b className="font-medium text-text-primary">{name}</b> {isReply ? 'replied on' : 'commented on'}{' '}
            {fileChip}
          </span>
          <RowTime message={message} />
        </div>
        {!isReply && quote && (
          <p className="border-border-strong line-clamp-2 border-l-2 pl-2.5 text-xs text-text-muted">{quote}</p>
        )}
        {/* An agent's reply is also the answer in its session card, just
            above: keep it to a glance here instead of repeating it. */}
        <p className={cn('text-sm', replyFromAgent ? 'line-clamp-2 text-text-secondary' : 'text-text-primary')}>
          {message.body}
        </p>
      </div>
    </div>
  );
}

/** System row (join is its own component above; this covers the rest: connectors added, skill added, an agent that couldn't start). */
export function SystemRow({ message, snapshot }: { message: RoomMessage; snapshot: RoomSnapshot }) {
  if (message.meta.kind !== 'system') return null;
  if (message.meta.event === 'connectors_added') {
    return (
      <ConnectorCard message={message} addedBy={memberOf(snapshot, message.authorId)} connectors={snapshot.connectors} />
    );
  }
  const Icon = message.meta.event === 'agent_failed' ? CircleAlert : UserPlus;
  return (
    <div className={cn(ROW_GRID, 'group items-center py-1 text-xs text-text-secondary')}>
      <Icon className="size-3.5 justify-self-center text-text-muted" strokeWidth={1.5} />
      <span className="flex items-baseline gap-2">
        <span>{message.body}</span>
        <RowTime message={message} />
      </span>
    </div>
  );
}
