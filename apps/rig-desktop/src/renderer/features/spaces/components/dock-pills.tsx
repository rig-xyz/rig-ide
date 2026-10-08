import { X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import {
  activeThemes,
  agentDisplayName,
  dockTasks,
  forYouCount,
  forYouLine,
  splitThemes,
  themeColor,
  themeLastActivity,
  whoName,
  type DockFocus,
  type DockTask,
  type DockWho,
} from '../dock-model';
import type { Phase } from '../dock-layout';
import { themesWithForYou, type ForYou } from '../for-you';
import type { RoomTheme, RoomThemes } from '../themes';
import { personOf } from '../person-identity';
import type { RoomSnapshot } from '../types';
import { DOCK_TIMING, FOR_YOU_ID, type DockSwell } from '../use-dock-signals';
import { useDismissOutside } from './dock-approvals';
import { FOCUS_RING } from './dock-glass';
import type { StageEntry, StageFloat } from './dock-stage';
import { AgentAvatar, PersonAvatar } from './identity';

/**
 * The pill column under the rail, as the stage's entries (`dock-stage.tsx`
 * draws their goo and places them): For you first when something waits on
 * you, then the themes, most recently active first, and "+N" for the rest.
 * Hovering a pill peeks it (a float hanging off the pill) and previews it in
 * the transcript; clicking focuses the transcript on it, and the pill swells
 * into a card with an ×. In a narrow Room the column is smaller: For you, the
 * focused theme's card if there is one, and a single "Themes N" that opens
 * the list of them all.
 *
 * Births are one element: a theme that is born while the Room is open starts
 * as a spot behind the listener, falls out as a drop under the rail, slides into its
 * place in the column and becomes the pill. An arrival in For you swells the
 * For you pill itself, to say what came in, and folds back.
 *
 * The spotlight: while the transcript is filtered to a face, a chip for it
 * leads the column (its × lets go), and each pill counts that face's
 * messages out of its own.
 *
 * Tasks in progress: each agent run that is working, waiting or just done
 * hangs as a small row under its topic, with the agent, its dot matrix and
 * its time. A run whose ask the relay still holds has no topic yet and sits
 * under "Not sorted yet". Hovering a row peeks its live step; clicking it
 * jumps to the run's card. Hovering an agent's face lights its rows.
 *
 * By keyboard: Tab reaches every pill (with a ring), Enter or Space focuses it
 * and the keyboard goes to the card's ×; the × (or Esc) lets go and the keyboard
 * goes back to the pill. A list of themes takes the keyboard in when it opens,
 * moves with the arrows, and gives it back to its button on Esc.
 */

const SPRING = { type: 'spring', stiffness: 420, damping: 32, mass: 0.8 } as const;

const THEME_PREFIX = 'theme:';
const TASK_PREFIX = 'task:';
const MORE_ID = 'more';
const WHO_ID = 'who';
const UNSORTED_ID = 'unsorted';
/** Task rows sit this far in from the column's left edge, under their topic. */
const TASK_INDENT = 14;

function Dot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      className={cn('size-2 shrink-0 rounded-full', className)}
      style={{ background: color }}
      aria-hidden
    />
  );
}

function Count({ n }: { n: number }) {
  return <span className="font-mono text-2xs text-text-muted tabular-nums">{n}</span>;
}

/** The verb of an ask, from the notification's type. */
const ASK_VERB = {
  mention: 'mentioned you',
  reply: 'replied to you',
  comment: 'commented for you',
} as const;

/** What the swollen For you pill says: the actor's face, and what happened. */
function swellOf(
  swell: DockSwell,
  snapshot: RoomSnapshot,
  selfUserId: string
): { kind: string; face: ReactNode; text: ReactNode } {
  const { arrival } = swell;
  if (arrival.kind === 'ask') {
    const { actor } = arrival.ask;
    const person = personOf(snapshot, actor.userId, { name: actor.name });
    const name = person.name;
    return {
      kind: arrival.ask.type,
      face: <PersonAvatar member={person.member} person={person} size="sm" />,
      text: (
        <>
          <b className="font-semibold text-text-primary">{name}</b> {ASK_VERB[arrival.ask.type]}
        </>
      ),
    };
  }
  const { agent } = arrival.approval;
  const owner = snapshot.members.find((m) => m.id === selfUserId);
  return {
    kind: 'approval',
    face: (
      <AgentAvatar agent={agent} owner={owner} size="sm" title={null} badgeRingClassName="ring-[var(--pill-fill)]" />
    ),
    text: (
      <>
        <b className="font-semibold text-text-primary">{agentDisplayName(agent, null)}</b> needs
        approval
      </>
    ),
  };
}

