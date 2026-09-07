import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, WifiOff } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useRigSignIn } from '@renderer/features/rig-account/use-rig-sign-in';
import { useAnchorRect } from '@renderer/lib/hooks/use-anchor-rect';
import { rpc } from '@renderer/lib/ipc';
import { AgentIcon } from '@renderer/lib/ui/agent-icon';
import { Button } from '@renderer/lib/ui/button';
import { CommentMarkdown } from '@renderer/lib/ui/comment-markdown';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { RigMark } from '@renderer/lib/ui/rig-mark';
import { Textarea } from '@renderer/lib/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import type { AgentIconAsset } from '@shared/core/agents/agent-payload';
import {
  getCommentProposal,
  type RigCommentMessage,
  type RigCommentPermissionRequest,
} from '@shared/rig/comments';
import { canApplyProposal } from '../paintbrush/paintbrush-apply';
import { shortenQuote } from './anchors';
import { offlineChipLabel } from './comments-cache';
import {
  COMMENT_FILTERS,
  providerIdForAgentLabel,
  threadAgent,
  type AgentMention,
  type CommentFilter,
  type CommentThread,
  type DocCommentsStore,
} from './comments-store';
import { layoutMarginCards, MARGIN_CARD_GAP, type MarginLayoutItem } from './margin-layout';
import { minimalScrollDelta } from './pending-reveal';
import { plainAllowOptionId, rawPermissionDetailText, summarizePermissionDetail } from './permission-summary';
import type { CommentSurfaceAdapter } from './surface-adapter';
import {
  findMention,
  MENTION_TOKEN,
  mentionCandidateKey,
  mentionCandidateLabel,
  mentionCandidateMatches,
  mentionInsertText,
  type MentionCandidate,
  type PersonMention,
} from './mention-candidates';

/**
 * The right-margin comment rail, rebuilt to Google Docs' exact model per
 * Dylan's punch list after the first real test against `knee-ability-rig`:
 * cards sit in the gutter aligned to their anchor's Y; overlapping cards push
 * down; a card shrinking (collapsing, folding replies, closing "Show more")
 * pulls everything below it back up; the active card nudges toward the doc
 * with a strengthened anchor highlight; there is no permanent connector — only
 * the active card gets a short one, fading in. The stacking math itself lives
 * in `margin-layout.ts` as a pure, unit-tested function; this file is purely
 * about feeding it live anchor/height measurements and rendering the result.
 */

const RAIL_WIDTH = 260;
const RAIL_RIGHT = 24;
const DEFAULT_CARD_HEIGHT = 90;
/** Keeps a revealed anchor off the scroll container's exact edge. */
const REVEAL_PADDING = 24;
/** From this many replies, the middle of a thread folds away by default. */
const FOLD_FROM_REPLIES = 4;
/** How much of the end of a folded thread stays visible. */
const FOLD_TAIL = 2;
/** Comment bodies clamp to this many lines before needing "Show more". */
const BODY_CLAMP_LINES = 6;

/** True when the margin has anything to show. */
export function shouldShowMargin(store: DocCommentsStore | null): boolean {
  return store !== null && store.hasContent;
}

const FILTER_LABELS: Record<CommentFilter, string> = {
  all: 'All',
  unresolved: 'Unresolved',
  new: 'New',
  resolved: 'Resolved',
  agent: 'Agent',
};

const FILTER_EMPTY: Record<CommentFilter, string> = {
  all: 'No comments on this document yet.',
  unresolved: 'No unresolved threads.',
  new: 'Nothing new.',
  resolved: 'No resolved threads.',
  agent: 'No threads an agent has spoken in.',
};

// ── @mentions ────────────────────────────────────────────────────────────────

/**
 * The agents this machine can actually run, for the `@mention` menu.
 *
 * Trimmed from emdash's `useAgents`/`useAgentInstallationStatuses` mobx-store
 * pair to a direct `rpc.agents.list()` read — `AgentPayload.status` already
 * carries the installation state, so a second RPC wasn't needed.
 *
 * `status === 'available'` only proves the CLI is *installed* — it does not
 * probe a full headless dispatch, so a provider whose binary is broken in a
 * way the install check can't see (as codex's missing platform dependency
 * was, see the P0 report) can still appear here and still fail on mention.
 * That's an honest limitation of the underlying status check, not something
 * papered over here with a hardcoded exclusion list.
 */
function useMentionableAgents(): AgentMention[] {
  const { data } = useQuery({
    queryKey: ['agents', 'list'],
    queryFn: () => rpc.agents.list(),
    staleTime: 30_000,
  });
  return useMemo(
    () =>
      (data ?? [])
        .filter((agent) => agent.status === 'available')
        .map((agent) => ({ providerId: agent.id, name: agent.name })),
    [data]
  );
}

/**
 * Provider id → its own mark, for every provider in the catalog — not
 * filtered to installed/available like `useMentionableAgents`, since a
 * message an agent already posted should keep showing its icon even if that
 * provider is later uninstalled. Static plugin assets, so a long `staleTime`
 * is safe (there is no live-probing cost like `agents.list()` has).
 */
function useAgentIcons(): Map<string, AgentIconAsset> {
  const { data } = useQuery({
    queryKey: ['agents', 'metadata'],
    queryFn: () => rpc.agents.listMetadata(),
    staleTime: Infinity,
  });
  return useMemo(() => new Map((data ?? []).map((agent) => [agent.id, agent.icon])), [data]);
}

/**
 * Everyone on the binding this document belongs to, for the `@mention`
 * menu's People section. Self may appear (Docs allows mentioning yourself);
 * no filtering beyond what the relay already applies (binding membership).
 */
function usePeopleMentions(path: string): PersonMention[] {
  const { data } = useQuery({
    queryKey: ['rig', 'comments', 'members', path],
    queryFn: () => rpc.rig.comments.listMembers({ absPath: path }),
    staleTime: 30_000,
  });
  return useMemo(
    () =>
      data?.success
        ? data.data.members.map((member) => ({
            userId: member.userId,
            name: member.name,
            avatarUrl: member.avatarUrl,
          }))
        : [],
    [data]
  );
}

function useThreadAgent(store: DocCommentsStore, thread: CommentThread): AgentMention | null {
  const agents = useMentionableAgents();
  const selfUserId = store.selfUserId;
  return useMemo(() => threadAgent(thread, agents, null, selfUserId), [agents, thread, selfUserId]);
}

