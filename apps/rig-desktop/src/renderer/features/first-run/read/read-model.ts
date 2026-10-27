import type { OrchProgressEvent, RunProblem, RunProgress } from '@shared/rig/orch-progress';

/**
 * The Read step's picture of the first run, from its progress events
 * (`rigOrchProgressChannel`): the ticker's lines, the three counters, how far
 * through its lookups it is, and when the first line and the first card came.
 * Pure, so the Read step, its field and the tests share one reading.
 */

export type ReadLine = RunProgress & {
  /** When it first showed, in the run's time: the ticker keeps a new line "Checking…" for a moment. */
  since: number;
};

export type ReadState = {
  run: string | null;
  lines: ReadLine[];
  counts: { read: number; handled: number; forYou: number };
  /** Lookups so far, against every pass's budget known yet. */
  lookups: { used: number; budget: number };
  cards: string[];
  /** Cards that were on the Feed before the run: they lead to the first card, but aren't new. */
  knownCards: string[];
  /** A catch-up reads from here (the last read); null for a first read of the last few days. */
  since: string | null;
  /** What got in the way while it read (a connector to reconnect), each once. */
  problems: { problem: RunProblem; connector?: string }[];
  pass: number;
  passes: number;
  firstLineAt: number | null;
  firstCardAt: number | null;
  ended: { ok: boolean; error?: string; problem?: RunProblem; t: number } | null;
};

export const initialRead: ReadState = {
  run: null,
  lines: [],
  counts: { read: 0, handled: 0, forYou: 0 },
  lookups: { used: 0, budget: 0 },
  cards: [],
  knownCards: [],
  since: null,
  problems: [],
  pass: 0,
  passes: 0,
  firstLineAt: null,
  firstCardAt: null,
  ended: null,
};

const isOutcome = (l: Pick<RunProgress, 'status'>) =>
  l.status === 'handled' || l.status === 'not_yours' || l.status === 'for_you';

/**
 * The counters. A catch-up (`since`) counts as new only the cards it put that weren't on the Feed
 * before: an outcome about one already there may name its message rather than its card, so
 * outcomes can't tell old from new. A first read counts both.
 */
function counts(lines: ReadLine[], cards: string[], knownCards: string[] = [], since: string | null = null): ReadState['counts'] {
  const known = new Set(knownCards);
  const forYou = new Set(cards.filter((c) => !known.has(c)));
  let read = 0;
  let handled = 0;
  for (const l of lines) {
    // Lookups in the person's tools; Rig's own records are its memory, not a read, so they don't count.
    if (l.connector !== null && l.connector !== 'rig' && l.status === 'done') read += 1;
    if (l.status === 'handled' || l.status === 'not_yours') handled += 1;
    // Something already on the Feed isn't a new card for them.
    if (!since && l.status === 'for_you' && !l.known && !(l.ref && known.has(l.ref))) forYou.add(l.ref ?? l.id);
  }
  return { read, handled, forYou: forYou.size };
}