/** A pill at rest: dot, name, count, and the marks (waiting on you, new). */
function Pill({
  testId,
  themeId,
  color,
  label,
  count,
  of,
  dim,
  waiting,
  fresh,
  accent,
  phase,
  swell,
  onClick,
}: {
  testId: string;
  themeId?: string;
  color: string;
  label: string;
  count: number;
  /** While a face is spotlit: the count is theirs, out of this. */
  of?: number;
  dim: boolean;
  waiting: boolean;
  fresh: boolean;
  /** The For you pill: its text is the accent. */
  accent?: boolean;
  /** 'drop': a birth under way, the name alone. */
  phase: Phase;
  /** The For you pill's arrival: it says this instead of its name. */
  swell?: { key: string; kind: string; face: ReactNode; text: ReactNode } | null;
  onClick: () => void;
}) {
  const reduced = useReducedMotion();
  // A drop is the name alone; the dot, the count and the marks arrive with the pill.
  const marks = {
    opacity: phase === 'drop' ? 0 : 1,
    transition: reduced ? undefined : 'opacity .3s ease',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={false}
      data-testid={testId}
      data-theme-id={themeId}
      data-swell={swell?.kind}
      className={cn(
        'relative flex h-[30px] max-w-full items-center rounded-full pr-3 pl-2.5 text-xs whitespace-nowrap transition-[color,opacity]',
        FOCUS_RING,
        of !== undefined && count === 0 && 'opacity-45',
        accent
          ? 'text-accent'
          : dim
            ? 'text-text-secondary hover:text-text-primary'
            : 'text-text-primary'
      )}
    >
      {swell ? (
        <motion.span
          key={swell.key}
          className="flex items-center gap-2"
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.25, delay: 0.08 }}
        >
          {swell.face}
          <span className="text-text-secondary">{swell.text}</span>
          <Count n={count} />
        </motion.span>
      ) : (
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0" style={marks}>
            <Dot color={color} />
          </span>
          <span className="max-w-[170px] min-w-0 truncate">{label}</span>
          <span className="shrink-0" style={marks}>
            {of === undefined ? (
              <Count n={count} />
            ) : (
              <span className="font-mono text-2xs text-text-muted tabular-nums" data-testid="dock-pill-of">
                {count} of {of}
              </span>
            )}
          </span>
          {waiting && (
            <span
              className="size-1.5 shrink-0 rounded-full bg-accent shadow-[0_0_0_2px_var(--accent-subtle)]"
              title="Something here is waiting on you"
              data-testid="dock-pill-waiting"
              style={marks}
            />
          )}
          {fresh && (
            <span
              className="shrink-0 font-mono text-2xs leading-none tracking-wide text-accent uppercase"
              data-testid="dock-pill-new"
              style={marks}
            >
              new
            </span>
          )}
        </span>
      )}
    </button>
  );
}