/**
 * Viewport rect of the composer/caret the mention menu should anchor to, kept
 * live while the menu is open — `lib/hooks/use-anchor-rect.ts`'s shared
 * hook, not a local copy (round 14 gave it placement-aware flipping, which
 * this menu needs exactly as much as the harness picker does: a reply box
 * near the bottom of the margin is a routine case, not an edge one).
 *
 * Every margin card is an absolutely-positioned sibling of the others — its
 * own stacking context, in DOM order, that no in-card `z-index` can escape.
 * A card lower in the list (a reply thread nearer the top of the doc, say)
 * always painted over an earlier card's dropdown regardless of z-index. The
 * fix is to render the menu outside the rail's stacking entirely — a portal
 * to `document.body`, `position: fixed`, tracking the textarea's own rect
 * rather than relying on any ancestor's layout. Recomputed on resize and on
 * any scroll (capture-phase, since the shared doc/margin container's own
 * scroll doesn't bubble to `window`) so the menu doesn't drift from the
 * caret while open.
 */

/** The composer input, with `@` autocomplete over the runnable agents. */
function MentionTextarea({
  value,
  agents,
  people,
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
  people: PersonMention[];
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
  const icons = useAgentIcons();

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  // Agents first, then people — arrow-key order matches the visual order the
  // rows render in (People rendered as a labeled group after Agents, below).
  const candidates = useMemo<MentionCandidate[]>(
    () => [
      ...agents.map((agent): MentionCandidate => ({ kind: 'agent', agent })),
      ...people.map((person): MentionCandidate => ({ kind: 'person', person })),
    ],
    [agents, people]
  );

  const matches = useMemo(() => {
    if (query === null) return [];
    return candidates.filter((candidate) => mentionCandidateMatches(candidate, query));
  }, [candidates, query]);
  const open = matches.length > 0;
  // ~26px/row (text-xs at py-1) — a rough guide for which side to open on;
  // `maxHeight` below is the real cap regardless of how many matches there are.
  const anchorRect = useAnchorRect(open, inputRef, { estimatedHeight: matches.length * 26 + 8 });
  const firstPersonIndex = matches.findIndex((candidate) => candidate.kind === 'person');

  const select = useCallback(
    (candidate: MentionCandidate) => {
      const input = inputRef.current;
      if (!input) return;
      const caret = input.selectionStart ?? value.length;
      const token = MENTION_TOKEN.exec(value.slice(0, caret));
      if (!token) return;
      const at = caret - token[1].length - 1;
      const insert = mentionInsertText(candidate);
      onChange(`${value.slice(0, at)}${insert}${value.slice(caret)}`);
      setQuery(null);
      const next = at + insert.length;
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

      {open &&
        anchorRect &&
        createPortal(
          <div
            className="border-border-hairline bg-bg-1 rounded-control shadow-soft fixed z-50 border"
            style={{
              left: anchorRect.left,
              width: anchorRect.width,
              maxHeight: anchorRect.maxHeight,
              overflowY: 'auto',
              ...(anchorRect.placement === 'below' ? { top: anchorRect.top } : { bottom: anchorRect.bottom }),
            }}
          >
            {matches.map((candidate, index) => {
              const icon =
                candidate.kind === 'agent' ? icons.get(candidate.agent.providerId) : undefined;
              return (
                <Fragment key={mentionCandidateKey(candidate)}>
                  {index === firstPersonIndex && firstPersonIndex > 0 && (
                    <div className="text-text-muted border-border-hairline border-t px-2 pt-1.5 pb-0.5 text-xs font-medium tracking-wide uppercase">
                      People
                    </div>
                  )}
                  <button
                    type="button"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      select(candidate);
                    }}
                    onMouseEnter={() => setHighlight(index)}
                    className={cn(
                      'flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs',
                      index === highlight ? 'bg-bg-2 text-text-primary' : 'text-text-secondary'
                    )}
                  >
                    {candidate.kind === 'agent' ? (
                      <>
                        {/* Each row is a specific provider, not rig-the-system
                            — its own mark, not the rig mark. */}
                        {icon !== undefined && (
                          <AgentIcon icon={icon} size={11} className="shrink-0" />
                        )}
                        <span className="min-w-0 truncate">{candidate.agent.name}</span>
                        <span className="text-text-muted ml-auto shrink-0 font-mono text-xs">
                          @{candidate.agent.providerId}
                        </span>
                      </>
                    ) : (
                      <>
                        <IdentityAvatar
                          name={candidate.person.name}
                          avatarUrl={candidate.person.avatarUrl}
                          sizeClassName="size-[11px]"
                          textClassName="text-[6px]"
                          className="shrink-0"
                        />
                        <span className="min-w-0 truncate">
                          {mentionCandidateLabel(candidate)}
                        </span>
                      </>
                    )}
                  </button>
                </Fragment>
              );
            })}
          </div>,
          document.body
        )}
    </div>
  );
}

/**
 * A tool call the thread's agent is waiting to be allowed to make.
 *
 * Leads with a plain-English headline (`summarizePermissionDetail`) rather
 * than the raw tool-call title a technical chat pane can get away with — this
 * card sits in a Google-Docs-style comment thread a non-technical
 * collaborator reads, and a base64 target ref or a full shell command is
 * noise, not information, to that reader. The exact command/path/URL is
 * still one click away behind "Show details", in monospace, for anyone who
 * wants it.
 *
 * Allow/Reject stay real buttons. The provider's own persistent grant
 * (`allow_always` — Claude's own labels read "Always Allow all Bash" etc.,
 * session-scoped and silently gone the moment this headless turn's session
 * ends) is never rendered and never invoked: the relay it actually promises
 * — skipping the ask on future turns too — only exists through the app-wide
 * "Auto-approve agent actions" setting (`settings-modal.tsx`,
 * `main/rig/comment-agent-auto-approve.ts`'s `partitionGloballyApprovable`).
 * A request offering that option instead shows one quiet text link that
 * turns the real setting on and grants THIS request through its own
 * `allow_once` option — never `allow_always` — so the reader gets an honest
 * "yes, and stop asking from now on" rather than a promise the next mention's
 * fresh session would silently break.
 */
