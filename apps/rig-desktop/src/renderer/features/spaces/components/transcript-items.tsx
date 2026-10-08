import {
  Check,
  CircleAlert,
  Copy,
  CornerUpLeft,
  FileText,
  Github,
  Globe,
  Link as LinkIcon,
  Plug,
  Presentation,
  Sheet,
  UserPlus,
} from 'lucide-react';
import { Children, createContext, type MouseEvent, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MARKDOWN_ELEMENTS_CLASS, TABLE_CLASS, TABLE_WRAPPER_CLASS } from '@renderer/lib/ui/markdown-classes';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { cn } from '@renderer/lib/utils';
import { formatClock, formatClockShort, formatFull } from '@renderer/lib/time-format';
import type { ConnectResult } from '@shared/spaces/connectors';
import { canonicalPageUrl, classifyLink, opensBesideChat, webLinkLabel, type LinkKind } from '@shared/spaces/links';
import { isRigFileUrl } from '@shared/spaces/rig-file';
import { agentLogoId, BrandLogo, ConnectorMark } from '../logos';
import { remarkRoomTokens, type RoomTokenKind } from '../message-tokens';
import { personOf } from '../person-identity';
import type { AgentKind, MessageMention, RoomConnector, RoomMember, RoomMessage, RoomReplyRef, RoomSnapshot } from '../types';
import { AGENT_NAME, AgentAvatar, PersonAvatar } from './identity';
import { FileTagChip, MessageAttachments } from './attachment-cards';
import { ConnectPill } from './connectors-panel';
import { SpaceFileLink } from './space-file-link';
import { QuickReactions, ReactionChips } from './reactions';

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

const LINK_ICON: Partial<Record<LinkKind, ReactNode>> = {
  'claude-artifact': <BrandLogo id="claude" size={12} />,
  'claude-chat': <BrandLogo id="claude" size={12} />,
  'google-doc': <FileText className="size-3 text-text-secondary" strokeWidth={1.75} />,
  'google-sheet': <Sheet className="size-3 text-text-secondary" strokeWidth={1.75} />,
  'google-slides': <Presentation className="size-3 text-text-secondary" strokeWidth={1.75} />,
  github: <Github className="size-3 text-text-secondary" strokeWidth={1.75} />,
};

/**
 * Opens a web page beside the Room (the Room provides it), signed in as the
 * member, so the space can pin comments on it. Every web page opens there
 * except meetings, downloads and non-web links (`opensBesideChat`), which
 * go to the browser, as does a ⌘/ctrl- or middle-click on any link.
 */
export const OpenPageContext = createContext<((url: string, title: string) => void) | null>(null);

/**
 * The relay's router wasn't sure one of your messages was for your agent:
 * a quiet "Ask Claude?" under that message, for you only. The Room decides
 * when it shows and what asking does.
 */
export type AskSuggestion = { messageId: string; agent: AgentKind; ask: () => void };
export const AskSuggestionContext = createContext<AskSuggestion | null>(null);

function AskSuggestionButton({ suggestion }: { suggestion: AskSuggestion }) {
  return (
    <button
      type="button"
      onClick={suggestion.ask}
      data-testid="ask-suggestion"
      className="card-pop-in border-border-hairline hover:bg-bg-2 flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs text-text-secondary transition-colors hover:text-text-primary"
    >
      <BrandLogo id={agentLogoId(suggestion.agent)} size={12} />
      Ask {AGENT_NAME[suggestion.agent]}?
    </button>
  );
}

/** `inPanel`: open the page beside the Room whatever it is (a page with pins on it). */
function useOpenLink(
  url: string,
  title: string,
  inPanel = false
): { onClick: (event: MouseEvent<HTMLAnchorElement>) => void; onAuxClick: (event: MouseEvent<HTMLAnchorElement>) => void } {
  const openPage = useContext(OpenPageContext);
  // Loaded on click: these rows render in tests and previews with no Electron bridge.
  const openExternal = () => void import('@renderer/lib/ipc').then(({ rpc }) => rpc.app.openExternal(url));
  return {
    onClick: (event) => {
      event.preventDefault();
      const toBrowser = event.metaKey || event.ctrlKey;
      if (openPage && !toBrowser && (inPanel || opensBesideChat(url))) openPage(canonicalPageUrl(url), title);
      else openExternal();
    },
    // A middle-click: the browser, always.
    onAuxClick: (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      openExternal();
    },
  };
}

