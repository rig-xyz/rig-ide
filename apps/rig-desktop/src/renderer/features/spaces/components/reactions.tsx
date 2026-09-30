import { Search, SmilePlus } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Popover } from '@renderer/lib/ui/popover';
import { cn } from '@renderer/lib/utils';
import {
  hasReacted,
  QUICK_REACTIONS,
  type MessageReaction,
  type Reactor,
} from '@shared/spaces/reactions';
import {
  frequentEmoji,
  loadEmojiIndex,
  recordEmojiUse,
  searchEmoji,
  type EmojiEntry,
  type EmojiIndex,
} from '../emoji-data';
import type { RoomMember } from '../types';
import { AGENT_NAME, AgentAvatar, PersonAvatar } from './identity';

/**
 * Spaces: emoji reactions on a room message — the chips under it (emoji +
 * count, yours highlighted; click to toggle yours; hover for who), the
 * quick five and "+" in its hover bar, and the emoji picker the composer
 * shares. A reaction is never a message: it asks no agent and triggers
 * nothing.
 */

/** What reacting needs from the Room; absent (the scripted demo) means reactions show but can't be changed. */
export type ReactionsApi = { react: (messageId: string, emoji: string, on: boolean) => void };

export const ReactionsContext = createContext<ReactionsApi | null>(null);

/** Names shown when hovering a chip before "and N others". */
const HOVER_NAMES = 10;
const HOVER_OPEN_MS = 250;
const HOVER_CLOSE_MS = 150;

/** "Maya", "Maya's Claude", "You", "Your Claude"; someone who's left is "Someone". */
export function reactorLabel(
  reactor: Reactor,
  members: readonly RoomMember[],
  ownId: string
): string {
  const mine = reactor.userId === ownId;
  const name = mine ? null : (members.find((m) => m.id === reactor.userId)?.name ?? 'Someone');
  if (!reactor.agent) return mine ? 'You' : name!;
  return mine ? `Your ${AGENT_NAME[reactor.agent]}` : `${name}'s ${AGENT_NAME[reactor.agent]}`;
}

function ReactorRow({
  reactor,
  members,
  ownId,
}: {
  reactor: Reactor;
  members: readonly RoomMember[];
  ownId: string;
}) {
  const member = members.find((m) => m.id === reactor.userId);
  return (
    <li className="flex items-center gap-2 py-0.5" data-testid="reactor">
      {reactor.agent ? (
        <AgentAvatar agent={reactor.agent} owner={member} size="sm" />
      ) : (
        <PersonAvatar member={member} name="?" size="sm" />
      )}
      <span className="truncate text-xs text-text-primary">
        {reactorLabel(reactor, members, ownId)}
      </span>
    </li>
  );
}

/** Who put one emoji on a message: the first ten, then "and N others" (which opens the whole list). */
function ReactorList({
  reaction,
  members,
  ownId,
  limit,
  onShowAll,
}: {
  reaction: MessageReaction;
  members: readonly RoomMember[];
  ownId: string;
  limit?: number;
  onShowAll?: () => void;
}) {
  const shown = limit === undefined ? reaction.reactors : reaction.reactors.slice(0, limit);
  const others = reaction.count - shown.length;
  return (
    <div className="flex flex-col gap-1">
      <p className="flex items-center gap-1.5 text-2xs text-text-muted">
        <span className="text-sm leading-none">{reaction.emoji}</span>
        {reaction.count === 1 ? '1 reaction' : `${reaction.count} reactions`}
      </p>
      <ul className="flex flex-col">
        {shown.map((reactor, i) => (
          <ReactorRow
            key={`${reactor.userId}:${reactor.agent}:${i}`}
            reactor={reactor}
            members={members}
            ownId={ownId}
          />
        ))}
      </ul>
      {others > 0 &&
        (onShowAll ? (
          <button
            type="button"
            onClick={onShowAll}
            className="cursor-pointer self-start text-xs text-text-secondary underline-offset-2 hover:text-text-primary hover:underline"
            data-testid="reactors-show-all"
          >
            and {others} {others === 1 ? 'other' : 'others'}
          </button>
        ) : (
          <p className="text-xs text-text-muted">
            and {others} {others === 1 ? 'other' : 'others'}
          </p>
        ))}
    </div>
  );
}

/** A chip's "who reacted" card: over the chip (under it near the top of the window), outside the transcript's clipping. */
function HoverCard({
  anchor,
  children,
  onEnter,
  onLeave,
}: {
  anchor: HTMLElement;
  children: ReactNode;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const rect = anchor.getBoundingClientRect();
  const below = rect.top < 160;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - 248));
  return createPortal(
    <div
      role="tooltip"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={
        below ? { left, top: rect.bottom + 6 } : { left, bottom: window.innerHeight - rect.top + 6 }
      }
      className="popover-in fixed z-50 w-60 rounded-card border border-border-hairline bg-bg-1 px-2.5 py-2 shadow-float"
      data-testid="reactors-card"
    >
      {children}
    </div>,
    document.body
  );
}