export const PermissionRequestRow = observer(function PermissionRequestRow({
  store,
  rootId,
  request,
  workspaceRoot,
}: {
  store: DocCommentsStore;
  rootId: string;
  request: RigCommentPermissionRequest;
  workspaceRoot: string | null;
}) {
  const busy = store.isPending(request.requestId);
  const { headline, secondary } = summarizePermissionDetail(request.detail, workspaceRoot);
  const rawDetail = rawPermissionDetailText(request.detail);

  const oneShot = request.options.filter((option) => option.kind !== 'allow_always');
  const offersPersistentOption = request.options.some((option) => option.kind === 'allow_always');
  const plainOptionId = plainAllowOptionId(request.options);

  const enableAutoApprove = () => {
    void rpc.rig.settings.set({ autoApproveAgentActions: true });
    if (plainOptionId) {
      store.resolveAgentPermission(rootId, request.requestId, plainOptionId);
    }
  };

  return (
    <div className="border-border-hairline mt-1.5 border-t pt-1.5">
      <p className="text-text-primary text-xs">{headline}</p>
      {secondary !== undefined && (
        <p className="text-text-muted mt-0.5 truncate text-xs" title={secondary}>
          {secondary}
        </p>
      )}
      {request.reason !== undefined && (
        <p className="text-text-muted mt-0.5 text-xs italic">{request.reason}</p>
      )}
      {rawDetail !== null && (
        <details className="mt-1">
          <summary className="text-text-muted hover:text-text-primary cursor-pointer text-xs">
            Show details
          </summary>
          <p className="bg-bg-0 text-text-primary mt-1 line-clamp-6 rounded-control px-1.5 py-1 font-mono text-xs break-all whitespace-pre-wrap">
            {rawDetail}
          </p>
        </details>
      )}
      <div className="mt-1 flex flex-wrap gap-1">
        {oneShot.map((option) => (
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
      {offersPersistentOption && (
        <button
          type="button"
          disabled={busy}
          className="text-text-muted hover:text-text-primary mt-1 block text-xs underline-offset-2 hover:underline disabled:opacity-50"
          onClick={(event) => {
            event.stopPropagation();
            enableAutoApprove();
          }}
        >
          Always allow — turn on auto-approve for agents
        </button>
      )}
    </div>
  );
});

/** "1m 40s" past a minute, "40s" under one — no padding, matching `relativeTime`'s style. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * A live "working · 1m 40s" tick, in mono metadata per the design system's
 * "mono for metadata, always" rule. It remains useful beside streaming text:
 * the reader can distinguish a slow but active turn from a newly stalled one.
 */
function ElapsedTick({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <span className="font-mono">{formatElapsed(now - since)}</span>;
}

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
    // Full message, wrapped — a truncated one-liner ("The agent could not
    // b…") gives the reader nothing to act on. Actions sit below the message
    // rather than beside it, now that the message can run to several lines.
    return (
      <div className="border-border-strong text-warning mt-2.5 rounded-control border border-dashed px-2 py-1.5 text-xs">
        {pending.text && (
          <div className="mb-2 max-h-48 overflow-y-auto text-text-primary">
            <CommentMarkdown content={pending.text} />
          </div>
        )}
        <p className="min-w-0 break-words whitespace-pre-wrap">{pending.error}</p>
        <div className="mt-1.5 flex items-center gap-2">
          <button
            type="button"
            className="hover:text-text-primary shrink-0 underline"
            onClick={() => store.retryAgentReply(rootId)}
          >
            Retry
          </button>
          <button
            type="button"
            className="text-text-muted hover:text-text-primary shrink-0"
            onClick={() => store.dismissAgentReply(rootId)}
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  const waiting = permissions.length > 0;
  const activity = waiting
    ? 'Permission needed'
    : pending.activity === 'thinking'
      ? 'Thinking'
      : pending.activity === 'checking-context'
        ? 'Checking Rig context'
        : pending.activity === 'using-tool'
          ? 'Using a tool'
          : 'Working';
  return (
    <div className="border-border-hairline text-text-muted mt-2.5 border-t pt-2 text-xs">
      <div className="flex min-w-0 items-center gap-1.5">
        <RigMark size={11} className="shrink-0" />
        <span className="min-w-0 truncate">
          {pending.agentName} · {activity}
        </span>
        <span className="ml-auto shrink-0">
          <ElapsedTick since={pending.startedAt} />
        </span>
      </div>
      {pending.text && (
        <p className="text-text-muted mt-1.5 line-clamp-4 text-xs leading-relaxed whitespace-pre-wrap">
          {pending.text}
        </p>
      )}
      {permissions.map((request) => (
        <PermissionRequestRow
          key={request.requestId}
          store={store}
          rootId={rootId}
          request={request}
          workspaceRoot={store.agentPermissionsWorkspaceRootFor(rootId)}
        />
      ))}
    </div>
  );
});

// ── card shell ───────────────────────────────────────────────────────────────

/** Controls that own their own click; a click on one is not a card selection. */
const INTERACTIVE = 'button, a, input, textarea, select, [role="button"], [contenteditable]';

/**
 * The short connector between an active card and the document — the only
 * connector there is now (Dylan: the permanent one on every card was "hard to
 * read"). Fades in on mount via a one-frame opacity flip rather than an
 * always-present, always-dim line: association is carried by gutter alignment
 * and the synchronized highlight; this is a small extra confirmation for the
 * one card that's currently selected, not a standing map of every thread.
 */
function ActiveConnector({ muted }: { muted?: boolean }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute top-4 -left-3 h-px w-3 transition-opacity duration-150 ease-out',
        // Resolved stays gray "everywhere, active or not" (Dylan) — the
        // connector is part of the active treatment, so it follows the same
        // rule as the card's own border below.
        muted ? 'bg-text-muted' : 'bg-accent',
        shown ? 'opacity-70' : 'opacity-0'
      )}
    />
  );
}