const TITLED_KINDS: ReadonlySet<LinkKind> = new Set(['claude-artifact', 'claude-chat', 'google-doc', 'google-sheet', 'google-slides']);
/** One lookup per link for the whole chat, shared by every chip showing it. */
const linkTitles = new Map<string, Promise<string | null>>();

/**
 * The name behind a Claude or Google link ("Pilot deck"), read from the page
 * by the main process as you see it; null until it's known, or if it can't
 * be (then the chip keeps "Claude artifact").
 */
function useLinkTitle(url: string, kind: LinkKind): string | null {
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    if (!TITLED_KINDS.has(kind)) return;
    const key = canonicalPageUrl(url);
    let lookup = linkTitles.get(key);
    if (!lookup) {
      // Loaded lazily: these rows render in tests and previews with no Electron bridge.
      lookup = import('@renderer/lib/ipc')
        .then(({ rpc }) => rpc.rig.pages.linkTitle({ url: key }))
        .catch(() => null);
      linkTitles.set(key, lookup);
      void lookup.then((name) => {
        if (name === null) linkTitles.delete(key);
      });
    }
    let live = true;
    void lookup.then((name) => live && setTitle(name));
    return () => {
      live = false;
    };
  }, [url, kind]);
  return title;
}

/**
 * A link in a message, as a chip: for the kinds we know, what it is ("Pilot
 * deck" once its name is known, else "Claude artifact", "Google Doc",
 * "acme/app"); for any other page, its site ("userig.xyz/download", from the
 * URL alone: nothing is fetched for it). The full URL is in the tooltip.
 */
function MessageLink({ url }: { url: string }) {
  const { kind, label: kindLabel } = classifyLink(url);
  const title = useLinkTitle(url, kind);
  const label = kind === 'web' ? webLinkLabel(url) : (title ?? kindLabel);
  const open = useOpenLink(url, label);
  return (
    <a
      href={url}
      {...open}
      title={title ? `${kindLabel} · ${url}` : url}
      className="border-border-hairline bg-bg-1 hover:bg-bg-2 inline-flex max-w-full items-center gap-1 rounded-control border px-1.5 align-[-1px] text-text-primary"
      data-testid="message-link-chip"
      data-kind={kind}
    >
      {LINK_ICON[kind] ?? <Globe className="size-3 shrink-0 text-text-secondary" strokeWidth={1.75} />}
      <span className="max-w-[32ch] min-w-0 truncate">{label}</span>
    </a>
  );
}

/** The page a comment is pinned on, as the same chip its link gets in a message. */
/** A thread's number, as the same small teardrop its pin wears on the page or beside the file's text. */
function PinBadge({ n }: { n: number }) {
  return (
    <span
      className="bg-text-muted/80 text-bg-1 grid size-3.5 shrink-0 place-items-center rounded-[999px_999px_999px_2px] text-[8px] font-bold"
      aria-label={`pin ${n}`}
    >
      {n}
    </span>
  );
}

function PageChip({ url, title }: { url: string; title?: string }) {
  const { kind, label } = classifyLink(url);
  const name = title || (kind === 'web' ? new URL(url).hostname : label);
  // Its pins are on the page: always beside the Room, whatever the site.
  const open = useOpenLink(url, name, true);
  return (
    <a
      href={url}
      {...open}
      title={url}
      className="border-border-hairline bg-bg-1 hover:bg-bg-2 inline-flex items-center gap-1 rounded-control border px-1.5 align-[-1px] text-xs text-text-primary"
      data-testid="comment-page-chip"
    >
      {LINK_ICON[kind] ?? <Globe className="size-3 text-text-secondary" strokeWidth={1.75} />}
      <span>{name}</span>
    </a>
  );
}