function ReactionChip({
  messageId,
  reaction,
  members,
  ownId,
}: {
  messageId: string;
  reaction: MessageReaction;
  members: readonly RoomMember[];
  ownId: string;
}) {
  const api = useContext(ReactionsContext);
  const ref = useRef<HTMLButtonElement>(null);
  const [chip, setChip] = useState<HTMLButtonElement | null>(null);
  const [hover, setHover] = useState(false);
  const [all, setAll] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  const schedule = (open: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHover(open), open ? HOVER_OPEN_MS : HOVER_CLOSE_MS);
  };
  const mine = hasReacted([reaction], reaction.emoji, { userId: ownId, agent: null });
  const label = `${reaction.emoji} ${reaction.count}: ${reaction.reactors
    .slice(0, HOVER_NAMES)
    .map((r) => reactorLabel(r, members, ownId))
    .join(', ')}`;
  return (
    <>
      <button
        ref={(el) => {
          ref.current = el;
          setChip(el);
        }}
        type="button"
        aria-pressed={mine}
        aria-label={label}
        onClick={() => api?.react(messageId, reaction.emoji, !mine)}
        onMouseEnter={() => schedule(true)}
        onMouseLeave={() => schedule(false)}
        onFocus={() => setHover(true)}
        onBlur={() => schedule(false)}
        className={cn(
          'inline-flex h-6 cursor-pointer items-center gap-1 rounded-chip border px-2 text-xs tabular-nums transition-colors',
          mine
            ? 'border-accent/40 bg-accent-subtle text-text-primary'
            : 'border-border-hairline bg-bg-1 text-text-secondary hover:bg-bg-2',
          !api && 'cursor-default'
        )}
        data-testid="reaction-chip"
        data-emoji={reaction.emoji}
        data-mine={mine ? 'true' : 'false'}
      >
        <span className="text-sm leading-none">{reaction.emoji}</span>
        <span>{reaction.count}</span>
      </button>
      {hover && !all && chip && (
        <HoverCard anchor={chip} onEnter={() => schedule(true)} onLeave={() => schedule(false)}>
          <ReactorList
            reaction={reaction}
            members={members}
            ownId={ownId}
            limit={HOVER_NAMES}
            onShowAll={() => {
              setHover(false);
              setAll(true);
            }}
          />
        </HoverCard>
      )}
      <Popover
        anchor={ref}
        open={all}
        onClose={() => setAll(false)}
        role="dialog"
        ariaLabel={`Everyone who reacted ${reaction.emoji}`}
        minWidth={240}
      >
        <div className="max-h-72 overflow-y-auto px-2.5 py-2" data-testid="reactors-all">
          <ReactorList reaction={reaction} members={members} ownId={ownId} />
        </div>
      </Popover>
    </>
  );
}

/** A message's reactions as chips under it, plus a small "add" button that shows on hover. Nothing when it has none. */
export function ReactionChips({
  messageId,
  reactions,
  members,
  ownId,
  className,
}: {
  messageId: string;
  reactions: readonly MessageReaction[] | undefined;
  members: readonly RoomMember[];
  ownId: string;
  className?: string;
}) {
  const api = useContext(ReactionsContext);
  const addRef = useRef<HTMLButtonElement>(null);
  const [picking, setPicking] = useState(false);
  if (!reactions?.length) return null;
  return (
    <div
      className={cn('flex flex-wrap items-center gap-1', className)}
      data-testid="reaction-chips"
    >
      {reactions.map((reaction) => (
        <ReactionChip
          key={reaction.emoji}
          messageId={messageId}
          reaction={reaction}
          members={members}
          ownId={ownId}
        />
      ))}
      {api && (
        <>
          <button
            ref={addRef}
            type="button"
            aria-label="Add reaction"
            title="Add reaction"
            onClick={() => setPicking((p) => !p)}
            className={cn(
              'hover:bg-bg-2 flex h-6 cursor-pointer items-center rounded-chip border border-border-hairline px-1.5 text-text-muted transition-opacity group-hover:opacity-100 focus-visible:opacity-100',
              picking ? 'opacity-100' : 'opacity-0'
            )}
          >
            <SmilePlus className="size-3.5" strokeWidth={1.5} />
          </button>
          <EmojiPickerPopover
            anchor={addRef}
            open={picking}
            onClose={() => setPicking(false)}
            onPick={(emoji) => {
              setPicking(false);
              if (!hasReacted(reactions, emoji, { userId: ownId, agent: null }))
                recordEmojiUse(emoji);
              api.react(
                messageId,
                emoji,
                !hasReacted(reactions, emoji, { userId: ownId, agent: null })
              );
            }}
          />
        </>
      )}
    </div>
  );
}