/** A focused pill: a card with where the theme stands, and the × that lets go. */
function FocusCard({
  testId,
  color,
  title,
  count,
  body,
  foot,
  restoreSelector,
  onClear,
}: {
  testId: string;
  color: string;
  title: string;
  count: number;
  body: string;
  foot: string;
  /** The pill this card was, to give the keyboard back to when the card goes. */
  restoreSelector: string;
  onClear: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const clearRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const card = cardRef.current;
    // The pill (or list item) that was pressed is gone: the keyboard moves to the ×.
    const at = document.activeElement;
    if (!at || at === document.body || at.closest('[role="menu"]')) {
      clearRef.current?.focus({ preventScroll: true });
    }
    return () => {
      if (!card || !card.contains(document.activeElement)) return;
      const dock = card.closest('[data-testid="theme-dock"]');
      requestAnimationFrame(() =>
        dock?.querySelector<HTMLElement>(restoreSelector)?.focus({ preventScroll: true })
      );
    };
  }, [restoreSelector]);
  return (
    <div
      ref={cardRef}
      className="relative"
      style={{ width: 272 }}
      data-testid={testId}
      role="group"
      aria-label={`${title}, focused`}
    >
      <div className="flex flex-col gap-1.5 px-3.5 pt-3 pb-3">
        <div className="flex items-center gap-2">
          <Dot color={color} />
          <b className="min-w-0 truncate text-sm font-semibold text-text-primary">{title}</b>
          <Count n={count} />
          <button
            ref={clearRef}
            type="button"
            onClick={onClear}
            aria-label="Clear the focus"
            data-testid="dock-focus-clear"
            className={cn(
              'ml-auto flex size-[22px] shrink-0 items-center justify-center rounded-full bg-bg-2 text-text-secondary transition-colors hover:bg-bg-3 hover:text-text-primary',
              FOCUS_RING
            )}
          >
            <X className="size-3" strokeWidth={1.75} />
          </button>
        </div>
        {body && <p className="text-sm leading-snug text-text-prose">{body}</p>}
        <p className="text-xs text-text-muted">{foot}</p>
      </div>
    </div>
  );
}

/** What the peek says: the card's words, on the dock's goo (the float's shape is behind it). */
function Peek({
  color,
  title,
  body,
  foot,
}: {
  color: string;
  title: string;
  body: string;
  foot: string;
}) {
  return (
    <div
      className="px-3 py-2.5 text-xs"
      style={{ width: 250, pointerEvents: 'none' }}
      data-testid="dock-peek"
    >
      <div className="flex items-center gap-1.5">
        <Dot color={color} className="size-[7px]" />
        <b className="min-w-0 truncate font-semibold text-text-primary">{title}</b>
      </div>
      {body && <p className="mt-1 leading-snug text-text-prose">{body}</p>}
      <p className="mt-1.5 text-text-muted">{foot}</p>
    </div>
  );
}

/**
 * A button that opens a small list of themes; one click focuses one. "+N" is
 * the themes that did not fit among the pills, "Themes N" is all of them in a
 * narrow Room. The list takes the keyboard when it opens (arrows move, Enter
 * picks, Esc gives it back to the button).
 */
