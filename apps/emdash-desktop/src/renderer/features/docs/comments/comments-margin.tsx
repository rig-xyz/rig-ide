import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ListFilter,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { useAgentInstallationStatuses } from '@renderer/lib/stores/use-agent-installation-statuses';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';
import { RelativeTime } from '@renderer/lib/ui/relative-time';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Textarea } from '@renderer/lib/ui/textarea';
import { cn } from '@renderer/utils/utils';
import type { RigCommentMessage, RigCommentPermissionRequest } from '@shared/rig/comments';
import { shortenQuote } from './anchors';
import {
  COMMENT_FILTERS,
  providerIdForAgentLabel,
  threadAgent,
  type AgentMention,
  type CommentFilter,
  type CommentThread,
  type DocCommentsStore,
} from './comments-store';

/**
 * The right-hand comment column of a doc pane: Docs-style cards, ordered by
 * anchor position, plus the composer for a new thread.
 *
 * Rendered only when there is something to say (threads, a composer, or a state
 * the reader needs explained) so an ordinary markdown file keeps the full pane.
 */

export const COMMENTS_MARGIN_WIDTH = 300;
export const COMMENTS_MARGIN_MIN_WIDTH = 220;
export const COMMENTS_MARGIN_MAX_WIDTH = 560;

const WIDTH_STORAGE_KEY = 'docs:comments-margin-width';

/**
 * The reader's last margin width, in pixels.
 *
 * Kept out of React state: it is read once when the margin panel mounts (as its
 * `defaultSize`) and written on drag, so re-rendering the pane on every pointer
 * frame is neither needed nor wanted.
 */
export function readCommentsMarginWidth(): number {
  try {
    const raw = window.localStorage.getItem(WIDTH_STORAGE_KEY);
    if (raw === null) return COMMENTS_MARGIN_WIDTH;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return COMMENTS_MARGIN_WIDTH;
    return Math.min(
      Math.max(Math.round(parsed), COMMENTS_MARGIN_MIN_WIDTH),
      COMMENTS_MARGIN_MAX_WIDTH
    );
  } catch {
    return COMMENTS_MARGIN_WIDTH;
  }
}

export function writeCommentsMarginWidth(width: number): void {
  try {
    window.localStorage.setItem(WIDTH_STORAGE_KEY, JSON.stringify(Math.round(width)));
  } catch {
    // Storage may be unavailable; the width simply won't survive the session.
  }
}

/** True when the margin has anything to show. Read by the pane layout. */
export function shouldShowMargin(store: DocCommentsStore | null): boolean {
  return store !== null && store.hasContent;
}

/** What the filter is called, in the picker and on its trigger. */
const FILTER_LABELS: Record<CommentFilter, string> = {
  all: 'All',
  unresolved: 'Unresolved',
  new: 'New',
  resolved: 'Resolved',
  agent: 'Agent',
};

/** What the column says instead of going blank when a lens matches nothing. */
const FILTER_EMPTY: Record<CommentFilter, string> = {
  all: 'No comments on this document yet.',
  unresolved: 'No unresolved threads.',
  new: 'Nothing new.',
  resolved: 'No resolved threads.',
  agent: 'No threads an agent has spoken in.',
};

/**
 * The lens picker in the margin header.
 *
 * A select rather than a segmented control: the margin starts at 220px, and five
 * labelled segments cannot be quiet at that width. Borderless until hovered, so
 * the header stays a strip rather than becoming a toolbar.
 */