const barButton =
  'hover:bg-bg-2 flex h-6 cursor-pointer items-center rounded-chip px-1.5 text-text-secondary transition-colors';

/**
 * A row's hover bar reaction button: just the smiley. Hovering it shows
 * the quick five above it (each toggles yours); clicking it opens the
 * picker. `onPickerChange` keeps the row's bar showing while either is
 * open, since both float outside the row. Nothing when the Room can't react.
 */
export function QuickReactions({
  messageId,
  reactions,
  ownId,
  onPickerChange,
}: {
  messageId: string;
  reactions: readonly MessageReaction[] | undefined;
  ownId: string;
  onPickerChange?: (open: boolean) => void;
}) {
  const api = useContext(ReactionsContext);
  const plusRef = useRef<HTMLButtonElement>(null);
  const [picking, setPicking] = useState(false);
  const [quick, setQuick] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => onPickerChange?.(picking || quick), [picking, quick, onPickerChange]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  if (!api) return null;
  const schedule = (open: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setQuick(open), open ? HOVER_OPEN_MS : HOVER_CLOSE_MS);
  };
  const toggle = (emoji: string) => {
    const on = !hasReacted(reactions, emoji, { userId: ownId, agent: null });
    if (on) recordEmojiUse(emoji);
    api.react(messageId, emoji, on);
  };
  return (
    <>
      <button
        ref={plusRef}
        type="button"
        aria-label="Add reaction"
        title="Add reaction"
        onClick={() => {
          if (timer.current) clearTimeout(timer.current);
          setQuick(false);
          setPicking((p) => !p);
        }}
        onMouseEnter={() => !picking && schedule(true)}
        onMouseLeave={() => schedule(false)}
        className={barButton}
        data-testid="quick-reaction-more"
      >
        <SmilePlus className="size-3.5" strokeWidth={1.5} />
      </button>
      <span className="mx-0.5 h-4 w-px bg-border-hairline" aria-hidden />
      {quick && !picking && plusRef.current && (
        <QuickRow
          anchor={plusRef.current}
          onEnter={() => schedule(true)}
          onLeave={() => schedule(false)}
          onPick={(emoji) => {
            setQuick(false);
            toggle(emoji);
          }}
        />
      )}
      <EmojiPickerPopover
        anchor={plusRef}
        open={picking}
        onClose={() => setPicking(false)}
        onPick={(emoji) => {
          setPicking(false);
          toggle(emoji);
        }}
      />
    </>
  );
}

/** The quick five, floating just above the smiley (below it near the top of the window), outside the transcript's clipping. */
function QuickRow({
  anchor,
  onEnter,
  onLeave,
  onPick,
}: {
  anchor: HTMLElement;
  onEnter: () => void;
  onLeave: () => void;
  onPick: (emoji: string) => void;
}) {
  const rect = anchor.getBoundingClientRect();
  const below = rect.top < 56;
  const center = rect.left + rect.width / 2;
  return createPortal(
    <div
      role="toolbar"
      aria-label="Quick reactions"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{
        left: Math.max(8, Math.min(center - 96, window.innerWidth - 200)),
        ...(below ? { top: rect.bottom + 4 } : { bottom: window.innerHeight - rect.top + 4 }),
      }}
      className="popover-in fixed z-50 flex items-center gap-0.5 rounded-full border border-border-hairline bg-bg-1 p-0.5 shadow-float"
      data-testid="quick-reactions"
    >
      {QUICK_REACTIONS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          aria-label={`React ${emoji}`}
          title={`React ${emoji}`}
          onClick={() => onPick(emoji)}
          className="flex size-7 cursor-pointer items-center justify-center rounded-full text-base leading-none transition-colors hover:bg-bg-2"
          data-testid="quick-reaction"
        >
          {emoji}
        </button>
      ))}
    </div>,
    document.body
  );
}

// ────────── the picker ──────────

/** One representative emoji per category, for the category bar. */
const GROUP_ICON: Record<string, string> = {
  smileys: '😀',
  people: '👋',
  nature: '🐻',
  food: '🍔',
  travel: '✈️',
  activities: '⚽',
  objects: '💡',
  symbols: '🔣',
  flags: '🏳️',
};

function EmojiButton({
  emoji,
  title,
  onPick,
}: {
  emoji: string;
  title: string;
  onPick: (emoji: string) => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={() => onPick(emoji)}
      className="flex size-8 cursor-pointer items-center justify-center rounded-control text-xl leading-none hover:bg-bg-2"
      data-testid="emoji-option"
      data-emoji={emoji}
    >
      {emoji}
    </button>
  );
}

