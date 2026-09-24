import { Copy, MessageSquareQuote, Plug, UserPlus } from 'lucide-react';
import type { ReactNode } from 'react';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { cn } from '@renderer/lib/utils';
import { agentLogoId, BrandLogo } from '../logos';
import type { RoomConnector, RoomMember, RoomMessage, RoomSnapshot } from '../types';

/**
 * Spaces (lane 2): the non-session transcript row kinds — human message
 * bubble, join row, day divider, invite row, connector card, comment-mirror
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

/** Human message bubble — own messages right-aligned in the accent tint with the own avatar; others left with the author's name. */
export function MessageBubble({
  message,
  snapshot,
  ownId,
}: {
  message: RoomMessage;
  snapshot: RoomSnapshot;
  ownId: string;
}) {
  const author = memberOf(snapshot, message.authorId);
  const mine = message.authorId === ownId;
  return (
    <div className={cn('flex items-end gap-2', mine && 'flex-row-reverse')} data-testid="message-bubble" data-author={message.authorId} data-mine={mine}>
      <IdentityAvatar
        name={author?.name ?? message.authorId}
        avatarUrl={null}
        sizeClassName="size-5.5"
        textClassName="text-2xs"
        className="mb-0.5 shrink-0"
      />
      <div className={cn('flex max-w-[76%] min-w-0 flex-col gap-0.5', mine && 'items-end')}>
        {!mine && (
          <span className="pl-3 text-xs text-text-secondary">
            <b className="font-medium text-text-primary">{author?.name ?? message.authorId}</b>
          </span>
        )}
        <div
          className={cn(
            'rounded-[16px] px-3.5 py-2 text-sm leading-relaxed text-text-primary',
            mine ? 'bg-accent-subtle rounded-br-[5px]' : 'bg-bg-2 rounded-bl-[5px]'
          )}
        >
          {message.body ? richText(message.body, ownId) : null}
        </div>
        <span className="px-3 font-mono text-2xs text-text-muted">{message.time}</span>
      </div>
    </div>
  );
}