/** A link written as markdown (`[the plan](https://…)`): its own words, opened like a link chip. */
function MessageTextLink({ href, children }: { href: string; children: ReactNode }) {
  const open = useOpenLink(href, webLinkLabel(href));
  return (
    <a href={href} {...open} title={href} className="text-accent underline underline-offset-2">
      {children}
    </a>
  );
}

type HastElement = { properties?: Record<string, unknown> };

/** The Room's own bits in a person's message, as `message-tokens.ts` marked them. */
function RoomToken({ node, ownId, children }: { node?: HastElement; ownId: string; children?: ReactNode }) {
  const props = node?.properties ?? {};
  const kind = props.dataRoomToken as RoomTokenKind | undefined;
  const value = String(props.dataValue ?? '');
  switch (kind) {
    case 'path':
      // Someone's absolute path (their own computer's): shown by its path in
      // the space, opening this computer's copy — see `SpaceFileLink`.
      return (
        <SpaceFileLink
          href={value}
          text={value}
          code={false}
          className="text-accent cursor-pointer font-mono underline decoration-dotted underline-offset-2"
        >
          {value}
        </SpaceFileLink>
      );
    case 'link':
      return <MessageLink url={value} />;
    case 'mention': {
      const mentioned = props.dataMember === ownId || value.slice(1) === ownId;
      return <span className={cn('text-accent font-medium', mentioned && 'bg-accent-subtle rounded-control px-0.5')}>{value}</span>;
    }
    case 'file-tag':
      return <FileTagChip path={value} />;
    case 'command':
      return <span className="text-accent font-mono font-medium">{value}</span>;
    case 'review':
      return <span className="bg-bg-2 rounded-control px-1 font-mono text-text-primary">{value}</span>;
    default:
      return <span>{children}</span>;
  }
}

/** A written link's own words, as plain text. */
function childText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => (typeof child === 'string' || typeof child === 'number' ? String(child) : ''))
    .join('');
}

/** A heading in chat is a bold line, not a title. */
function ChatHeading({ children }: { children?: ReactNode }) {
  return <p className="font-semibold">{children}</p>;
}

/**
 * A person's message: light markdown (code, bold, italics, strikethrough,
 * lists, quotes, links), a single newline kept as a line break, and the
 * Room's links, @mentions, /command, +file tags and paths in its ordinary
 * text (never inside code: `message-tokens.ts`). No raw HTML: it shows as
 * typed. No images: one is a link to it. The bubble carries the styles
 * (`bubbleClass`).
 */
