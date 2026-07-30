import { ChevronDown, ChevronRight } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';
import { RelativeTime } from '@renderer/lib/ui/relative-time';
import { Textarea } from '@renderer/lib/ui/textarea';
import { cn } from '@renderer/utils/utils';
import type { RigCommentMessage } from '@shared/rig/comments';
import { shortenQuote } from './anchors';
import type { CommentThread, DocCommentsStore } from './comments-store';

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

        <div className="flex flex-col gap-2">
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
              <div className="mt-2 flex flex-col gap-2">
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
        'rounded-md border bg-background px-2.5 py-2',
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
 * `rig · <model> (with <human>)[ · per <onBehalfOf>]`. The scaffolding is muted;
 * the human name keeps the primary treatment.
 */
function AuthorLine({ message }: { message: RigCommentMessage }) {
  const human = message.author.name || 'someone';
  const isAgent = message.author.kind === 'agent';
  const model = metaString(message.meta, 'model');
  const onBehalfOf = metaString(message.meta, 'onBehalfOf');
  const attribution = isAgent
    ? `rig${model === null ? '' : ` · ${model}`} (with ${human})${
        onBehalfOf === null ? '' : ` · per ${onBehalfOf}`
      }`
    : human;

  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
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
        className="ml-auto shrink-0 text-[10px] text-foreground-muted"
      />
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

  return (
    <Card focused={focused} muted={thread.resolved} onClick={() => store.focusThread(root.id)}>
      <AuthorLine message={root} />

      {thread.orphan && (
        <div className="mt-1">
          <Badge
            variant="secondary"
            className="shrink-0"
            title="The quoted passage has changed since this comment was made, so it can no longer be located in the document."
          >
            original text changed
          </Badge>
        </div>
      )}

      {quote !== null && (
        <p
          className="mt-1 line-clamp-2 border-l-2 border-border-1 pl-2 text-xs text-foreground-muted"
          title={root.anchor?.exact}
        >
          {quote}
        </p>
      )}

      <MarkdownRenderer content={root.body} variant="compact" className="mt-1 text-sm" />

      {replies.length > 0 && (
        <div className="mt-2 flex flex-col gap-2 border-t border-border pt-2">
          {replies.map((reply) => (
            <div key={reply.id}>
              <AuthorLine message={reply} />
              <MarkdownRenderer content={reply.body} variant="compact" className="text-sm" />
            </div>
          ))}
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        {focused ? (
          <ReplyComposer store={store} rootId={root.id} disabled={busy} />
        ) : (
          <button
            type="button"
            className="text-xs text-foreground-muted hover:text-foreground"
            onClick={() => store.focusThread(root.id)}
          >
            Reply
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          className="ml-auto shrink-0 text-xs text-foreground-muted hover:text-foreground disabled:opacity-50"
          onClick={() => void store.setResolved(root.id, !thread.resolved)}
        >
          {thread.resolved ? 'Reopen' : 'Resolve'}
        </button>
      </div>
    </Card>
  );
});

const ReplyComposer = observer(function ReplyComposer({
  store,
  rootId,
  disabled,
}: {
  store: DocCommentsStore;
  rootId: string;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState('');

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    const sent = await store.reply(rootId, text);
    if (sent) setDraft('');
  }, [draft, rootId, store]);

  return (
    <Textarea
      value={draft}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          void send();
        }
      }}
      placeholder="Reply…"
      rows={1}
      className="max-h-32 min-h-8 py-1.5 text-sm"
    />
  );
});

/** The composer for a brand-new thread, bound to the quote that opened it. */
const NewThreadCard = observer(function NewThreadCard({ store }: { store: DocCommentsStore }) {
  const [draft, setDraft] = useState('');
  const quote = store.composerQuote ?? '';
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const notice = stateNotice(store);
  const busy = store.isPending('new');

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    const posted = await store.create(quote, text);
    if (posted) setDraft('');
  }, [draft, quote, store]);

  return (
    <div className="mb-2 rounded-md border border-border-primary bg-background px-2.5 py-2">
      <p
        className="line-clamp-2 border-l-2 border-border-1 pl-2 text-xs text-foreground-muted"
        title={quote}
      >
        {shortenQuote(quote, 160)}
      </p>

      {notice !== null ? (
        <p className="mt-2 text-xs text-foreground-muted">{notice}</p>
      ) : (
        <Textarea
          ref={inputRef}
          value={draft}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
            if (event.key === 'Escape') store.closeComposer();
          }}
          placeholder="Comment…"
          rows={2}
          className="mt-2 max-h-40 min-h-14 py-1.5 text-sm"
        />
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