function ThemeListPill({
  themes,
  onPick,
  label,
  ariaLabel,
  testId,
}: {
  themes: readonly RoomTheme[];
  onPick: (theme: RoomTheme) => void;
  label: ReactNode;
  ariaLabel: string;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useDismissOutside(
    rootRef,
    open,
    () => setOpen(false),
    () => triggerRef.current
  );
  const reduced = useReducedMotion();
  useEffect(() => {
    if (open)
      listRef.current
        ?.querySelector<HTMLElement>('[role="menuitem"]')
        ?.focus({ preventScroll: true });
  }, [open]);
  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') return setOpen(false);
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const to =
      event.key === 'ArrowDown'
        ? Math.min(items.length - 1, at + 1)
        : event.key === 'ArrowUp'
          ? Math.max(0, at - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : -1;
    if (to === -1) return;
    event.preventDefault();
    items[to]?.focus();
  };
  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={ariaLabel}
        data-testid={testId}
        className={cn(
          'relative flex h-[30px] items-center rounded-full px-3 text-xs text-text-secondary transition-colors hover:text-text-primary',
          FOCUS_RING
        )}
      >
        {label}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            ref={listRef}
            role="menu"
            aria-label="Topics"
            data-testid="dock-more-list"
            onKeyDown={onListKeyDown}
            className="absolute top-0 right-full mr-3 flex max-h-[320px] w-[240px] origin-top-right flex-col gap-0.5 overflow-y-auto rounded-card border border-border-hairline bg-bg-1 p-1.5 shadow-float"
            initial={reduced ? false : { opacity: 0, scale: 0.96, x: 8 }}
            animate={{ opacity: 1, scale: 1, x: 0 }}
            exit={{ opacity: 0, scale: 0.96, x: 8 }}
            transition={reduced ? { duration: 0 } : SPRING}
          >
            {themes.map((theme) => (
              <button
                key={theme.id}
                type="button"
                role="menuitem"
                data-testid="dock-more-item"
                data-theme-id={theme.id}
                onClick={() => {
                  setOpen(false);
                  onPick(theme);
                }}
                className={cn(
                  'flex h-8 items-center gap-2 rounded-control px-2 text-left text-xs transition-colors hover:bg-bg-2',
                  FOCUS_RING
                )}
              >
                <Dot color={themeColor(theme.id)} />
                <span className="min-w-0 flex-1 truncate text-text-primary">{theme.name}</span>
                <Count n={theme.count} />
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** The spotlit face, leading the column: who, how many of their messages, and the × that lets go. */
function WhoChip({
  who,
  name,
  count,
  snapshot,
  onClear,
}: {
  who: DockWho;
  name: string;
  count: number;
  snapshot: RoomSnapshot;
  onClear: () => void;
}) {
  const face =
    who.kind === 'person' ? (
      <PersonAvatar
        member={snapshot.members.find((m) => m.id === who.userId)}
        person={personOf(snapshot, who.userId)}
        size="sm"
      />
    ) : (
      <AgentAvatar
        agent={who.agent}
        owner={snapshot.members.find((m) => m.id === who.owner)}
        size="sm"
        title={null}
        badgeRingClassName="ring-[var(--pill-fill)]"
      />
    );
  return (
    <div
      className="flex h-[30px] max-w-full items-center gap-2 rounded-full pr-1.5 pl-1.5 text-xs whitespace-nowrap text-text-primary shadow-[inset_0_0_0_1.5px_var(--accent)]"
      data-testid="dock-who-chip"
      role="group"
      aria-label={`Showing ${name}`}
    >
      {face}
      <span className="max-w-[150px] min-w-0 truncate">{name}</span>
      <Count n={count} />
      <button
        type="button"
        onClick={onClear}
        aria-label={`Show everyone, not only ${name}`}
        data-testid="dock-who-clear"
        className={cn(
          'flex size-[18px] shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-bg-3 hover:text-text-primary',
          FOCUS_RING
        )}
      >
        <X className="size-3" strokeWidth={1.75} />
      </button>
    </div>
  );
}

/** "Not sorted yet": the heading over tasks whose ask the relay still holds. Not a filter. */
function UnsortedHeading({ count }: { count: number }) {
  return (
    <span
      className="flex h-[30px] items-center gap-2 rounded-full pr-3 pl-2.5 text-xs whitespace-nowrap text-text-secondary"
      data-testid="dock-unsorted"
    >
      <span className="size-2 shrink-0 rounded-full shadow-[inset_0_0_0_1.5px_var(--text-muted)]" aria-hidden />
      Not sorted yet
      <Count n={count} />
    </span>
  );
}

function taskAgentName(task: DockTask, snapshot: RoomSnapshot): string {
  return agentDisplayName(task.agent, task.own ? null : personOf(snapshot, task.owner).name);
}

/** One task under its topic: the agent, its dot matrix, what it is, and its time. */
function TaskRow({
  task,
  snapshot,
  lit,
  onJump,
}: {
  task: DockTask;
  snapshot: RoomSnapshot;
  /** Its agent's face is hovered. */
  lit: boolean;
  onJump: (() => void) | undefined;
}) {
  const name = taskAgentName(task, snapshot);
  return (
    <button
      type="button"
      onClick={onJump}
      aria-label={`${name}: ${task.title}. ${task.status}`}
      data-testid="dock-task"
      data-run-id={task.runId}
      data-state={task.state}
      data-lit={lit ? 'true' : undefined}
      className={cn(
        'flex h-[26px] max-w-full items-center gap-[7px] rounded-full pr-2.5 pl-1 text-xs whitespace-nowrap transition-colors',
        FOCUS_RING,
        lit ? 'text-accent' : task.state === 'done' ? 'text-text-secondary' : 'text-text-primary'
      )}
    >
      <AgentAvatar
        agent={task.agent}
        owner={snapshot.members.find((m) => m.id === task.owner)}
        size="sm"
        title={null}
        badgeRingClassName="ring-[var(--pill-fill)]"
      />
      <DotMatrix state={task.matrix} size="sm" />
      <span className="max-w-[120px] min-w-0 truncate">{task.title}</span>
      <span
        className={cn(
          'shrink-0 text-2xs tabular-nums',
          task.state === 'waiting' ? 'text-warning' : 'text-text-muted'
        )}
      >
        {task.status}
      </span>
    </button>
  );
}

/** A task's peek: whose agent, what it was asked, and the step it is on now. */
function TaskPeek({ task, snapshot }: { task: DockTask; snapshot: RoomSnapshot }) {
  const foot = task.themeId
    ? 'Click to jump to it.'
    : 'It gets a topic when it finishes. Click to jump to it.';
  return (
    <div
      className="px-3 py-2.5 text-xs"
      style={{ width: 250, pointerEvents: 'none' }}
      data-testid="dock-task-peek"
    >
      <b className="font-semibold text-text-primary">{taskAgentName(task, snapshot)}</b>
      <p className="mt-1 line-clamp-2 leading-snug text-text-prose">{task.title}</p>
      <div className="mt-1.5 flex h-5 min-w-0 items-center gap-2 text-text-secondary">
        <DotMatrix state={task.matrix} size="sm" />
        <span className={cn('min-w-0 truncate', task.state === 'working' && 'active-shimmer-muted')}>
          {task.step}
        </span>
      </div>
      <p className="mt-1.5 text-text-muted">{foot}</p>
    </div>
  );
}

/** The clock for the task rows' times: ticks once a second while there are tasks to show. */
function useTaskClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * Where each born entry is in its birth: tucked behind the listener, the drop under the rail,
 * then in its place. Worked out while rendering, so a born pill never shows in
 * its place on the way in. Reduced motion skips the trip.
 */
function useBirthPhases(bornIds: ReadonlySet<string>, reduced: boolean): Record<string, Phase> {
  const [phases, setPhases] = useState<Record<string, Phase>>({});
  let next: Record<string, Phase> | null = null;
  for (const id of bornIds) {
    if (id in phases) continue;
    next ??= { ...phases };
    next[id] = reduced ? 'placed' : 'bead';
  }
  for (const id of Object.keys(phases)) {
    if (bornIds.has(id)) continue;
    next ??= { ...phases };
    delete next[id];
  }
  if (next) setPhases(next);

  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    for (const [id, phase] of Object.entries(phases)) {
      if (phase === 'placed') continue;
      const key = `${id}:${phase}`;
      if (timers.current.has(key)) continue;
      const toDrop = phase === 'bead';
      timers.current.set(
        key,
        setTimeout(
          () => {
            setPhases((current) =>
              current[id] === phase ? { ...current, [id]: toDrop ? 'drop' : 'placed' } : current
            );
          },
          toDrop ? DOCK_TIMING.dropAfterMs : DOCK_TIMING.slideAfterMs - DOCK_TIMING.dropAfterMs
        )
      );
    }
  }, [phases]);
  useEffect(() => {
    const live = timers.current;
    return () => {
      for (const timer of live.values()) clearTimeout(timer);
      live.clear();
    };
  }, []);
  return phases;
}

/** How many times each count has gone up since the column mounted: a pill pulses when it does. */
function useRises(counts: Record<string, number>): Record<string, number> {
  const [state, setState] = useState({ last: counts, ticks: {} as Record<string, number> });
  const keys = Object.keys(counts);
  let ticks: Record<string, number> | null = null;
  for (const id of keys) {
    const was = state.last[id];
    if (was !== undefined && counts[id]! > was) {
      ticks ??= { ...state.ticks };
      ticks[id] = (ticks[id] ?? 0) + 1;
    }
  }
  const moved =
    keys.length !== Object.keys(state.last).length || keys.some((id) => state.last[id] !== counts[id]);
  if (ticks || moved) setState({ last: counts, ticks: ticks ?? state.ticks });
  return state.ticks;
}

/** Counts up each time `key` becomes a new, non-null value. */
function useKeyTicks(key: string | null): number {
  const [state, setState] = useState({ key, ticks: 0 });
  if (state.key !== key) setState({ key, ticks: key === null ? state.ticks : state.ticks + 1 });
  return state.ticks;
}

export type PillColumnInput = {
  snapshot: RoomSnapshot;
  themes: RoomThemes | null | undefined;
  forYou: ForYou;
  selfUserId: string;
  focus: DockFocus | null;
  freshThemeIds: ReadonlySet<string>;
  bornIds: ReadonlySet<string>;
  swell: DockSwell | null;
  /** A narrow Room: For you, the focused theme, and one "Topics N" for the rest. */
  narrow?: boolean;
  onToggle: (target: DockFocus) => void;
  onClear: () => void;
  /** The face the transcript is filtered to, and its messages. */
  who?: DockWho | null;
  whoIds?: ReadonlySet<string> | null;
  /** The face under the pointer: its agent's task rows light up. */
  hoverWho?: DockWho | null;
  onClearWho?: () => void;
  /** A task row was clicked. */
  onJumpToRun?: (runId: string) => void;
};

export type PillColumn = {
  entries: StageEntry[];
  /** The hovered pill's card, hanging off it. */
  peek: StageFloat | null;
  /** The messages the hovered pill holds, for the transcript to light up the rest of; null when nothing is previewed. */
  previewIds: ReadonlySet<string> | null;
};

export function usePillColumn({
  snapshot,
  themes,
  forYou,
  selfUserId,
  focus,
  freshThemeIds,
  bornIds,
  swell,
  narrow = false,
  onToggle,
  onClear,
  who = null,
  whoIds = null,
  hoverWho = null,
  onClearWho,
  onJumpToRun,
}: PillColumnInput): PillColumn {
  const reduced = useReducedMotion() ?? false;
  const [hovered, setHovered] = useState<string | null>(null);
  const focusedThemeId = focus?.kind === 'theme' ? focus.themeId : null;
  const { shown, rest } = useMemo(
    () =>
      themes
        ? splitThemes(themes.list, snapshot.messages, focusedThemeId)
        : { shown: [], rest: [] },
    [themes, snapshot.messages, focusedThemeId]
  );
  const allThemes = useMemo(() => (themes ? activeThemes(themes.list) : []), [themes]);
  // The narrow Room's list: every theme but the one already shown as a card.
  const listed = useMemo(
    () => allThemes.filter((t) => t.id !== focusedThemeId),
    [allThemes, focusedThemeId]
  );
  const waitingThemes = useMemo(
    () =>
      themes ? themesWithForYou(forYou, themes.themeOf, snapshot.messages) : new Set<string>(),
    [forYou, themes, snapshot.messages]
  );

  // Tasks in progress, the spotlit face's only while there is one.
  const [hasTasks, setHasTasks] = useState(false);
  const now = useTaskClock(hasTasks && !narrow);
  const tasks = useMemo(() => {
    if (narrow) return [];
    const all = dockTasks(snapshot, themes, selfUserId, now);
    if (!who) return all;
    return all.filter((t) =>
      who.kind === 'person' ? t.owner === who.userId : t.owner === who.owner && t.agent === who.agent
    );
  }, [narrow, snapshot, themes, selfUserId, now, who]);
  if (hasTasks !== tasks.length > 0) setHasTasks(tasks.length > 0);

  // While a face is spotlit, each pill counts its messages.
  const themeOfMap = themes?.themeOf;
  const whoCounts = useMemo(() => {
    if (!whoIds || !themeOfMap) return null;
    const counts = new Map<string, number>();
    for (const id of whoIds) {
      const themeId = themeOfMap[id]?.themeId;
      if (themeId) counts.set(themeId, (counts.get(themeId) ?? 0) + 1);
    }
    return counts;
  }, [whoIds, themeOfMap]);

  const youFocused = focus?.kind === 'for-you';
  const youCount = forYouCount(forYou);
  const showForYou = youCount > 0 || youFocused;
  const visibleThemes = narrow ? shown.filter((theme) => theme.id === focusedThemeId) : shown;
  const moreThemes = narrow ? listed : rest;

  const phases = useBirthPhases(bornIds, reduced);
  const rises = useRises({
    [FOR_YOU_ID]: youCount,
    ...Object.fromEntries(visibleThemes.map((t) => [THEME_PREFIX + t.id, t.count])),
  });
  const swellTicks = useKeyTicks(swell?.key ?? null);

  const hover = (id: string): StageEntry['wrapperProps'] => ({
    onMouseEnter: () => setHovered(id),
    onMouseLeave: () => setHovered((current) => (current === id ? null : current)),
    onFocus: () => setHovered(id),
    onBlur: () => setHovered((current) => (current === id ? null : current)),
  });
  const phaseOf = (id: string): Phase => phases[id] ?? 'placed';
  const born = (id: string) => bornIds.has(id);

  const dimOthers = focus !== null;
  const line = forYouLine(forYou);
  const entries: StageEntry[] = [];
  const peeks = new Map<string, { anchor: string; peek: ReactNode }>();

  if (who && whoIds && onClearWho) {
    entries.push({
      id: WHO_ID,
      card: false,
      fit: true,
      phase: 'placed',
      content: (
        <WhoChip
          who={who}
          name={whoName(snapshot, who, selfUserId)}
          count={whoIds.size}
          snapshot={snapshot}
          onClear={onClearWho}
        />
      ),
    });
  }

  const taskEntries = (list: DockTask[]) => {
    for (const task of list) {
      const id = TASK_PREFIX + task.runId;
      const lit =
        task.state !== 'done' &&
        hoverWho?.kind === 'agent' &&
        hoverWho.owner === task.owner &&
        hoverWho.agent === task.agent;
      entries.push({
        id,
        card: false,
        fit: true,
        indent: TASK_INDENT,
        phase: 'placed',
        wrapperProps: hover(id),
        content: (
          <TaskRow
            task={task}
            snapshot={snapshot}
            lit={lit}
            onJump={onJumpToRun ? () => onJumpToRun(task.runId) : undefined}
          />
        ),
      });
      peeks.set(id, { anchor: id, peek: <TaskPeek task={task} snapshot={snapshot} /> });
    }
  };

  if (showForYou) {
    const swollen = swell && !youFocused ? { key: swell.key, ...swellOf(swell, snapshot, selfUserId) } : null;
    entries.push({
      id: FOR_YOU_ID,
      card: youFocused,
      fit: !youFocused && !swollen,
      phase: phaseOf(FOR_YOU_ID),
      birthing: born(FOR_YOU_ID),
      bump: (rises[FOR_YOU_ID] ?? 0) + swellTicks,
      wrapperProps: hover(FOR_YOU_ID),
      content: youFocused ? (
        <FocusCard
          testId="dock-focus-card"
          color="var(--accent)"
          title="For you"
          count={youCount}
          body={line}
          foot="Mentions from people first, then your agent's approvals."
          restoreSelector='[data-testid="dock-pill-for-you"]'
          onClear={onClear}
        />
      ) : (
        <Pill
          testId="dock-pill-for-you"
          color="var(--accent)"
          label="For you"
          count={youCount}
          dim={dimOthers}
          waiting={false}
          fresh={false}
          accent
          phase={phaseOf(FOR_YOU_ID)}
          swell={swollen}
          onClick={() => onToggle({ kind: 'for-you' })}
        />
      ),
    });
    if (!youFocused) {
      peeks.set(FOR_YOU_ID, {
        anchor: FOR_YOU_ID,
        peek: <Peek color="var(--accent)" title="For you" body={line} foot="Click to focus." />,
      });
    }
  }

  const unsorted = tasks.filter((t) => t.themeId === null);
  if (unsorted.length > 0) {
    entries.push({
      id: UNSORTED_ID,
      card: false,
      fit: true,
      phase: 'placed',
      content: <UnsortedHeading count={unsorted.length} />,
    });
    taskEntries(unsorted);
  }

  for (const theme of visibleThemes) {
    const id = THEME_PREFIX + theme.id;
    const focused = focusedThemeId === theme.id;
    const color = themeColor(theme.id);
    entries.push({
      id,
      card: focused,
      fit: !focused,
      phase: phaseOf(theme.id),
      birthing: born(theme.id),
      bump: rises[id] ?? 0,
      wrapperProps: hover(id),
      content: focused ? (
        <FocusCard
          testId="dock-focus-card"
          color={color}
          title={theme.name}
          count={whoCounts ? (whoCounts.get(theme.id) ?? 0) : theme.count}
          body={theme.description}
          foot={`Showing ${whoCounts ? (whoCounts.get(theme.id) ?? 0) : theme.count} of ${snapshot.messages.length} messages.`}
          restoreSelector={`[data-testid="dock-pill"][data-theme-id="${CSS.escape(theme.id)}"]`}
          onClear={onClear}
        />
      ) : (
        <Pill
          testId="dock-pill"
          themeId={theme.id}
          color={color}
          label={theme.name}
          count={whoCounts ? (whoCounts.get(theme.id) ?? 0) : theme.count}
          of={whoCounts ? theme.count : undefined}
          dim={dimOthers}
          waiting={waitingThemes.has(theme.id)}
          fresh={freshThemeIds.has(theme.id)}
          phase={phaseOf(theme.id)}
          onClick={() => onToggle({ kind: 'theme', themeId: theme.id })}
        />
      ),
    });
    if (!focused) {
      const last = themes ? themeLastActivity(theme.id, themes, snapshot, selfUserId) : null;
      const messages = `${theme.count} ${theme.count === 1 ? 'message' : 'messages'}`;
      peeks.set(id, {
        anchor: id,
        peek: (
          <Peek
            color={color}
            title={theme.name}
            body={theme.description}
            foot={`${messages}.${last ? ` Last from ${last.who} at ${last.time}.` : ''} Click to focus.`}
          />
        ),
      });
    }
    taskEntries(tasks.filter((t) => t.themeId === theme.id));
  }

  if (moreThemes.length > 0) {
    entries.push({
      id: MORE_ID,
      card: false,
      fit: true,
      phase: 'placed',
      content: narrow ? (
        <ThemeListPill
          themes={listed}
          onPick={(theme) => onToggle({ kind: 'theme', themeId: theme.id })}
          testId="dock-themes"
          ariaLabel={`Topics ${listed.length}`}
          label={
            <span className="relative flex items-center gap-1.5">
              Topics
              <span className="font-mono text-2xs tabular-nums">{listed.length}</span>
            </span>
          }
        />
      ) : (
        <ThemeListPill
          themes={rest}
          onPick={(theme) => onToggle({ kind: 'theme', themeId: theme.id })}
          testId="dock-more"
          ariaLabel={`${rest.length} more ${rest.length === 1 ? 'topic' : 'topics'}`}
          label={<span className="relative font-mono text-2xs tabular-nums">+{rest.length}</span>}
        />
      ),
    });
  }

  // A pill that is still on its way (the bead, the drop) is not hovered yet.
  const hoveredEntry = hovered ? entries.find((e) => e.id === hovered) : undefined;
  const peekOf = hoveredEntry && hoveredEntry.phase === 'placed' ? peeks.get(hoveredEntry.id) : undefined;

  // The transcript lights up what the hovered pill holds, unless it is already filtered to something.
  const previewed = hoveredEntry?.phase === 'placed' ? hoveredEntry.id : null;
  const themeOf = themes?.themeOf;
  const previewIds = useMemo<ReadonlySet<string> | null>(() => {
    if (focus !== null || previewed === null) return null;
    if (previewed === FOR_YOU_ID) return forYou.messageIds;
    if (previewed.startsWith(TASK_PREFIX)) {
      const task = tasks.find((t) => TASK_PREFIX + t.runId === previewed);
      return task ? new Set([task.messageId]) : null;
    }
    if (!previewed.startsWith(THEME_PREFIX) || !themeOf) return null;
    const themeId = previewed.slice(THEME_PREFIX.length);
    const ids = new Set<string>();
    for (const [messageId, assignment] of Object.entries(themeOf)) {
      if (assignment.themeId === themeId) ids.add(messageId);
    }
    return ids;
  }, [focus, previewed, forYou.messageIds, themeOf, tasks]);

  return {
    entries,
    peek: peekOf ? { anchor: peekOf.anchor, content: peekOf.peek } : null,
    previewIds,
  };
}