export function richText(
  text: string,
  ownId: string,
  /** The room's people, so a display-name mention ("@Hugo Renaudin", what the composer's Tab inserts) reads as one. */
  members: readonly Pick<RoomMember, 'id' | 'name'>[] = [],
  /** Who the message says it tagged (`meta.mentions`): matched first, by id. */
  mentions: readonly MessageMention[] = [],
  /** The space's agent kinds, so `@claude` reads as a mention and `@rigxyz` doesn't. */
  agents: readonly string[] = []
): ReactNode {
  return (
    <ReactMarkdown
      remarkPlugins={[[remarkGfm, { singleTilde: false }], [remarkRoomTokens, { members, mentions, agents }]]}
      // A written link to a space's file (`[the page](rig-file://…)`) keeps its link.
      urlTransform={(url) => (isRigFileUrl(url) ? url : defaultUrlTransform(url))}
      components={{
        span: ({ node, children }) => (
          <RoomToken node={node as HastElement | undefined} ownId={ownId}>
            {children}
          </RoomToken>
        ),
        a: ({ href, children }) =>
          href && isRigFileUrl(href) ? (
            <SpaceFileLink href={href} text={childText(children)} code={false} className="text-accent cursor-pointer underline underline-offset-2">
              {children}
            </SpaceFileLink>
          ) : href && /^(https?|mailto):/i.test(href) ? (
            <MessageTextLink href={href}>{children}</MessageTextLink>
          ) : (
            <>{children}</>
          ),
        h1: ChatHeading,
        h2: ChatHeading,
        h3: ChatHeading,
        h4: ChatHeading,
        h5: ChatHeading,
        h6: ChatHeading,
        table: ({ children }) => (
          <div className={TABLE_WRAPPER_CLASS}>
            <table className={TABLE_CLASS}>{children}</table>
          </div>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
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

/**
 * A person's words sit in a bubble; agents' answers don't. Yours are tinted
 * and sit on the right. The bubble styles its markdown (`richText`): code
 * on someone else's grey bubble is lighter, so it still reads as code.
 */
export function bubbleClass(mine: boolean): string {
  return cn(
    'w-fit max-w-full rounded-2xl px-3 py-1.5 text-sm leading-relaxed break-words text-text-primary',
    MARKDOWN_ELEMENTS_CLASS,
    mine ? 'bg-accent-subtle rounded-tr-md' : 'bg-bg-2 rounded-tl-md [&_code]:bg-bg-1 [&_pre]:bg-bg-1'
  );
}

/**
 * The actions a row offers on hover or focus: a small floating bar at its
 * top-right. Each action confirms in place (Copy turns into "Copied").
 */
export function RowActions({
  onReply,
  copyText,
  children,
  forceVisible = false,
}: {
  onReply?: () => void;
  copyText?: string;
  /** Extra actions (e.g. Stop) before the standard ones. */
  children?: ReactNode;
  forceVisible?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);
  // `children` can be an array of `false`s (conditional actions that don't apply): count real ones.
  if (!onReply && !copyText && Children.toArray(children).length === 0) return null;
  const button =
    'hover:bg-bg-2 flex h-6 items-center gap-1.5 rounded-chip px-2 text-xs text-text-secondary transition-colors';
  return (
    <div
      className={cn(
        'border-border-hairline bg-bg-1 shadow-soft absolute top-0 right-2 z-10 flex -translate-y-1/2 items-center gap-0.5 rounded-chip border p-0.5 transition-opacity group-hover:opacity-100 focus-within:opacity-100',
        forceVisible ? 'opacity-100' : 'opacity-0'
      )}
      data-testid="row-actions"
    >
      {children}
      {onReply && (
        <button type="button" onClick={onReply} aria-label="Reply" title="Reply" className={button}>
          <CornerUpLeft className="size-3.5" strokeWidth={1.5} />
        </button>
      )}
      {copyText && (
        <button
          type="button"
          onClick={() => void navigator.clipboard?.writeText(copyText).then(() => setCopied(true))}
          aria-label="Copy"
          title="Copy"
          className={cn(button, copied && 'text-success')}
        >
          {copied ? <Check className="size-3.5" strokeWidth={1.5} /> : <Copy className="size-3.5" strokeWidth={1.5} />}
          {copied && 'Copied'}
        </button>
      )}
    </div>
  );
}

/** The quoted message a reply answers, above the reply's bubble; clicking jumps to it. */
function ReplyQuote({
  replyTo,
  mine,
  onJumpTo,
}: {
  replyTo: RoomReplyRef;
  mine: boolean;
  onJumpTo?: (messageId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onJumpTo?.(replyTo.id)}
      className={cn(
        'flex max-w-full min-w-0 items-center gap-1.5 text-xs text-text-muted transition-colors hover:text-text-secondary',
        mine && 'self-end'
      )}
      data-testid="reply-quote"
    >
      <CornerUpLeft className="size-3 shrink-0" strokeWidth={1.5} />
      {replyTo.label && <b className="shrink-0 font-medium text-text-secondary">{replyTo.label}</b>}
      <span className="min-w-0 truncate">{replyTo.excerpt}</span>
    </button>
  );
}

/** A short excerpt of a message for a quote-reply. */
export function excerptOf(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
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
  onReply,
  onJumpTo,
}: {
  message: RoomMessage;
  snapshot: RoomSnapshot;
  ownId: string;
  continued?: boolean;
  /** Starts a quote-reply to this message. */
  onReply?: (ref: RoomReplyRef) => void;
  /** Scrolls to a quoted message. */
  onJumpTo?: (messageId: string) => void;
}) {
  const who = personOf(snapshot, message.authorId);
  const mine = message.authorId === ownId;
  const files = message.meta.kind === 'text' ? message.meta.attachments : undefined;
  const mentions = message.meta.kind === 'text' ? message.meta.mentions : undefined;
  // Only files were sent: the body was written for older apps; the cards say it.
  const hideBody = !!files?.length && message.meta.kind === 'text' && message.meta.autoBody;
  const agentKinds = useMemo(() => [...new Set(snapshot.agents.map((a) => a.agent))], [snapshot.agents]);
  const body = useMemo(
    () => (message.body && !hideBody ? richText(message.body, ownId, snapshot.members, mentions, agentKinds) : null),
    [message.body, hideBody, ownId, snapshot.members, mentions, agentKinds]
  );
  const replyTo = message.meta.kind === 'text' ? message.meta.replyTo : undefined;
  // The emoji picker open from the hover bar keeps the bar showing.
  const [picking, setPicking] = useState(false);
  const askSuggestion = useContext(AskSuggestionContext);
  const chips = (
    <ReactionChips
      messageId={message.id}
      reactions={message.reactions}
      members={snapshot.members}
      ownId={ownId}
      className={mine ? 'justify-end' : undefined}
    />
  );
  const cards = files?.length ? (
    <MessageAttachments
      attachments={files}
      mine={mine}
      sending={!!message.sending}
      createdAt={message.createdAt}
      senderName={who.named ? who.name : 'them'}
    />
  ) : null;
  const actions = (
    <RowActions
      onReply={
        onReply
          ? () =>
              onReply({
                id: message.id,
                authorId: message.authorId,
                label: who.name,
                excerpt: excerptOf(message.body ?? ''),
              })
          : undefined
      }
      copyText={message.body}
      forceVisible={picking}
    >
      <QuickReactions messageId={message.id} reactions={message.reactions} ownId={ownId} onPickerChange={setPicking} />
    </RowActions>
  );
  if (mine) {
    // Your own words: on the right, no avatar or name, time on hover beside the bubble.
    return (
      <div
        className="group relative flex items-end justify-end gap-2 py-0.5 pr-2 pl-12"
        data-testid="message-row"
        data-author={message.authorId}
        data-mine="true"
        data-continued={continued}
        data-sending={message.sending ? 'true' : undefined}
      >
        {message.sending ? (
          <span className="pb-1 text-xs text-text-muted">Sending…</span>
        ) : (
          <RowTime message={message} className="pb-1" />
        )}
        <div className="flex min-w-0 flex-col items-end gap-1">
          {replyTo && <ReplyQuote replyTo={replyTo} mine onJumpTo={onJumpTo} />}
          {cards}
          {body && (
            <div className={cn(bubbleClass(true), message.sending && 'opacity-60')} data-highlight-target>
              {body}
            </div>
          )}
          {chips}
          {askSuggestion?.messageId === message.id && !message.sending && <AskSuggestionButton suggestion={askSuggestion} />}
        </div>
        {/* Nothing to reply to or copy a link to until the relay has it. */}
        {!message.sending && actions}
      </div>
    );
  }
  return (
    <div
      className={cn(ROW_GRID, 'group relative py-0.5')}
      data-testid="message-row"
      data-author={message.authorId}
      data-mine="false"
      data-continued={continued}
    >
      {continued ? (
        <RowTime message={message} short className="self-center justify-self-center" />
      ) : (
        <PersonAvatar member={who.member} person={who} className="mt-0.5" />
      )}
      <div className="flex min-w-0 flex-col gap-1">
        {!continued && (
          <div className="flex items-baseline gap-2">
            <b className="text-sm font-medium text-text-primary">{who.name}</b>
            <RowTime message={message} />
          </div>
        )}
        {replyTo && <ReplyQuote replyTo={replyTo} mine={false} onJumpTo={onJumpTo} />}
        {cards}
        {body && (
          <div className={bubbleClass(false)} data-highlight-target>
            {body}
          </div>
        )}
        {chips}
      </div>
      {actions}
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
  const names = personIds.map((id) => personOf(snapshot, id).name);
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
  const who = personOf(snapshot, message.authorId);
  return (
    <div className={cn(ROW_GRID, 'group items-center py-1 text-xs text-text-secondary')} data-testid="join-row">
      <PersonAvatar member={who.member} person={who} size="sm" className="justify-self-center" />
      <span className="flex items-baseline gap-2">
        <span>
          <b className="font-medium text-text-primary">{who.name}</b> joined the space
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
  const by = personOf(snapshot, message.authorId);
  // Scripted demo: `who` is a member id. Live: the invitee's email ('' for an
  // open link); once they join, the member with that email.
  const email = invite?.email ?? null;
  const who = invite
    ? (memberOf(snapshot, invite.who) ??
      (invite.target ? memberOf(snapshot, invite.target.userId) : undefined) ??
      (email ? snapshot.members.find((m) => m.email.toLowerCase() === email.toLowerCase()) : undefined))
    : undefined;
  // An invite aimed at one person: their name, from the roster once they're in.
  const target = invite?.target ? personOf(snapshot, invite.target.userId, invite.target) : null;
  const isLive = invite?.role !== undefined;
  const joined = invite?.status === 'joined';
  // An open link isn't a person — its card shows a link glyph, not initials.
  const openLink = Boolean(invite) && !who && !email && !target;
  const label = who?.name ?? target?.name ?? email ?? (invite ? 'Anyone with the link' : message.body);
  const role = invite?.role === 'viewer' ? 'can view' : 'can edit';
  // Lane J: a live invite never says "sent by email" — the relay's invite
  // row and Room message don't carry whether the email actually went out
  // (only the inviter's mint response does), and the share popover can
  // honestly say it didn't. The scripted demo keeps its own copy.
  const status = joined
    ? 'Joined'
    : !isLive
      ? 'Invite sent by email'
      : email
        ? `Invited ${email}`
        : target
          ? `Invited ${target.name}`
          : 'Invite link created';
  return (
    <div className={cn(ROW_GRID, 'group py-1')}>
      <PersonAvatar member={by.member} person={by} className="mt-0.5" />
      <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-sm text-text-secondary">
          <b className="font-medium text-text-primary">{by.name}</b> invited someone
        </span>
        <RowTime message={message} />
      </div>
    <div className="border-border-hairline bg-bg-1 flex max-w-[420px] flex-col gap-2.5 rounded-card border p-3">
      <div className="flex items-center gap-2.5">
        {openLink ? (
          <span
            data-testid="invite-link-avatar"
            className={cn(
              'bg-bg-2 text-text-secondary flex size-8 shrink-0 items-center justify-center rounded-full',
              !joined && 'opacity-45'
            )}
          >
            <LinkIcon className="size-4" strokeWidth={1.5} aria-hidden />
          </span>
        ) : (
          <IdentityAvatar
            name={label ?? '?'}
            avatarUrl={who?.avatarUrl ?? target?.avatarUrl ?? null}
            sizeClassName={cn('size-8', !joined && 'opacity-45')}
            textClassName="text-xs"
          />
        )}
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

const CONNECTOR_NOTE = "Each person's agent uses their own login. What an agent reads here is visible to the space.";

/** Connector card — announces the tools Someone connected to the space. */
export function ConnectorCard({
  message,
  addedBy,
  addedByName,
  connectors,
  onConnect,
}: {
  message: RoomMessage;
  addedBy: RoomMember | undefined;
  /** Who added them when they're not in the roster (left since): see `person-identity.ts`. */
  addedByName?: string;
  connectors: RoomConnector[];
  /** Runs the connect flow for a not-yet-connected/expired connector's pill. */
  onConnect?: (id: string) => Promise<ConnectResult>;
}) {
  return (
    <div className={cn(ROW_GRID, 'group py-1')}>
      <PersonAvatar member={addedBy} name={addedByName} className="mt-0.5" />
      <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-sm text-text-secondary">
          <b className="font-medium text-text-primary">{addedBy?.name ?? addedByName ?? 'Someone'}</b> added{' '}
          {connectors.map((c) => c.name).join(', ') || 'tools'} to the space
        </span>
        <RowTime message={message} />
      </div>
    <div className="border-border-hairline bg-bg-1 flex max-w-[420px] flex-col gap-2.5 rounded-card border p-3">
      {connectors.map((c) => (
        <div key={c.id} className="flex items-center gap-2.5 text-sm text-text-primary">
          <ConnectorMark connector={c} size={16} />
          {c.name}
          {c.mine === undefined ? (
            <span className="ml-auto font-mono text-2xs text-text-muted">read-only</span>
          ) : c.mine === 'connected' ? (
            <span className="ml-auto flex items-center gap-1.5 text-2xs text-text-muted">
              <span className="bg-success size-1.5 rounded-full" />
              Connected as you
            </span>
          ) : (
            onConnect && (
              <span className="ml-auto">
                <ConnectPill
                  label={c.mine === 'expired' ? 'Reconnect' : 'Connect'}
                  variant={c.mine === 'expired' ? 'warn' : 'accent'}
                  onConnect={() => onConnect(c.id)}
                />
              </span>
            )
          )}
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
  const { path, quote, replyFromAgent, isReply, pin } = message.meta;
  const person = personOf(snapshot, message.authorId);
  const author = person.member;
  const who = person.name;
  const name = replyFromAgent ? `${who}'s ${AGENT_NAME[replyFromAgent]}` : who;
  const avatar = (size: 'md' | 'sm', className?: string) =>
    replyFromAgent ? (
      <AgentAvatar agent={replyFromAgent} owner={author} size={size} className={className} />
    ) : (
      <PersonAvatar member={author} person={person} size={size} className={className} />
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
  const pageChip = /^https?:\/\//.test(path) ? <PageChip url={path} title={message.meta.pageTitle} /> : null;
  const fileChip = pageChip ?? (onOpenFile ? (
    <button
      type="button"
      onClick={() => onOpenFile(path)}
      className="bg-bg-2 hover:bg-bg-3 inline-flex items-center gap-1 rounded-control px-1 align-[-1px] font-mono text-xs text-text-primary transition-colors"
      title={`Open ${path}`}
    >
      {path}
    </button>
  ) : (
    <span className="bg-bg-2 inline-flex items-center gap-1 rounded-control px-1 align-[-1px] font-mono text-xs text-text-primary">
      {path}
    </span>
  ));
  return (
    <div className={cn(ROW_GRID, 'group py-1')} data-testid="comment-mirror-line">
      {avatar('md', 'mt-0.5')}
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-sm text-text-secondary">
            <b className="font-medium text-text-primary">{name}</b> {isReply ? 'replied on' : 'commented on'}{' '}
            {fileChip}
            {/* The thread's number, just outside the chip: the pin it wears on the page or beside the file's text. */}
            {pin !== undefined && (
              <span className="ml-1.5 inline-flex align-middle">
                <PinBadge n={pin} />
              </span>
            )}
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

/** System row (join is its own component above; this covers the rest: connectors added/removed, skill added, an agent that couldn't start). */
export function SystemRow({
  message,
  snapshot,
  onConnectorConnect,
}: {
  message: RoomMessage;
  snapshot: RoomSnapshot;
  /** Runs the connect flow for a connector pill inside a `connectors_added` card. */
  onConnectorConnect?: (id: string) => Promise<ConnectResult>;
}) {
  if (message.meta.kind !== 'system') return null;
  if (message.meta.event === 'connectors_added') {
    const ids = message.meta.connectorIds ?? snapshot.connectors.map((c) => c.id);
    const connectors = snapshot.connectors.filter((c) => ids.includes(c.id));
    const addedBy = personOf(snapshot, message.authorId);
    return (
      <ConnectorCard
        message={message}
        addedBy={addedBy.member}
        addedByName={addedBy.name}
        connectors={connectors}
        onConnect={onConnectorConnect}
      />
    );
  }
  const Icon =
    message.meta.event === 'agent_failed' || message.meta.event === 'ops_alert'
      ? CircleAlert
      : message.meta.event === 'connectors_removed'
        ? Plug
        : UserPlus;
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