const FilterSelect = observer(function FilterSelect({ store }: { store: DocCommentsStore }) {
  return (
    <Select value={store.filter} onValueChange={(next) => store.setFilter(next as CommentFilter)}>
      <SelectTrigger
        size="sm"
        aria-label="Filter threads"
        title="Filter threads"
        className="gap-1 border-transparent px-1.5 text-xs text-foreground-muted hover:border-border hover:text-foreground [&_svg]:size-3!"
      >
        <ListFilter />
        <SelectValue>{(value) => FILTER_LABELS[value as CommentFilter]}</SelectValue>
      </SelectTrigger>
      <SelectContent align="end" alignItemWithTrigger={false} className="min-w-32">
        {COMMENT_FILTERS.map((filter) => (
          <SelectItem key={filter} value={filter} className="py-1 text-xs">
            {FILTER_LABELS[filter]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
});

/**
 * Fold every listed thread away, or open them all back up.
 *
 * Not a mode: it writes the same per-thread collapse state the card chevrons
 * do, and its own label is read back out of that state, so the two can never
 * disagree. Selecting a thread or a reply landing in one still opens that
 * thread afterwards — this was a moment, not a setting.
 *
 * Absent rather than disabled when there is nothing to fold: a control for
 * threads that aren't there is noise in a 220px strip.
 */
const CollapseAllButton = observer(function CollapseAllButton({
  store,
  threads,
}: {
  store: DocCommentsStore;
  threads: CommentThread[];
}) {
  if (threads.length === 0) return null;
  const allCollapsed = threads.every((thread) => store.isThreadCollapsed(thread.root.id));
  const label = allCollapsed ? 'Expand all threads' : 'Collapse all threads';
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      // Borderless until hovered, like the filter beside it: the header is a
      // strip, and two controls answering hover differently would break it.
      className="border-transparent text-foreground-muted hover:border-border hover:bg-transparent hover:text-foreground [&_svg]:size-3!"
      onClick={() =>
        store.setThreadsCollapsed(
          threads.map((thread) => thread.root.id),
          !allCollapsed
        )
      }
    >
      {allCollapsed ? <ChevronsUpDown /> : <ChevronsDownUp />}
    </Button>
  );
});

export const CommentsMargin = observer(function CommentsMargin({
  store,
}: {
  store: DocCommentsStore;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const listed = store.visibleThreads;
  const resolved = store.visibleResolvedThreads;

  // Resolved passages stay marked in the document, so they stay clickable. If
  // the reader clicks one, its card has to exist to be scrolled to.
  const activeIsResolved = resolved.some((thread) => thread.root.id === store.activeThreadId);
  useEffect(() => {
    if (activeIsResolved) setShowResolved(true);
  }, [activeIsResolved]);

  // The chip and the `New` lens are the same claim about the same threads. Both
  // at once would read as two different counts of two different things, so the
  // lens the reader has explicitly chosen wins and the chip stands down.
  const showUnreadChip = store.unreadCount > 0 && store.filter !== 'new';
  const nothingToList =
    listed.length === 0 && resolved.length === 0 && store.composerQuote === null;

  // What "all" means for collapse-all: everything the reader can actually see.
  // The current filter has already decided that for the main column; the
  // resolved threads join it only while their disclosure is open, since folding
  // cards that are themselves already folded away is work with no visible
  // effect until some later click.
  const collapsible = showResolved ? [...listed, ...resolved] : listed;

  // No left border of its own: the resize handle beside it is the divider.
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background-secondary-1">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 truncate text-xs text-foreground-muted">Comments</span>
        {listed.length > 0 && (
          <Badge variant="secondary" className="shrink-0">
            {listed.length}
          </Badge>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {showUnreadChip && (
            <button
              type="button"
              onClick={store.jumpToFirstUnread}
              title="Go to the first thread with new messages"
              className="flex shrink-0 items-center gap-1.5 text-xs text-foreground-muted hover:text-foreground"
            >
              <UnreadDot />
              {store.unreadCount} new
            </button>
          )}
          <CollapseAllButton store={store} threads={collapsible} />
          <FilterSelect store={store} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {store.state === 'error' && store.errorMessage !== null && (
          <p className="mb-3 text-xs text-foreground-warning">
            <span title={store.errorMessage}>{store.errorMessage}</span>{' '}
            <button
              type="button"
              className="underline hover:text-foreground"
              onClick={() => void store.refresh()}
            >
              Retry
            </button>
          </p>
        )}

        {store.composerQuote !== null && <NewThreadCard store={store} />}

        {nothingToList && (
          <p className="text-xs text-foreground-muted">{FILTER_EMPTY[store.filter]}</p>
        )}

        <div className="flex flex-col gap-3">
          {listed.map((thread) => (
            <ThreadCard key={thread.root.id} store={store} thread={thread} />
          ))}
        </div>

        {resolved.length > 0 && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setShowResolved((open) => !open)}
              className="flex h-6 items-center gap-1 text-xs text-foreground-muted hover:text-foreground"
            >
              {showResolved ? (
                <ChevronDown className="size-3 shrink-0" />
              ) : (
                <ChevronRight className="size-3 shrink-0" />
              )}
              {resolved.length} resolved
              {/* Resolving a thread ends the question; it does not mute the
                  people still answering it, so news in here still shows. */}
              {!showResolved && resolved.some((t) => store.isThreadUnread(t)) && <UnreadDot />}
            </button>
            {showResolved && (
              <div className="mt-2 flex flex-col gap-3">
                {resolved.map((thread) => (
                  <ThreadCard key={thread.root.id} store={store} thread={thread} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

// ── @mentions ────────────────────────────────────────────────────────────────

/**
 * The agents a reader can @mention: those this machine can actually run.
 * Mentioning an agent that isn't installed would post a question nobody ever
 * answers, so the list is filtered to `available` rather than merely known.
 */
function useMentionableAgents(): AgentMention[] {
  const { data: agents } = useAgents();
  const { data: statuses } = useAgentInstallationStatuses();
  return useMemo(() => {
    const available = new Set(
      (statuses ?? []).filter((status) => status.status === 'available').map((status) => status.id)
    );
    return (agents ?? [])
      .filter((agent) => available.has(agent.id))
      .map((agent) => ({ providerId: agent.id, name: agent.name }));
  }, [agents, statuses]);
}

/**
 * The agent already answering in this thread, if a plain reply should reach it.
 *
 * Continuity is the point: once an agent has spoken in a thread, replying to it
 * keeps talking to it — the same way a person in the thread doesn't have to be
 * re-addressed by name.
 */
function useThreadAgent(thread: CommentThread): AgentMention | null {
  const agents = useMentionableAgents();
  const { value: defaultAgent } = useAppSettingsKey('defaultAgent');
  return useMemo(() => {
    const fallback = agents.find((agent) => agent.providerId === defaultAgent) ?? null;
    return threadAgent(thread, agents, fallback);
  }, [agents, defaultAgent, thread]);
}

/** The `@token` the caret is sitting at the end of, if there is one. */
const MENTION_TOKEN = /(?:^|\s)@([\w-]*)$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The first mentionable agent named in a finished comment body. */
function findMention(body: string, agents: AgentMention[]): AgentMention | undefined {
  return agents.find((agent) =>
    new RegExp(`(?:^|[^\\w-])@${escapeRegExp(agent.providerId)}(?![\\w-])`, 'i').test(body)
  );
}

/**
 * The composer input, with `@` autocomplete over the runnable agents.
 *
 * The popup is opened by typing, not by caret movement, so it never reappears
 * over a mention the reader has already finished writing. Selection inserts the
 * provider id (`@claude`) because that is what `findMention` reads back at
 * submit time — the display name is only ever a label.
 */
function MentionTextarea({
  value,
  agents,
  onChange,
  onSubmit,
  onEscape,
  autoFocus,
  disabled,
  placeholder,
  rows,
  className,
}: {
  value: string;
  agents: AgentMention[];
  onChange: (next: string) => void;
  onSubmit: () => void;
  onEscape?: () => void;
  autoFocus?: boolean;
  disabled?: boolean;
  placeholder?: string;
  rows?: number;
  className?: string;
}) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const matches = useMemo(() => {
    if (query === null) return [];
    const needle = query.toLowerCase();
    return agents.filter(
      (agent) =>
        agent.providerId.toLowerCase().startsWith(needle) ||
        agent.name.toLowerCase().includes(needle)
    );
  }, [agents, query]);
  const open = matches.length > 0;

  const select = useCallback(
    (agent: AgentMention) => {
      const input = inputRef.current;
      if (!input) return;
      const caret = input.selectionStart ?? value.length;
      const token = MENTION_TOKEN.exec(value.slice(0, caret));
      if (!token) return;
      const at = caret - token[1].length - 1;
      onChange(`${value.slice(0, at)}@${agent.providerId} ${value.slice(caret)}`);
      setQuery(null);
      const next = at + agent.providerId.length + 2;
      queueMicrotask(() => {
        input.focus();
        input.setSelectionRange(next, next);
      });
    },
    [onChange, value]
  );

  return (
    <div className="relative">
      <Textarea
        ref={inputRef}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        rows={rows}
        className={className}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next);
          const caret = event.target.selectionStart ?? next.length;
          setQuery(MENTION_TOKEN.exec(next.slice(0, caret))?.[1] ?? null);
          setHighlight(0);
        }}
        onBlur={() => setQuery(null)}
        onKeyDown={(event) => {
          if (open) {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setHighlight((index) => (index + 1) % matches.length);
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setHighlight((index) => (index - 1 + matches.length) % matches.length);
              return;
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault();
              select(matches[highlight] ?? matches[0]);
              return;
            }
            if (event.key === 'Escape') {
              // Dismisses the popup only — the composer stays open.
              event.preventDefault();
              setQuery(null);
              return;
            }
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
            return;
          }
          if (event.key === 'Escape') onEscape?.();
        }}
      />

      {open && (
        <div className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-md border border-border bg-background shadow-md">
          {matches.map((agent, index) => (
            <button
              key={agent.providerId}
              type="button"
              // Keep focus in the textarea: blur would close this list first.
              onMouseDown={(event) => {
                event.preventDefault();
                select(agent);
              }}
              onMouseEnter={() => setHighlight(index)}
              className={cn(
                'flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs',
                index === highlight ? 'bg-background-2 text-foreground' : 'text-foreground-muted'
              )}
            >
              <AgentIcon id={agent.providerId} size={12} className="shrink-0" />
              <span className="min-w-0 truncate">{agent.name}</span>
              <span className="ml-auto shrink-0 text-[10px] text-foreground-passive">
                @{agent.providerId}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A tool call the thread's agent is waiting to be allowed to make.
 *
 * One button per option the agent itself offered — the wording, the count and
 * the order are the agent's, exactly as the chat panel renders them. Nothing is
 * assumed to be "Allow"/"Deny": some agents offer four options, some two, and a
 * hardcoded pair would answer a question that was never asked.
 */
const PermissionRequestRow = observer(function PermissionRequestRow({
  store,
  rootId,
  request,
}: {
  store: DocCommentsStore;
  rootId: string;
  request: RigCommentPermissionRequest;
}) {
  const busy = store.isPending(request.requestId);
  return (
    <div className="mt-1.5 border-t border-border pt-1.5">
      <p className="truncate text-tiny text-foreground" title={request.title}>
        {request.title}
      </p>
      <div className="mt-1 flex flex-wrap gap-1">
        {request.options.map((option) => (
          <Button
            key={option.optionId}
            size="xs"
            variant={option.kind.startsWith('allow') ? 'secondary' : 'ghost'}
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              store.resolveAgentPermission(rootId, request.requestId, option.optionId);
            }}
          >
            {option.name}
          </Button>
        ))}
      </div>
    </div>
  );
});

/**
 * The agent turn running for a thread: a placeholder that is never persisted,
 * replaced by the real reply the moment it lands, or by a retryable error.
 *
 * A dashed outline rather than a settled message: nothing here exists on the
 * relay yet, and it must not be mistaken for a reply that does.
 *
 * It is also where the agent asks for permission. The turn has no chat panel of
 * its own, so the block it is blocked on is rendered here, beside the comment
 * that set it going — the agent in a thread can do everything the agent in the
 * chat pane can, and is approved the same way.
 */
const AgentReplyCard = observer(function AgentReplyCard({
  store,
  rootId,
}: {
  store: DocCommentsStore;
  rootId: string;
}) {
  const pending = store.agentReplyFor(rootId);
  const permissions = store.agentPermissionsFor(rootId);
  if (pending === null) return null;

  if (pending.error !== null) {
    return (
      <div className="mt-2.5 flex items-baseline gap-2 rounded-md border border-dashed border-border-1 px-2 py-1.5 text-tiny text-foreground-warning">
        <span className="min-w-0 flex-1 truncate" title={pending.error}>
          {pending.error}
        </span>
        <button
          type="button"
          className="shrink-0 underline hover:text-foreground"
          onClick={() => store.retryAgentReply(rootId)}
        >
          Retry
        </button>
        <button
          type="button"
          className="shrink-0 text-foreground-muted hover:text-foreground"
          onClick={() => store.dismissAgentReply(rootId)}
        >
          Dismiss
        </button>
      </div>
    );
  }

  // A blocked turn does not say "is replying…", and does not pulse: it is
  // waiting on the reader, and pretending otherwise leaves them waiting on
  // themselves.
  const waiting = permissions.length > 0;
  return (
    // The size lives on the block, not on the line inside it: this is a status
    // line at the card's own meta scale, and nothing it contains may inherit the
    // body size and start reading as a heading.
    <div className="mt-2.5 rounded-md border border-dashed border-border-1 px-2 py-1.5 text-tiny text-foreground-passive">
      <div className="flex min-w-0 items-center gap-1.5">
        <AgentIcon id={pending.request.providerId} size={12} className="shrink-0" />
        <span className={cn('min-w-0 truncate', !waiting && 'animate-pulse')}>
          {waiting ? `${pending.agentName} needs permission` : `${pending.agentName} is replying…`}
        </span>
      </div>
      {permissions.map((request) => (
        <PermissionRequestRow
          key={request.requestId}
          store={store}
          rootId={rootId}
          request={request}
        />
      ))}
    </div>
  );
});

// ── cards ────────────────────────────────────────────────────────────────────

/**
 * The selected card's accent, matched to the in-document one.
 *
 * One line, all the way around: the card's own 1px border recoloured to the
 * same `--blue-11` the marker dot and the active range use in
 * `comment-decorations.ts`. That shared colour is the only thing tying the two
 * halves of the selection together, so it is the one thing worth spending.
 *
 * Only the colour changes — the border is already there and already 1px — so
 * selecting a thread costs the card no width and the column never reflows. It
 * also means there is exactly one edge being drawn: the rule-plus-inset-shadow
 * this replaced stacked two hairlines on the same pixel column, which is what
 * was fringing. Written as a style rather than utilities because the token is a
 * raw ramp step with no utility of its own.
 */
const ACTIVE_CARD_STYLE: React.CSSProperties = {
  borderColor: 'var(--blue-11)',
};

/**
 * The ring's arrival, as a ripple that leaves nothing behind.
 *
 * An outer `box-shadow` only: it paints outside the border box, so it cannot
 * move the card or its neighbours, and the column's own 12px padding is wider
 * than the ripple, so the scroller never clips it. A 2px halo in the same
 * `--blue-9` mix the in-document marker dot wears, spreading to 6px as it fades
 * to nothing over 420ms — after which the card carries only the ring. A halo
 * that stayed would be a second, permanent signal saying the same thing.
 *
 * Skipped outright under `prefers-reduced-motion`: the ring alone is the whole
 * message, and it arrives the same either way.
 */
const GLOW_LIT: React.CSSProperties = {
  ...ACTIVE_CARD_STYLE,
  boxShadow: '0 0 0 2px color-mix(in srgb, var(--blue-9) 40%, transparent)',
};
const GLOW_FADING: React.CSSProperties = {
  ...ACTIVE_CARD_STYLE,
  boxShadow: '0 0 0 6px transparent',
  transition: 'box-shadow 420ms ease-out',
};

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Controls that own their own click; a click on one is not a card selection. */
const INTERACTIVE = 'button, a, input, textarea, select, [role="button"], [contenteditable]';

function Card({
  children,
  active,
  muted,
  compact,
  onActivate,
}: {
  children: React.ReactNode;
  active?: boolean;
  muted?: boolean;
  /** A folded thread: an index entry, so the card gives it index-entry padding. */
  compact?: boolean;
  onActivate?: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // 'lit' only ever lasts a frame: the glow has to be painted once before the
  // transition to 'fading' has anything to animate away from.
  const [glow, setGlow] = useState<'off' | 'lit' | 'fading'>('off');

  // Document → margin. `nearest` is what makes this safe to run on every
  // selection: a card already in view does not move, so selecting from the
  // margin never scrolls the column out from under the pointer.
  useEffect(() => {
    if (!active) return;
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [active]);

  useEffect(() => {
    if (!active || prefersReducedMotion()) {
      setGlow('off');
      return;
    }
    setGlow('lit');
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setGlow('fading'));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [active]);

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onActivate) return;
    if (event.target instanceof Element && event.target.closest(INTERACTIVE)) return;
    // A click that finished a drag over this card's own text is a read, not a
    // selection of the thread — copying out of a comment must stay possible.
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && ref.current?.contains(selection.anchorNode)) return;
    onActivate();
  };

  const style = !active
    ? undefined
    : glow === 'lit'
      ? GLOW_LIT
      : glow === 'fading'
        ? GLOW_FADING
        : ACTIVE_CARD_STYLE;

  return (
    <div
      ref={ref}
      onClick={handleClick}
      style={style}
      className={cn(
        'rounded-md border border-border bg-background px-2.5',
        compact ? 'py-1' : 'py-2.5',
        muted && 'opacity-70'
      )}
    >
      {children}
    </div>
  );
}

/** A `meta` entry, when it is a non-empty string. */
function metaString(meta: Record<string, unknown> | null, key: string): string | null {
  const value = meta?.[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Who wrote a comment.
 *
 * Agent posts are jointly authored: the agent acts under the human account
 * holder's identity, so `author.name` is the human and `meta` carries the agent
 * detail. The line must read the same as `formatCommentAuthorLine` in the rig
 * CLI (`src/collab.mjs`) so the CLI, the app and the hub tell one story:
 * `rig · <model> (with <human>)[ · per <onBehalfOf>]`.
 *
 * The one thing the CLI can't do is show you at a glance: the agent's own icon
 * leads the line. That glyph is the *only* signal distinguishing human from
 * agent here — no second border, no third tint — so the card stack stays
 * scannable instead of striped.
 */
function AuthorLine({ message }: { message: RigCommentMessage }) {
  const human = message.author.name || 'someone';
  const isAgent = message.author.kind === 'agent';
  const model = metaString(message.meta, 'model');
  const onBehalfOf = metaString(message.meta, 'onBehalfOf');
  const providerId = providerIdForAgentLabel(message.meta);
  const attribution = isAgent
    ? `rig${model === null ? '' : ` · ${model}`} (with ${human})${
        onBehalfOf === null ? '' : ` · per ${onBehalfOf}`
      }`
    : human;

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {isAgent && providerId !== null && (
        <AgentIcon id={providerId} size={12} className="shrink-0" />
      )}
      {isAgent ? (
        <span className="min-w-0 truncate text-xs text-foreground-muted" title={attribution}>
          {model === null ? 'rig' : `rig · ${model}`} (with{' '}
          <span className="font-medium text-foreground">{human}</span>)
          {onBehalfOf === null ? '' : ` · per ${onBehalfOf}`}
        </span>
      ) : (
        <span className="min-w-0 truncate text-xs font-medium text-foreground" title={attribution}>
          {human}
        </span>
      )}
      <RelativeTime
        value={message.createdAt}
        compact
        ago
        className="ml-auto shrink-0 text-micro text-foreground-passive"
      />
    </div>
  );
}

/**
 * The type every comment body is set in, human or agent.
 *
 * A thread is one conversation, so it is one size: an agent answers in markdown
 * and a person usually answers in a sentence, and neither may look like it is
 * speaking louder than the other. The markdown is therefore constrained to the
 * card rather than the card being enlarged to fit it — headings, list items and
 * code sit at the body's own size and leading, and the last block ends flush
 * with the bottom of the card instead of adding a paragraph gap of its own.
 *
 * Code keeps the usual 0.92em: a monospace face set at the same pixel size reads
 * larger than the prose around it, so matching it takes the correction, not the
 * number.
 */
const COMMENT_BODY_CLASS = cn(
  'break-words text-sm leading-relaxed text-foreground',
  '[&_h2]:text-sm [&_h3]:text-sm [&_h4]:text-sm [&_h5]:text-sm [&_h6]:text-sm',
  '[&_p]:mb-1.5 [&_p]:leading-relaxed [&_ul]:mb-1.5 [&_ol]:mb-1.5 [&_li]:leading-relaxed',
  '[&_code]:text-[0.92em] [&_table]:text-[0.92em]',
  '[&_*:last-child]:mb-0'
);

/**
 * Author line plus body — the unit a thread is a stack of.
 *
 * The gap between the two is what lets the author line act as the message's
 * header rather than as its first line: in a six-message thread the eye finds
 * the boundaries by those lines, so they need air above the prose they open.
 */
function CommentBody({ message }: { message: RigCommentMessage }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <AuthorLine message={message} />
      <MarkdownRenderer content={message.body} variant="compact" className={COMMENT_BODY_CLASS} />
    </div>
  );
}

/**
 * From this many replies, the middle of a thread is folded away by default.
 *
 * Four is the point at which folding actually buys something: with the opening
 * comment and the last two always shown, a shorter thread would hide one
 * message behind a line of text the same height, which is not a saving.
 */
const FOLD_FROM_REPLIES = 4;
/** How much of the end of a folded thread stays visible. */
const FOLD_TAIL = 2;

/** Who spoke last, for a collapsed thread's summary line. */
function lastSpeaker(thread: CommentThread): string {
  const last = thread.replies[thread.replies.length - 1] ?? thread.root;
  return last.author.kind === 'agent' ? 'rig' : last.author.name || 'someone';
}

/**
 * The app's unread mark, as worn by conversations and tasks: a small filled dot
 * in `foreground-info`, no count and no badge.
 */
function UnreadDot({ className }: { className?: string }) {
  return (
    <span
      className={cn('size-2 shrink-0 rounded-full bg-foreground-info', className)}
      aria-label="New messages"
      title="New messages"
    />
  );
}

/**
 * The control that opens a thread's folded middle.
 *
 * A pill centred on the hairline that separates the messages either side of it,
 * sized to its own words rather than to the column: full-width text on its own
 * rule read as a section heading for the replies below, which is not what it
 * is. The card's background breaks the rule behind the pill, so the two are one
 * mark — a seam with a way through it — rather than two stacked elements.
 */
function MoreRepliesButton({
  count,
  store,
  rootId,
}: {
  count: number;
  store: DocCommentsStore;
  rootId: string;
}) {
  return (
    <div className="relative flex items-center justify-center">
      <span aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-border" />
      <button
        type="button"
        className="relative inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-micro text-foreground-muted hover:border-border-1 hover:text-foreground"
        onClick={(event) => {
          event.stopPropagation();
          store.expandThreadReplies(rootId);
        }}
      >
        <ChevronDown className="size-3 shrink-0" />
        {count} more {count === 1 ? 'reply' : 'replies'}
      </button>
    </div>
  );
}

const ThreadCard = observer(function ThreadCard({
  store,
  thread,
}: {
  store: DocCommentsStore;
  thread: CommentThread;
}) {
  const { root, replies } = thread;
  const active = store.activeThreadId === root.id;
  const busy = store.isPending(root.id);
  const collapsed = store.isThreadCollapsed(root.id);
  const unread = store.isThreadUnread(thread);
  const agent = useThreadAgent(thread);

  // What the thread is about, in one line. An unanchored thread has no passage
  // to point at, so it summarises itself by its opening comment instead.
  const summary = shortenQuote(root.anchor?.exact ?? root.body, 160);

  // The opening comment and the tail always show; only the middle folds.
  const folded =
    !collapsed && !store.areThreadRepliesExpanded(root.id) && replies.length >= FOLD_FROM_REPLIES;
  const shownReplies = folded ? replies.slice(-FOLD_TAIL) : replies;
  const foldedAway = replies.length - shownReplies.length;

  return (
    <Card
      active={active}
      muted={thread.resolved}
      compact={collapsed}
      onActivate={() => store.setActiveThread(root.id, 'margin')}
    >
      {/* Context before content: what the thread points at, then what was said.
          Doubles as the collapse control, so the affordance sits in the same
          place whether the thread is open or folded down to this one line.

          Folded, the row is all the card contains, and the card tightens to it
          (`compact`): one truncated line, ~24px tall against the ~37px it used
          to be. A folded thread is an index entry, and an index entry nearly as
          tall as a card has saved the reader nothing. */}
      <button
        type="button"
        title={collapsed ? 'Expand thread' : 'Collapse thread'}
        onClick={(event) => {
          event.stopPropagation();
          store.toggleThreadCollapsed(root.id);
        }}
        className={cn(
          'flex w-full min-w-0 gap-1.5 text-left',
          // Folded, everything on the row is one line, so centring lines the
          // chevron up with the text it opens. Expanded, the quote wraps to two
          // lines and the chevron belongs at the top of them.
          collapsed ? 'items-center' : 'items-start',
          !collapsed && 'mb-2'
        )}
      >
        {collapsed ? (
          <ChevronRight className="size-3 shrink-0 text-foreground-passive" />
        ) : (
          <ChevronDown className="mt-px size-3 shrink-0 text-foreground-passive" />
        )}
        <span
          className={cn(
            'min-w-0 flex-1 border-border-1 text-tiny text-foreground-passive',
            // Folded, the quote stays a step above the 10px meta beside it —
            // it is what the reader scans — but loses the 2px rule, which was
            // what made the row read heavy rather than the type size.
            collapsed ? 'truncate border-l pl-1.5' : 'line-clamp-2 border-l-2 pl-2'
          )}
          title={root.anchor?.exact ?? root.body}
        >
          {summary}
        </span>
        {collapsed && (
          <span className="shrink-0 text-micro text-foreground-passive">
            {lastSpeaker(thread)} · {replies.length + 1}
          </span>
        )}
        {unread && <UnreadDot className={collapsed ? 'size-1.5' : 'mt-0.5'} />}
      </button>

      {!collapsed && (
        <>
          {thread.orphan && (
            <div className="mb-2">
              <Badge
                variant="secondary"
                className="shrink-0"
                title="The quoted passage has changed since this comment was made, so it can no longer be located in the document."
              >
                original text changed
              </Badge>
            </div>
          )}

          <CommentBody message={root} />

          {/* One hairline per message rather than one around the whole reply
              block: in a long conversation the boundaries are what make it
              readable, and a single rule under the opening comment leaves the
              rest as one undifferentiated column. */}
          {(shownReplies.length > 0 || foldedAway > 0) && (
            <div className="mt-2.5 flex flex-col gap-2.5">
              {foldedAway > 0 && (
                <MoreRepliesButton count={foldedAway} store={store} rootId={root.id} />
              )}
              {shownReplies.map((reply, index) => (
                <div
                  key={reply.id}
                  // The expander's own hairline already *is* this message's top
                  // boundary, so the message under it draws none: two rules a
                  // pill's height apart read as two marks for one seam. Dropping
                  // the border takes its 10px of padding with it, leaving the
                  // column's own 10px gap above and below the pill — the same
                  // 10px that sits either side of an ordinary message's rule.
                  className={cn(
                    !(index === 0 && foldedAway > 0) && 'border-t border-border pt-2.5'
                  )}
                >
                  <CommentBody message={reply} />
                </div>
              ))}
            </div>
          )}

          <AgentReplyCard store={store} rootId={root.id} />

          <div className="mt-2.5 flex flex-col gap-1.5">
            {active && (
              <ReplyComposer store={store} thread={thread} agent={agent} disabled={busy} />
            )}
            <div className="flex items-center gap-2">
              {!active && (
                <button
                  type="button"
                  className="shrink-0 text-xs text-foreground-muted hover:text-foreground"
                  onClick={() => store.setActiveThread(root.id, 'margin')}
                >
                  Reply
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                className="ml-auto shrink-0 text-xs text-foreground-muted hover:text-foreground disabled:opacity-50"
                onClick={(event) => {
                  event.stopPropagation();
                  void store.setResolved(root.id, !thread.resolved);
                }}
              >
                {thread.resolved ? 'Reopen' : 'Resolve'}
              </button>
            </div>
          </div>
        </>
      )}
    </Card>
  );
});

const ReplyComposer = observer(function ReplyComposer({
  store,
  thread,
  agent,
  disabled,
}: {
  store: DocCommentsStore;
  thread: CommentThread;
  /** The agent already in this thread, when there is one. */
  agent: AgentMention | null;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState('');
  const agents = useMentionableAgents();
  const rootId = thread.root.id;

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    // An explicit @mention wins — that is how you hand a thread to a different
    // agent. Otherwise the thread's own agent answers.
    const sent = await store.reply(rootId, text, findMention(text, agents) ?? agent ?? undefined);
    if (sent) setDraft('');
  }, [agent, agents, draft, rootId, store]);

  return (
    <div className="min-w-0 flex-1">
      <MentionTextarea
        value={draft}
        agents={agents}
        disabled={disabled}
        onChange={setDraft}
        onSubmit={() => void send()}
        placeholder="Reply…"
        rows={1}
        className="max-h-32 min-h-8 py-1.5 text-sm"
      />
    </div>
  );
});

/** The composer for a brand-new thread, bound to the quote that opened it. */
const NewThreadCard = observer(function NewThreadCard({ store }: { store: DocCommentsStore }) {
  const [draft, setDraft] = useState('');
  const quote = store.composerQuote ?? '';
  const agents = useMentionableAgents();

  const notice = stateNotice(store);
  const busy = store.isPending('new');

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    const posted = await store.create(quote, text, findMention(text, agents));
    if (posted) setDraft('');
  }, [agents, draft, quote, store]);

  return (
    <div className="mb-3 rounded-md border border-border-primary bg-background px-2.5 py-2.5">
      <p
        className="line-clamp-2 border-l-2 border-border-1 pl-2 text-tiny text-foreground-passive"
        title={quote}
      >
        {shortenQuote(quote, 160)}
      </p>

      {notice !== null ? (
        <p className="mt-2 text-xs text-foreground-muted">{notice}</p>
      ) : (
        <div className="mt-2">
          <MentionTextarea
            autoFocus
            value={draft}
            agents={agents}
            disabled={busy}
            onChange={setDraft}
            onSubmit={() => void send()}
            onEscape={store.closeComposer}
            placeholder="Comment…"
            rows={2}
            className="max-h-40 min-h-14 py-1.5 text-sm"
          />
        </div>
      )}

      <div className="mt-2 flex items-center justify-end gap-1.5">
        <Button variant="ghost" size="xs" onClick={store.closeComposer}>
          Cancel
        </Button>
        {notice === null && (
          <Button
            variant="default"
            size="xs"
            disabled={busy || draft.trim().length === 0}
            onClick={() => void send()}
          >
            Comment
          </Button>
        )}
      </div>
    </div>
  );
});

/**
 * The one-line explanation for the two states where commenting can't work at
 * all. A failed read is *not* one of them — it gets the retryable banner above
 * the cards, and the composer stays usable.
 */
function stateNotice(store: DocCommentsStore): string | null {
  switch (store.state) {
    case 'unauthenticated':
      return 'Sign in with `rig login` to load comments.';
    case 'notBound':
      return "This workspace isn't synced to a rig — comments are unavailable.";
    default:
      return null;
  }
}