function entryTitle(entry: EmojiEntry): string {
  return entry.shortcodes[0] ? `:${entry.shortcodes[0]}:` : entry.label;
}

/**
 * The emoji picker: search, your frequently used, then every category.
 * Unicode emoji only. Enter in the search picks the first match.
 */
export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState<EmojiIndex | null>(null);
  const [failed, setFailed] = useState(false);
  const frequent = useMemo(() => frequentEmoji(), []);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    loadEmojiIndex().then(
      (loaded) => alive && setIndex(loaded),
      () => alive && setFailed(true)
    );
    return () => {
      alive = false;
    };
  }, []);
  const results = useMemo(
    () => (index && query.trim() ? searchEmoji(index, query) : null),
    [index, query]
  );
  const titleOf = (emoji: string) => {
    const entry = index?.entries.find((e) => e.emoji === emoji);
    return entry ? entryTitle(entry) : emoji;
  };

  return (
    <div className="flex w-full min-w-0 flex-col" data-testid="emoji-picker">
      <div className="flex items-center gap-1.5 border-b border-border-hairline px-2.5 py-2">
        <Search className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && results?.[0]) {
              e.preventDefault();
              onPick(results[0].emoji);
            }
          }}
          placeholder="Search emoji"
          aria-label="Search emoji"
          className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
          data-testid="emoji-search"
        />
      </div>
      <div
        className="flex items-center gap-0.5 border-b border-border-hairline px-1.5 py-1"
        role="tablist"
        aria-label="Categories"
      >
        {Object.entries(GROUP_ICON).map(([key, icon]) => {
          const group = index?.groups.find((g) => g.key === key);
          return (
            <button
              key={key}
              type="button"
              role="tab"
              title={group?.label}
              aria-label={group?.label ?? key}
              disabled={!group}
              onClick={() => {
                setQuery('');
                // After the search results give way to the categories.
                requestAnimationFrame(() => {
                  const section = scroller.current?.querySelector(`[data-group="${key}"]`);
                  if (section && scroller.current)
                    scroller.current.scrollTop = (section as HTMLElement).offsetTop - 4;
                });
              }}
              className="flex size-7 cursor-pointer items-center justify-center rounded-control text-base leading-none opacity-80 hover:bg-bg-2 hover:opacity-100 disabled:cursor-default disabled:opacity-40"
            >
              {icon}
            </button>
          );
        })}
      </div>
      <div ref={scroller} className="relative h-64 overflow-x-hidden overflow-y-auto px-1.5 py-1.5">
        {results ? (
          results.length > 0 ? (
            <div className="grid grid-cols-8" data-testid="emoji-results">
              {results.map((entry) => (
                <EmojiButton
                  key={entry.emoji}
                  emoji={entry.emoji}
                  title={entryTitle(entry)}
                  onPick={onPick}
                />
              ))}
            </div>
          ) : (
            <p className="px-2 py-6 text-center text-xs text-text-muted">
              No emoji match “{query.trim()}”.
            </p>
          )
        ) : (
          <>
            <p className="px-1 pt-0.5 pb-1 text-2xs text-text-muted">Frequently used</p>
            <div className="grid grid-cols-8" data-testid="emoji-frequent">
              {frequent.map((emoji) => (
                <EmojiButton key={emoji} emoji={emoji} title={titleOf(emoji)} onPick={onPick} />
              ))}
            </div>
            {index ? (
              index.groups.map((group) => (
                <section key={group.key} data-group={group.key}>
                  <p className="px-1 pt-2 pb-1 text-2xs text-text-muted">{group.label}</p>
                  <div className="grid grid-cols-8">
                    {group.entries.map((entry) => (
                      <EmojiButton
                        key={entry.emoji}
                        emoji={entry.emoji}
                        title={entryTitle(entry)}
                        onPick={onPick}
                      />
                    ))}
                  </div>
                </section>
              ))
            ) : (
              <p className="px-1 py-3 text-xs text-text-muted">
                {failed ? 'Couldn’t load emoji.' : 'Loading emoji…'}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The picker in a popover anchored to its button (the hover bar's "+", a chip row's add, the composer's smiley). */
export function EmojiPickerPopover({
  anchor,
  open,
  onClose,
  onPick,
  align = 'right',
}: {
  anchor: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  onPick: (emoji: string) => void;
  align?: 'left' | 'right';
}) {
  return (
    <Popover
      anchor={anchor}
      open={open}
      onClose={onClose}
      role="dialog"
      ariaLabel="Emoji"
      align={align}
      estimatedWidth={304}
      minWidth={304}
      className="p-0"
    >
      {open && <EmojiPicker onPick={onPick} />}
    </Popover>
  );
}