const Card = observer(function Card({
  children,
  active,
  hovered,
  muted,
  compact,
  hasAnchor = true,
  onActivate,
}: {
  children: React.ReactNode;
  active?: boolean;
  /** The card's anchored passage is under the pointer in the document. Ignored while `active` (already maximally emphasized). */
  hovered?: boolean;
  muted?: boolean;
  compact?: boolean;
  /**
   * Whether this card currently has a real, locatable anchor position — an
   * orphaned/unresolved thread, or a composer whose quote couldn't be
   * found, has none. Gates the active connector: pointing a "this connects
   * to the document" line at nothing reads as a stray, disconnected
   * artifact rather than a broken confirmation. Defaults `true` since most
   * callers (every `ThreadCard`/`NewThreadCard`) do have one and pass it
   * explicitly; the default only matters for a future caller that doesn't.
   */
  hasAnchor?: boolean;
  onActivate?: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  // The active card nudges toward the document — the Docs "this one's mine"
  // cue. It does NOT scroll itself into view: that used to live here, guarded
  // by a ref, and broke every time a regrouping remounted the card (resolving
  // a thread moving it into the resolved section was the fourth such bug).
  // Revealing a card is now a one-shot command owned by the store
  // (`pendingReveal`) and executed by a single effect in `MarginRail` — cards
  // never call `scrollIntoView`.

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onActivate) return;
    if (event.target instanceof Element && event.target.closest(INTERACTIVE)) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && ref.current?.contains(selection.anchorNode)) {
      return;
    }
    onActivate();
  };

  return (
    <div
      ref={ref}
      onClick={handleClick}
      className={cn(
        'border-border-hairline bg-bg-1 relative rounded-card border px-2.5 shadow-soft transition-[border-color,transform] duration-150 ease-out',
        // Resolved stays gray "everywhere, active or not" — a resolved thread
        // never gets the accent border, even while active; it gets the same
        // neutral emphasis a hovered (but inactive) card gets instead.
        active && (muted ? 'border-border-strong -translate-x-1' : 'border-accent -translate-x-1'),
        !active && hovered && 'border-border-strong -translate-x-0.5',
        compact ? 'py-1' : 'py-2.5',
        // The gray BORDER treatment above stays "everywhere, active or not"
        // (Dylan) — but the dimmed OPACITY doesn't: a resolved thread
        // brought forward as the active card is still the thing someone's
        // reading right now, and 70% opacity made its text illegible
        // (screenshot). Opacity now only applies while a resolved thread is
        // NOT the active one — secondary in the list, full legibility once
        // it's the one in focus.
        muted && !active && 'opacity-70'
      )}
    >
      {active && hasAnchor && <ActiveConnector muted={muted} />}
      {children}
    </div>
  );
});

function metaString(meta: Record<string, unknown> | null, key: string): string | null {
  const value = meta?.[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Coarse "2h ago" / "3d ago" formatting — a local stand-in for the ported `RelativeTime` component. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.round(days / 30);
  return `${months}mo`;
}

function AuthorLine({ message }: { message: RigCommentMessage }) {
  const human = message.author.name || 'someone';
  const isAgent = message.author.kind === 'agent';
  const isGuest = message.author.kind === 'guest';
  const model = metaString(message.meta, 'model');
  const providerId = providerIdForAgentLabel(message.meta);
  const icons = useAgentIcons();
  const icon = providerId !== null ? icons.get(providerId) : undefined;

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {/* The rig mark is rig-the-system's own identity — always first, and
          the only thing that stays a RigMark. The harness that actually
          answered (its own icon) follows it, not replaces it. */}
      {isAgent && providerId !== null && <RigMark size={11} className="text-text-muted shrink-0" />}
      {isAgent ? (
        <span className="text-text-muted flex min-w-0 items-center gap-1 text-xs">
          <span className="shrink-0">rig</span>
          {icon !== undefined && <AgentIcon icon={icon} size={11} className="shrink-0" />}
          <span className="min-w-0 truncate">
            {model !== null ? `· ${model} ` : ''}(with{' '}
            <span className="text-text-primary font-medium">{human}</span>)
          </span>
        </span>
      ) : isGuest ? (
        <span className="flex min-w-0 items-center gap-1.5">
          {/* Own name/avatarUrl only, straight off this message's author —
              never looked up against the binding members cache, which has
              no row for a non-member guest anyway. Falls back to initials,
              then a generic person glyph (see `IdentityAvatar`) — never the
              rig mark, never a member's own avatar. */}
          <IdentityAvatar
            name={message.author.name}
            avatarUrl={message.author.avatarUrl}
            sizeClassName="size-[11px]"
            textClassName="text-[6px]"
            className="shrink-0"
          />
          <span className="text-text-primary min-w-0 truncate text-xs font-medium">{human}</span>
          {/* Provenance, per design-system rule 9's subtext treatment: quiet
              mono, but never absent — a guest comment always says so. */}
          <span className="text-text-muted shrink-0 font-mono text-xs">via share link</span>
        </span>
      ) : (
        <span className="text-text-primary min-w-0 truncate text-xs font-medium">{human}</span>
      )}
      <span className="text-text-muted ml-auto shrink-0 font-mono text-xs">
        {relativeTime(message.createdAt)}
      </span>
    </div>
  );
}

/**
 * A comment body clamped to `BODY_CLAMP_LINES`, with a "Show more" expander
 * that only appears when the content actually overflows — measured after
 * render rather than guessed from character count, since markdown's line
 * count depends on how it wraps at the rail's width. Expanding changes the
 * card's height, which the rail's `ResizeObserver` picks up on its own and
 * reflows everything below — no callback needs threading through for that.
 *
 * `forceExpanded` (the thread's `active` state) overrides the clamp
 * entirely — Google Docs shows the active thread's full text regardless of
 * length; the clamp is something only an *inactive* card does. Manually
 * expanding via "Show more" is remembered independently of activation: it
 * survives the card losing `active` (a deliberate "show more" click stays
 * honored), it just stops being the only thing keeping the text unclamped.
 */
function ClampedBody({ content, forceExpanded }: { content: string; forceExpanded: boolean }) {
  const [manuallyExpanded, setManuallyExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const expanded = forceExpanded || manuallyExpanded;

  useLayoutEffect(() => {
    if (expanded) return;
    const el = ref.current;
    if (!el) return;
    setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [content, expanded]);

  return (
    <div>
      <div
        ref={ref}
        className={!expanded ? 'overflow-hidden' : undefined}
        style={!expanded ? { display: '-webkit-box', WebkitLineClamp: BODY_CLAMP_LINES, WebkitBoxOrient: 'vertical' } : undefined}
      >
        <CommentMarkdown content={content} />
      </div>
      {overflowing && !expanded && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setManuallyExpanded(true);
          }}
          className="text-accent mt-1 text-xs hover:underline"
        >
          Show more
        </button>
      )}
    </div>
  );
}

/**
 * Author line plus body. Markdown-rendered (bold/italic/code/lists/links) via
 * `CommentMarkdown`, clamped to `BODY_CLAMP_LINES` with a "Show more" — a
 * single long reply must not, on its own, push the whole rail down (combined
 * with folding replies below and the rail's own reflow). Clamp is skipped
 * entirely while the thread is active.
 */