export function readReducer(state: ReadState, e: OrchProgressEvent): ReadState {
  // One run at a time: a new start begins again.
  if (e.kind === 'start')
    return {
      ...initialRead,
      run: e.run,
      passes: e.passes,
      lookups: { used: 0, budget: e.lookups ?? 0 },
      since: e.since ?? null,
    };
  if (state.run !== null && e.run !== state.run) return state;
  const run = state.run ?? e.run;
  switch (e.kind) {
    case 'pass':
      // A pass past the planned ones (the widened read) brings its own budget.
      return {
        ...state,
        run,
        pass: e.pass,
        passes: Math.max(state.passes, e.pass),
        lookups: {
          ...state.lookups,
          budget:
            state.lookups.budget + (e.pass > state.passes || !state.lookups.budget ? e.lookups : 0),
        },
      };
    case 'card': {
      if (state.cards.includes(e.ref)) return state;
      const cards = [...state.cards, e.ref];
      const knownCards = e.fresh === false ? [...state.knownCards, e.ref] : state.knownCards;
      return {
        ...state,
        run,
        cards,
        knownCards,
        counts: counts(state.lines, cards, knownCards, state.since),
        firstCardAt: state.firstCardAt ?? e.t,
      };
    }
    case 'problem':
      if (state.problems.some((p) => p.problem === e.problem && p.connector === e.connector)) return state;
      return { ...state, run, problems: [...state.problems, { problem: e.problem, ...(e.connector ? { connector: e.connector } : {}) }] };
    case 'end':
      return {
        ...state,
        run,
        ended: { ok: e.ok, ...(e.error ? { error: e.error } : {}), ...(e.problem ? { problem: e.problem } : {}), t: e.t },
      };
    case 'line': {
      const at = state.lines.findIndex((l) => l.id === e.line.id);
      const isNew = at < 0;
      const line: ReadLine = { ...e.line, since: isNew ? e.line.t : state.lines[at]!.since };
      const lines = isNew
        ? [...state.lines, line]
        : state.lines.map((l, i) => (i === at ? line : l));
      // A lookup counts once, when it shows; Rig's own steps don't.
      const used =
        state.lookups.used + (isNew && e.line.connector !== null && !isOutcome(e.line) ? 1 : 0);
      return {
        ...state,
        run,
        lines,
        counts: counts(lines, state.cards, state.knownCards, state.since),
        lookups: { ...state.lookups, used },
        firstLineAt: state.firstLineAt ?? e.line.t,
      };
    }
  }
}

/** How far the bar is: lookups against the budget, never full until the run ends. */
export function progressOf(state: ReadState): number {
  if (state.ended) return 1;
  if (!state.lookups.budget) return state.lines.length ? 0.03 : 0;
  return Math.min(0.96, Math.max(0.03, state.lookups.used / state.lookups.budget));
}

/** Lookups that finished, per tool (Rig's own records left out): what "checked" is made of. */
export function checkedByConnector(state: ReadState): { connector: string; count: number }[] {
  const by = new Map<string, number>();
  for (const l of state.lines) {
    if (l.connector && l.connector !== 'rig' && l.status === 'done')
      by.set(l.connector, (by.get(l.connector) ?? 0) + 1);
  }
  return [...by]
    .map(([connector, count]) => ({ connector, count }))
    .sort((a, b) => b.count - a.count);
}

/** What it's doing right now: the newest lookup still running, the person's tools before Rig's own. */
export function currentLine(state: ReadState): ReadLine | null {
  const running = state.lines.filter((l) => l.status === 'running');
  return running.filter((l) => l.connector !== 'rig').at(-1) ?? running.at(-1) ?? null;
}

/** The first thing it found for the person, to name on the button's hint. */
export function firstForYou(state: ReadState): ReadLine | null {
  return state.lines.find((l) => l.status === 'for_you') ?? null;
}

/** The ticker's lines: the newest few, Rig's own state lookups left out once the reading starts. */
export function tickerLines(state: ReadState, max = 8): ReadLine[] {
  const shown = state.lines.filter((l) => l.connector !== 'rig');
  return shown.slice(-max);
}

const DAY_MS = 86_400_000;

/**
 * The catch-up's window in words, from `since` to now: "since 9:40" today,
 * "since yesterday", "since Tuesday" this week, else "since 14 Oct".
 */
export function sinceWords(since: string | null, now = Date.now()): string | null {
  if (!since) return null;
  const at = new Date(since);
  if (Number.isNaN(at.getTime())) return null;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (at.getTime() >= today.getTime())
    return `since ${at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  if (at.getTime() >= today.getTime() - DAY_MS) return 'since yesterday';
  if (at.getTime() >= today.getTime() - 6 * DAY_MS)
    return `since ${at.toLocaleDateString(undefined, { weekday: 'long' })}`;
  return `since ${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}
