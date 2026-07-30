import { ChevronDown, ChevronRight } from 'lucide-react';
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
import { Textarea } from '@renderer/lib/ui/textarea';
import { cn } from '@renderer/utils/utils';
import type { RigCommentMessage, RigCommentPermissionRequest } from '@shared/rig/comments';
import { shortenQuote } from './anchors';
import {
  providerIdForAgentLabel,
  threadAgent,
  type AgentMention,
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

export const CommentsMargin = observer(function CommentsMargin({
  store,
}: {
  store: DocCommentsStore;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const unresolved = store.unresolvedThreads;
  const resolved = store.resolvedThreads;

  // No left border of its own: the resize handle beside it is the divider.
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background-secondary-1">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-xs text-foreground-muted">Comments</span>
        {unresolved.length > 0 && (
          <Badge variant="secondary" className="shrink-0">
            {unresolved.length}
          </Badge>
        )}
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

        <div className="flex flex-col gap-3">
          {unresolved.map((thread) => (
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
    <div className="mt-2.5 rounded-md border border-dashed border-border-1 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <AgentIcon id={pending.request.providerId} size={12} className="shrink-0" />
        <span className={cn('text-tiny text-foreground-passive', !waiting && 'animate-pulse')}>
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

function Card({
  children,
  focused,
  muted,
  onClick,
}: {
  children: React.ReactNode;
  focused?: boolean;
  muted?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'rounded-md border bg-background px-2.5 py-2.5',
        focused ? 'border-border-primary' : 'border-border',
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

/** Author line plus body — the unit a thread is a stack of. */
function CommentBody({ message }: { message: RigCommentMessage }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <AuthorLine message={message} />
      <MarkdownRenderer content={message.body} variant="compact" className="text-sm" />
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
  const focused = store.focusedThreadId === root.id;
  const busy = store.isPending(root.id);
  const quote = root.anchor ? shortenQuote(root.anchor.exact, 160) : null;
  const agent = useThreadAgent(thread);

  return (
    <Card focused={focused} muted={thread.resolved} onClick={() => store.focusThread(root.id)}>
      {/* Context before content: what the thread points at, then what was said. */}
      {quote !== null && (
        <p
          className="mb-2 line-clamp-2 border-l-2 border-border-1 pl-2 text-tiny text-foreground-passive"
          title={root.anchor?.exact}
        >
          {quote}
        </p>
      )}

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

      {replies.length > 0 && (
        <div className="mt-2.5 flex flex-col gap-2.5 border-t border-border pt-2.5">
          {replies.map((reply) => (
            <CommentBody key={reply.id} message={reply} />
          ))}
        </div>
      )}

      <AgentReplyCard store={store} rootId={root.id} />

      <div className="mt-2.5 flex flex-col gap-1.5">
        {focused && <ReplyComposer store={store} thread={thread} agent={agent} disabled={busy} />}
        <div className="flex items-center gap-2">
          {!focused && (
            <button
              type="button"
              className="shrink-0 text-xs text-foreground-muted hover:text-foreground"
              onClick={() => store.focusThread(root.id)}
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