function CommentBody({ message, active }: { message: RigCommentMessage; active: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <AuthorLine message={message} />
      <ClampedBody content={message.body} forceExpanded={active} />
    </div>
  );
}

/**
 * Paintbrush outcome (`docs/document-focus-design.md` §2, step 5): a reply
 * carrying `meta.proposal` gets an Apply button that splices the proposed
 * replacement over the thread's anchored range. Renders nothing for an
 * ordinary reply — the vast majority, unchanged.
 *
 * Resolvability is checked with the same pure, anchor-only logic
 * `DocCommentsStore.applyProposal` re-checks before actually splicing
 * (`canApplyProposal`) — computed fresh on every render (cheap: a string
 * search over the live buffer, no CM6 involved) so the button's
 * enabled/disabled state never drifts from what clicking it would actually
 * do. An anchor that can no longer be resolved (the passage changed since
 * the stroke) disables Apply with an explanatory tooltip rather than ever
 * guessing a position.
 */
const ProposalApplyRow = observer(function ProposalApplyRow({
  store,
  thread,
  reply,
}: {
  store: DocCommentsStore;
  thread: CommentThread;
  reply: RigCommentMessage;
}) {
  const proposal = getCommentProposal(reply.meta);
  if (!proposal) return null;

  if (store.isProposalApplied(reply.id)) {
    return (
      <span className="bg-bg-2 text-text-muted mt-1.5 inline-flex w-fit items-center rounded-chip px-1.5 py-0.5 font-mono text-xs">
        Applied
      </span>
    );
  }

  const canApply = canApplyProposal(store.documentContent, thread.root.anchor);
  const apply = (event: React.MouseEvent) => {
    event.stopPropagation();
    store.applyProposal(thread.root.id, reply.id, proposal.replacement);
  };

  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {/* Apply must be informed consent: the reader sees exactly what will
          replace the anchored passage — the reply prose alone doesn't carry
          the replacement (the sentinel block is stripped before posting). */}
      <div className="border-border bg-bg-2 text-text max-h-40 overflow-y-auto whitespace-pre-wrap rounded border px-2 py-1.5 text-xs">
        {proposal.replacement}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button size="xs" variant="secondary" disabled={!canApply} onClick={apply}>
              Apply
            </Button>
          }
        />
        {!canApply && (
          <TooltipContent side="bottom">text has changed — apply manually</TooltipContent>
        )}
      </Tooltip>
    </div>
  );
});

function lastSpeaker(thread: CommentThread): string {
  const last = thread.replies[thread.replies.length - 1] ?? thread.root;
  return last.author.kind === 'agent' ? 'rig' : last.author.name || 'someone';
}

/** The control that opens a thread's folded middle — restores the folded replies. */
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
      <span aria-hidden className="bg-border-hairline absolute inset-x-0 top-1/2 h-px" />
      <button
        type="button"
        className="border-border-hairline bg-bg-1 text-text-muted hover:text-text-primary relative inline-flex items-center gap-1 rounded-chip border px-2 py-0.5 text-xs"
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
  const hovered = store.hoveredThreadId === root.id;
  const busy = store.isPending(root.id);
  const collapsed = store.isThreadCollapsed(root.id);
  const unread = store.isThreadUnread(thread);
  const agent = useThreadAgent(store, thread);

  const summary = shortenQuote(root.anchor?.exact ?? root.body, 140);

  // Long threads fold their middle away by default — a single long thread
  // must not shove the whole rail down.
  const folded =
    !collapsed && !store.areThreadRepliesExpanded(root.id) && replies.length >= FOLD_FROM_REPLIES;
  const shownReplies = folded ? replies.slice(-FOLD_TAIL) : replies;
  const foldedAway = replies.length - shownReplies.length;

  return (
    <Card
      active={active}
      hovered={hovered}
      muted={thread.resolved}
      compact={collapsed}
      hasAnchor={thread.index !== null}
      onActivate={() => store.setActiveThread(root.id)}
    >
      <button
        type="button"
        title={collapsed ? 'Expand thread' : 'Collapse thread'}
        onClick={(event) => {
          event.stopPropagation();
          store.toggleThreadCollapsed(root.id);
        }}
        className={cn(
          'flex w-full min-w-0 gap-1.5 text-left',
          collapsed ? 'items-center' : 'items-start',
          !collapsed && 'mb-2'
        )}
      >
        {collapsed ? (
          <ChevronRight className="text-text-muted size-3 shrink-0" />
        ) : (
          <ChevronDown className="text-text-muted mt-px size-3 shrink-0" />
        )}
        <span
          className={cn(
            'border-border-strong text-text-muted min-w-0 flex-1 border-l text-xs',
            collapsed ? 'truncate pl-1.5' : 'line-clamp-2 border-l-2 pl-2'
          )}
          title={root.anchor?.exact ?? root.body}
        >
          {summary}
        </span>
        {collapsed && (
          <span className="text-text-muted shrink-0 font-mono text-xs">
            {lastSpeaker(thread)} · {replies.length + 1}
          </span>
        )}
        {unread && <span className="bg-accent size-1.5 shrink-0 rounded-chip" />}
      </button>

      {!collapsed && (
        <>
          {thread.orphan && (
            <div className="mb-2">
              <span
                className="bg-bg-2 text-text-muted rounded-chip px-1.5 py-0.5 font-mono text-xs"
                title="The quoted passage has changed since this comment was made, so it can no longer be located in the document."
              >
                original text no longer present
              </span>
            </div>
          )}

          <CommentBody message={root} active={active} />

          {(shownReplies.length > 0 || foldedAway > 0) && (
            <div className="mt-2.5 flex flex-col gap-2.5">
              {foldedAway > 0 && (
                <MoreRepliesButton count={foldedAway} store={store} rootId={root.id} />
              )}
              {shownReplies.map((reply, index) => (
                <div
                  key={reply.id}
                  className={cn(!(index === 0 && foldedAway > 0) && 'border-border-hairline border-t pt-2.5')}
                >
                  <CommentBody message={reply} active={active} />
                  <ProposalApplyRow store={store} thread={thread} reply={reply} />
                </div>
              ))}
            </div>
          )}

          <AgentReplyCard store={store} rootId={root.id} />

          {/* Always visible once expanded — Docs never makes you click
              "Reply" first to see where to type. */}
          <div className="mt-2.5 flex flex-col gap-1.5">
            <ReplyComposer store={store} thread={thread} agent={agent} disabled={busy} />
            <div className="flex items-center justify-end">
              <button
                type="button"
                disabled={busy}
                className="text-text-muted hover:text-text-primary shrink-0 text-xs disabled:opacity-50"
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
  agent: AgentMention | null;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState('');
  const agents = useMentionableAgents();
  const people = usePeopleMentions(store.path);
  const rootId = thread.root.id;
  const offline = store.state === 'offline';

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    const sent = await store.reply(rootId, text, findMention(text, agents) ?? agent ?? undefined);
    if (sent) setDraft('');
  }, [agent, agents, draft, rootId, store]);

  return (
    <div className="min-w-0 flex-1">
      <MentionTextarea
        value={draft}
        agents={agents}
        people={people}
        disabled={disabled || offline}
        onChange={setDraft}
        onSubmit={() => void send()}
        placeholder={offline ? 'Reconnect to comment' : 'Reply — @ to mention'}
        rows={1}
        className="max-h-32 min-h-8 py-1.5 text-sm"
      />
    </div>
  );
});