/** A typing indicator, same visual family as `MessageBubble` — three bouncing dots instead of text. */
export function TypingBubble({ personId, snapshot }: { personId: string; snapshot: RoomSnapshot }) {
  const author = memberOf(snapshot, personId);
  return (
    <div className="flex items-end gap-2">
      <IdentityAvatar
        name={author?.name ?? personId}
        avatarUrl={null}
        sizeClassName="size-5.5"
        textClassName="text-2xs"
        className="mb-0.5 shrink-0"
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="pl-3 text-xs text-text-secondary">
          <b className="font-medium text-text-primary">{author?.name ?? personId}</b> is typing
        </span>
        <div className="bg-bg-2 flex items-center gap-1 rounded-[16px] rounded-bl-[5px] px-3.5 py-2.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="size-1.5 animate-bounce rounded-full bg-text-muted"
              style={{ animationDelay: `${i * 0.15}s` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Join row — a person arrived in the space. */
export function JoinRow({ message, snapshot }: { message: RoomMessage; snapshot: RoomSnapshot }) {
  const who = memberOf(snapshot, message.authorId);
  return (
    <div className="flex items-center gap-2 px-0.5 text-xs text-text-secondary">
      <IdentityAvatar name={who?.name ?? message.authorId} avatarUrl={null} sizeClassName="size-4" textClassName="text-2xs" />
      <span>
        <b className="font-medium text-text-primary">{who?.name ?? message.authorId}</b> joined the space
      </span>
      <span className="ml-auto font-mono text-2xs text-text-muted">{message.time}</span>
    </div>
  );
}

/** Day divider — a hairline with a centered date label, the transcript's own timeline break. */
export function DayDivider({ message }: { message: RoomMessage }) {
  return (
    <div className="flex items-center gap-3 py-1.5 font-mono text-2xs tracking-wide text-text-muted uppercase">
      <span className="bg-border-hairline h-px flex-1" />
      <span>{message.body}</span>
      <span className="bg-border-hairline h-px flex-1" />
    </div>
  );
}

/** Invite row — avatar, name, email, role chip, Invite sent/Joined, Copy link. Deliberately no Revoke. */
export function InviteRow({ message, snapshot }: { message: RoomMessage; snapshot: RoomSnapshot }) {
  if (message.meta.kind !== 'invite') return null;
  const invite = snapshot.invitesById[message.meta.inviteId];
  const by = memberOf(snapshot, message.authorId);
  const who = invite ? memberOf(snapshot, invite.who) : undefined;
  const joined = invite?.status === 'joined';
  return (
    <div className="border-border-hairline bg-bg-1 flex max-w-[420px] flex-col gap-2.5 rounded-card border p-3">
      <p className="text-xs text-text-muted">
        <b className="font-medium text-text-secondary">{by?.name ?? message.authorId}</b> invited
      </p>
      <div className="flex items-center gap-2.5">
        <IdentityAvatar
          name={who?.name ?? invite?.who ?? '?'}
          avatarUrl={null}
          sizeClassName={cn('size-8', !joined && 'opacity-45')}
          textClassName="text-xs"
        />
        <div className="flex min-w-0 flex-col">
          <b className="text-sm font-medium text-text-primary">{who?.name ?? invite?.who}</b>
          <span className="font-mono text-2xs text-text-muted">{who?.email}</span>
        </div>
        <span className="bg-bg-2 ml-auto rounded-chip px-2 py-1 font-mono text-2xs text-text-secondary">
          can edit
        </span>
      </div>
      <div className="border-border-hairline flex items-center gap-2 border-t pt-2.5 text-xs text-text-secondary">
        <span className={cn('size-1.5 shrink-0 rounded-full', joined ? 'bg-success' : 'bg-text-muted')} />
        {joined ? 'Joined' : 'Invite sent by email'}
        <button
          type="button"
          className="border-border-hairline hover:bg-bg-2 ml-auto flex h-6 items-center gap-1.5 rounded-control border px-2 text-xs text-text-primary transition-colors"
        >
          <Copy className="size-3" strokeWidth={1.5} />
          Copy link
        </button>
      </div>
    </div>
  );
}

const CONNECTOR_NOTE = 'Every agent in this space can query these, read-only.';

/** Connector card — announces the tools Someone connected to the space. */
export function ConnectorCard({
  addedBy,
  connectors,
}: {
  addedBy: string;
  connectors: RoomConnector[];
}) {
  return (
    <div className="border-border-hairline bg-bg-1 flex max-w-[420px] flex-col gap-2.5 rounded-card border p-3">
      <p className="flex items-center gap-1.5 text-xs text-text-muted">
        <Plug className="size-3.5 text-text-muted" strokeWidth={1.5} />
        <b className="font-medium text-text-secondary">{addedBy}</b> connected tools to this space
      </p>
      {connectors.map((c) => (
        <div key={c.id} className="flex items-center gap-2.5 text-sm text-text-primary">
          <BrandLogo id={c.logo} size={16} />
          {c.name}
          <span className="ml-auto font-mono text-2xs text-text-muted">read-only</span>
        </div>
      ))}
      <p className="border-border-hairline border-t pt-2 text-2xs text-text-muted">{CONNECTOR_NOTE}</p>
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
}: {
  message: RoomMessage;
  snapshot: RoomSnapshot;
  onOpenFile?: (relPath: string) => void;
}) {
  if (message.meta.kind !== 'comment_mirror') return null;
  const { path, quote, replyFromAgent, isReply } = message.meta;
  const author = memberOf(snapshot, message.authorId);
  const who = author?.name ?? message.authorId;
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
    <div className="flex flex-col gap-1.5 px-0.5" data-testid="comment-mirror-line">
      <div className="flex items-center gap-2 text-xs text-text-secondary">
        {replyFromAgent ? (
          <BrandLogo id={agentLogoId(replyFromAgent)} size={13} />
        ) : (
          <MessageSquareQuote className="size-3.5 text-text-muted" strokeWidth={1.5} />
        )}
        <span className="min-w-0 truncate">
          <b className="font-medium text-text-primary">
            {replyFromAgent ? `${who}'s ${replyFromAgent === 'claude' ? 'Claude' : 'Codex'}` : who}
          </b>{' '}
          {isReply ? 'replied on' : 'commented on'} {fileChip}
        </span>
        <span className="ml-auto shrink-0 font-mono text-2xs text-text-muted">{message.time}</span>
      </div>
      {!isReply && quote && (
        <p className="border-border-strong ml-[22px] line-clamp-2 border-l-2 pl-2.5 text-xs text-text-muted italic">
          “{quote}”
        </p>
      )}
      <p className="ml-[22px] text-sm text-text-primary">{message.body}</p>
    </div>
  );
}

/** System row (join is its own component above; this covers the rest: connectors added, skill added). */
export function SystemRow({ message, snapshot }: { message: RoomMessage; snapshot: RoomSnapshot }) {
  if (message.meta.kind !== 'system') return null;
  if (message.meta.event === 'connectors_added') {
    const by = memberOf(snapshot, message.authorId)?.name ?? message.authorId;
    return <ConnectorCard addedBy={by} connectors={snapshot.connectors} />;
  }
  return (
    <div className="flex items-center gap-2 px-0.5 text-xs text-text-secondary">
      <UserPlus className="size-3.5 text-text-muted" strokeWidth={1.5} />
      {message.body}
      <span className="ml-auto font-mono text-2xs text-text-muted">{message.time}</span>
    </div>
  );
}