const SignInNotice = observer(function SignInNotice({ store }: { store: DocCommentsStore }) {
  const { phase, error, signIn } = useRigSignIn(() => void store.refresh());
  return (
    <div className="mt-2 flex flex-col items-start gap-1.5">
      <p className="text-text-muted text-xs">Sign in to Rig to load and post comments.</p>
      <Button variant="outline" size="xs" onClick={() => void signIn()} disabled={phase !== 'idle'}>
        {phase === 'idle' ? 'Sign in to Rig' : 'Waiting for sign-in…'}
      </Button>
      {error && <p className="text-danger text-xs">{error}</p>}
    </div>
  );
});

function stateNotice(store: DocCommentsStore): string | null {
  switch (store.state) {
    case 'notBound':
      return "This workspace isn't synced to a rig — comments are unavailable.";
    case 'untrustedRelay':
      return (
        store.errorMessage ??
        'This workspace points comments at an unrecognized relay — comments are disabled.'
      );
    case 'offline':
      return 'Reconnect to comment.';
    default:
      return null;
  }
}

const NewThreadCard = observer(function NewThreadCard({
  store,
  hasAnchor,
}: {
  store: DocCommentsStore;
  /** Whether the composer's quote currently resolves to a real document position — see `Card`'s own doc comment. */
  hasAnchor: boolean;
}) {
  const [draft, setDraft] = useState('');
  const quote = store.composerQuote ?? '';
  const agents = useMentionableAgents();
  const people = usePeopleMentions(store.path);
  const icons = useAgentIcons();
  // A paintbrush stroke arms the composer with its agent directly
  // (`docs/document-focus-design.md` §2, step 3) — the reader only types
  // the instruction, never `@agent`, so `@`-mention parsing is skipped
  // entirely for this composer.
  const paintbrushAgent = store.composerPaintbrushAgent;

  const blocked = store.state !== 'ready' && store.state !== 'error' && store.state !== 'loading';
  const notice = stateNotice(store);
  const busy = store.isPending('new');

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    const mention = paintbrushAgent ?? findMention(text, agents);
    const posted = await store.create(quote, text, mention, paintbrushAgent !== null);
    if (posted) setDraft('');
  }, [agents, draft, paintbrushAgent, quote, store]);

  return (
    // `muted`: the focused textarea inside already wears the accent focus
    // border — an accent card around an accent input read as a double
    // outline (feedback round 5). One accent line, on the thing focused.
    <Card active muted hasAnchor={hasAnchor}>
      <p
        className="border-border-strong text-text-muted line-clamp-2 border-l-2 pl-2 text-xs"
        title={quote}
      >
        {shortenQuote(quote, 140)}
      </p>

      {store.state === 'unauthenticated' ? (
        <SignInNotice store={store} />
      ) : notice !== null ? (
        <p className="text-text-muted mt-2 text-xs">{notice}</p>
      ) : (
        <div className="mt-2">
          {paintbrushAgent && (
            <div className="bg-bg-2 text-text-secondary mb-1.5 inline-flex w-fit items-center gap-1.5 rounded-chip px-2 py-1 text-xs">
              {icons.get(paintbrushAgent.providerId) !== undefined && (
                <AgentIcon icon={icons.get(paintbrushAgent.providerId)!} size={12} className="shrink-0" />
              )}
              <span>{paintbrushAgent.name}</span>
            </div>
          )}
          {paintbrushAgent ? (
            <Textarea
              autoFocus
              value={draft}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                } else if (event.key === 'Escape') {
                  store.closeComposer();
                }
              }}
              placeholder={`Tell ${paintbrushAgent.name} what to change…`}
              rows={2}
              className="max-h-40 min-h-14 py-1.5 text-sm"
            />
          ) : (
            <MentionTextarea
              autoFocus
              value={draft}
              agents={agents}
              people={people}
              disabled={busy}
              onChange={setDraft}
              onSubmit={() => void send()}
              onEscape={store.closeComposer}
              placeholder="Add a comment — @ to mention"
              rows={2}
              className="max-h-40 min-h-14 py-1.5 text-sm"
            />
          )}
        </div>
      )}

      <div className="mt-2 flex items-center justify-end gap-1.5">
        <Button variant="ghost" size="xs" onClick={store.closeComposer}>
          Cancel
        </Button>
        {!blocked && (
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
    </Card>
  );
});

// ── rail: anchored, reflowing positioning ───────────────────────────────────

type RailItem =
  | { key: string; kind: 'composer'; index: number | null }
  | { key: string; kind: 'thread'; index: number | null; thread: CommentThread }
  | { key: string; kind: 'resolved-toggle'; index: number | null };

function mapsEqual(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

/**
 * Feeds live anchor Y / card height measurements into `layoutMarginCards`
 * (the pure stacking math) and keeps re-running it — Google Docs' both-way
 * reflow: overlap pushes down, and anything that frees up space (a collapse,
 * a fold, a closed "Show more") pulls everything below it back up.
 *
 * A `ResizeObserver` on the container and every mounted card is what drives
 * this, not React re-renders: this store is a MobX class, and a parent that
 * doesn't itself read the observable a child's collapse toggle changed will
 * not re-render just because that child did — which is exactly the bug
 * report ("collapse doesn't pull cards back up"). Watching the actual DOM
 * boxes sidesteps that entirely; it reflows on *any* size change, MobX-driven
 * or not (a markdown "Show more", a window resize, a reply posted).
 */
function useMarginLayout(
  items: readonly RailItem[],
  /** Index into `items` of the active/composer card, when there is one — see `layoutMarginCards`'s priority mode. */
  activeIndex: number | null,
  containerRef: RefObject<HTMLDivElement | null>,
  surface: CommentSurfaceAdapter,
  /**
   * `store.surfaceEpoch` — bumped whenever the surface's own readiness or
   * measurability changes independent of `items`/`activeIndex` (a Preview
   * settle trigger, a CM6⇄Preview adapter swap). Included as a dependency
   * below purely to force the layout effect to re-run then; the recompute
   * itself always re-reads `surface` fresh.
   */
  surfaceEpoch: number
): {
  tops: Map<string, number>;
  setCardRef: (key: string) => (el: HTMLDivElement | null) => void;
} {
  const [tops, setTops] = useState<Map<string, number>>(new Map());
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const roRef = useRef<ResizeObserver | null>(null);
  const rafRef = useRef<number | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;

  const recompute = useCallback(() => {
    const container = containerRef.current;
    if (!container || !surface.ready()) return;

    const containerRect = container.getBoundingClientRect();
    const scrollTop = container.scrollTop;
    const docLength = surface.docLength();

    const layoutItems: MarginLayoutItem[] = itemsRef.current.map((item) => {
      const pos = item.index !== null ? Math.min(item.index, docLength) : null;
      const coords = pos !== null ? surface.coordsAtPos(pos) : null;
      // The one alignment rule, lived in exactly one place rather than once
      // per surface: a card's top is its anchor's `coords.top`, rebased
      // onto the scroll container. `cm6SurfaceAdapter` and
      // `previewSurfaceAdapter` both answer `coordsAtPos` with "the rect of
      // the anchor's first character" (CM6's own `coordsAtPos`; the
      // Preview index's `sourceToDom(pos, pos + 1)`) — so this formula
      // reads the same point off either one, and switching Edit ⇄ Preview
      // can't move a card relative to its anchor just because the two
      // adapters computed "top" differently.
      const anchorTop = coords !== null ? coords.top - containerRect.top + scrollTop : null;
      const height = cardRefs.current.get(item.key)?.offsetHeight ?? DEFAULT_CARD_HEIGHT;
      return { key: item.key, anchorTop, height };
    });

    const next = layoutMarginCards(layoutItems, MARGIN_CARD_GAP, activeIndexRef.current);
    setTops((prev) => (mapsEqual(prev, next) ? prev : next));
  }, [containerRef, surface]);

  const scheduleRecompute = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      recompute();
    });
  }, [recompute]);

  // The item list itself changed (new/removed thread, filter, composer
  // open/close) — the active card did, which changes the whole layout
  // mode — or the surface just became (or stopped being) trustworthy
  // (`surfaceEpoch`): recompute synchronously, before paint.
  useLayoutEffect(() => {
    recompute();
    // Settle pass: a card that just mounted (the composer opening on a
    // fresh selection, a new thread arriving) can measure a beat before
    // its own layout has fully settled — a native selection still
    // collapsing, a just-swapped surface not yet answering with real
    // rects. One rAF-deferred follow-up, the same batching
    // `scheduleRecompute` already uses for ResizeObserver-driven reflows,
    // corrects it without waiting for an unrelated event (hovering the
    // anchor, say) to trigger another pass.
    scheduleRecompute();
  }, [items, activeIndex, surfaceEpoch, recompute, scheduleRecompute]);

  useEffect(() => {
    const ro = new ResizeObserver(() => scheduleRecompute());
    roRef.current = ro;
    const container = containerRef.current;
    if (container) ro.observe(container);
    for (const el of cardRefs.current.values()) ro.observe(el);
    return () => {
      ro.disconnect();
      roRef.current = null;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    // containerRef/surface are stable for the lifetime of the artifact view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setCardRef = useCallback(
    (key: string) => (el: HTMLDivElement | null) => {
      const prev = cardRefs.current.get(key);
      if (prev && prev !== el) roRef.current?.unobserve(prev);
      if (el) {
        cardRefs.current.set(key, el);
        roRef.current?.observe(el);
      } else {
        cardRefs.current.delete(key);
      }
      scheduleRecompute();
    },
    [scheduleRecompute]
  );

  return { tops, setCardRef };
}

export const MarginRail = observer(function MarginRail({
  store,
  containerRef,
}: {
  store: DocCommentsStore;
  /** The shared scroll container both the doc and this rail live in — see `artifact-view.tsx`. */
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  // Whichever surface is currently painting markers — CM6 by default, the
  // Preview surface adapter while Preview is showing (`DocCommentsStore
  // .setSurfaceAdapter`, `surface-adapter.ts`). Read fresh each render
  // rather than cached: `MarginRail` is already an `observer()`, so it
  // re-renders on every relevant store change regardless.
  const surface = store.surface;
  const [showResolved, setShowResolved] = useState(false);

  const listed = store.visibleThreads;
  const resolved = store.visibleResolvedThreads;
  const activeIsResolved = resolved.some((thread) => thread.root.id === store.activeThreadId);
  useEffect(() => {
    if (activeIsResolved) setShowResolved(true);
  }, [activeIsResolved]);

  const nothingToList =
    listed.length === 0 && resolved.length === 0 && store.composerQuote === null;

  // The composer positions itself the same way a thread card would: at the Y
  // of the (still-unposted) quote it was opened on. Preview's selection→
  // anchor path already resolved the exact SOURCE offset the selection came
  // from (`store.composerLocated`) — use it directly, the same exact-offset
  // path `create` posts the anchor from, so the card lands exactly where the
  // eventual comment will. The Edit-mode path (`CommentSelectionButton`)
  // never resolves one, so it falls back to a plain search — the same trust
  // a thread's own anchor gets before it has replies to disambiguate with,
  // first match only: if the exact selection repeats verbatim elsewhere in
  // the doc, the composer may visually align to the wrong occurrence.
  // Cosmetic only — the anchor actually posted on submit is the real
  // selection, not this lookup.
  const composerIndex = useMemo(() => {
    if (store.composerQuote === null) return null;
    if (store.composerLocated !== null) return store.composerLocated.start;
    const index = store.documentContent.indexOf(store.composerQuote);
    return index === -1 ? null : index;
  }, [store.composerQuote, store.composerLocated, store.documentContent]);

  const items = useMemo<RailItem[]>(() => {
    const out: RailItem[] = [];
    if (store.composerQuote !== null) {
      out.push({ key: '__composer', kind: 'composer', index: composerIndex });
    }
    for (const thread of listed) {
      out.push({ key: thread.root.id, kind: 'thread', index: thread.index, thread });
    }
    if (resolved.length > 0) {
      out.push({ key: '__resolved-toggle', kind: 'resolved-toggle', index: null });
      if (showResolved) {
        for (const thread of resolved) {
          out.push({ key: thread.root.id, kind: 'thread', index: thread.index, thread });
        }
      }
    }
    return out;
  }, [listed, resolved, showResolved, store.composerQuote, composerIndex]);

  // Priority layout target: the composer (while open) or the active thread —
  // mutually exclusive in practice (opening the composer clears
  // activeThreadId), so whichever the list actually contains wins.
  const activeIndex = useMemo(() => {
    const index = items.findIndex((item) =>
      item.kind === 'composer'
        ? true
        : item.kind === 'thread' && item.thread.root.id === store.activeThreadId
    );
    return index === -1 ? null : index;
  }, [items, store.activeThreadId]);

  const { tops, setCardRef } = useMarginLayout(
    items,
    activeIndex,
    containerRef,
    surface,
    store.surfaceEpoch
  );

  // The single consumer of `pendingReveal` — the only place in the docs
  // feature that scrolls anything, and the only reveal rule there is: ensure
  // the thread's *anchor* is minimally visible in the shared scroll
  // container. Never the card — a card that needs to move gets there by
  // `useMarginLayout`'s active-priority layout, not a second scroll chasing
  // it (see `pending-reveal.ts`'s round-8 doc comment for why: scrolling to
  // the card's own rendered position raced that layout and could land on a
  // pre-relocation position, badly so for two anchors on the same line).
  //
  // Reads the observable into a local so the effect fires exactly once per
  // command (object identity changes on every `_requestReveal`/
  // `clearPendingReveal`), measures once, then clears the command via its
  // token so a slow consumer can never clobber a newer one.
  const pendingReveal = store.pendingReveal;
  useEffect(() => {
    if (!pendingReveal) return;
    const container = containerRef.current;
    const thread = store.threads.find((t) => t.root.id === pendingReveal.threadId);
    if (
      surface.ready() &&
      container &&
      thread &&
      thread.index !== null &&
      thread.index <= surface.docLength()
    ) {
      const coords = surface.coordsAtPos(thread.index);
      if (coords) {
        // Same content-coordinate space `useMarginLayout`'s own anchor-Y math
        // uses: viewport-relative CM6 coords, rebased onto the container's
        // scrolled content.
        const containerRect = container.getBoundingClientRect();
        const scrollTop = container.scrollTop;
        const anchor = {
          top: coords.top - containerRect.top + scrollTop,
          bottom: coords.bottom - containerRect.top + scrollTop,
        };
        const viewport = { top: scrollTop, bottom: scrollTop + container.clientHeight };
        const delta = minimalScrollDelta(anchor, viewport, REVEAL_PADDING);
        // Already visible → do nothing at all, not even a tiny nudge.
        if (delta !== 0) container.scrollBy({ top: delta, behavior: 'smooth' });
      }
    }
    store.clearPendingReveal(pendingReveal.token);
    // store/surface/containerRef are stable for the artifact view's lifetime;
    // re-running this effect is driven entirely by `pendingReveal` changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingReveal]);

  return (
    <div
      // Marks the rail's whole DOM subtree (every card, the composer) as "not
      // away" for `ArtifactView`'s click-away-dismisses-the-active-thread
      // handler — see that file for why this can't just be a Tailwind class.
      data-comments-rail
      className="absolute top-0"
      style={{ right: RAIL_RIGHT, width: RAIL_WIDTH }}
    >
      {store.state === 'offline' && (
        // Read-only mode, not an error: no warning color, no "something is
        // wrong" framing — a quiet mono status chip, pinned to the top of
        // the visible scroll area (not the floating warning-red banner this
        // replaced) so it stays discoverable while cached threads keep
        // rendering below. Retry lives right beside it; the poll timer
        // itself already retries on its own cadence (`_fail` leaves it
        // running for this state).
        <div className="border-border-hairline bg-bg-2 text-text-muted sticky top-2 z-20 mb-3 flex w-fit items-center gap-1.5 rounded-chip border px-2 py-1 font-mono text-xs">
          <WifiOff className="size-3 shrink-0" strokeWidth={1.5} />
          <span>{offlineChipLabel(store.lastSyncedAt)}</span>
          <button
            type="button"
            className="text-text-secondary hover:text-text-primary underline"
            onClick={() => void store.refresh()}
          >
            Retry
          </button>
        </div>
      )}
      {store.state === 'error' && store.errorMessage !== null && (
        <p className="text-warning mb-3 text-xs">
          <span title={store.errorMessage}>{store.errorMessage}</span>{' '}
          <button
            type="button"
            className="hover:text-text-primary underline"
            onClick={() => void store.refresh()}
          >
            Retry
          </button>
        </p>
      )}
      {store.state === 'untrustedRelay' && store.errorMessage !== null && (
        <p className="text-text-muted mb-3 text-xs">{store.errorMessage}</p>
      )}
      {nothingToList && <p className="text-text-muted text-xs">{FILTER_EMPTY[store.filter]}</p>}

      {items.map((item, index) => (
        <div
          key={item.key}
          ref={setCardRef(item.key)}
          className={cn(
            'absolute right-0 left-0 transition-[top] duration-150 ease-out',
            // The priority card (composer, or the active thread) lifts above
            // its siblings — otherwise these are DOM-order stacking contexts
            // with no z-index at all, so a later card in reading order paints
            // over an earlier one's lift/connector regardless of which is
            // actually selected.
            index === activeIndex && 'z-10'
          )}
          style={{ top: tops.get(item.key) ?? 0 }}
        >
          {item.kind === 'composer' && (
            <NewThreadCard store={store} hasAnchor={item.index !== null} />
          )}
          {item.kind === 'thread' && <ThreadCard store={store} thread={item.thread} />}
          {item.kind === 'resolved-toggle' && (
            <button
              type="button"
              onClick={() => setShowResolved((open) => !open)}
              className="text-text-muted hover:text-text-primary flex h-6 items-center gap-1 text-xs"
            >
              {showResolved ? (
                <ChevronDown className="size-3 shrink-0" />
              ) : (
                <ChevronRight className="size-3 shrink-0" />
              )}
              {resolved.length} resolved
            </button>
          )}
        </div>
      ))}
    </div>
  );
});
