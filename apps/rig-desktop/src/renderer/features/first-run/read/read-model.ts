import type { OrchProgressEvent, RunProgress } from '@shared/rig/orch-progress';

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
  pass: number;
  passes: number;
  firstLineAt: number | null;
  firstCardAt: number | null;
  ended: { ok: boolean; error?: string; t: number } | null;
};

export const initialRead: ReadState = {
  run: null,
  lines: [],
  counts: { read: 0, handled: 0, forYou: 0 },
  lookups: { used: 0, budget: 0 },
  cards: [],
  pass: 0,
  passes: 0,
  firstLineAt: null,
  firstCardAt: null,
  ended: null,
};

const isOutcome = (l: Pick<RunProgress, 'status'>) => l.status === 'handled' || l.status === 'not_yours' || l.status === 'for_you';

function counts(lines: ReadLine[], cards: string[]): ReadState['counts'] {
  const forYou = new Set(cards);
  let read = 0;
  let handled = 0;
  for (const l of lines) {
    // Rig's own records of what came in count too: they are reads of the person's tools, made earlier.
    if (l.connector !== null && l.status === 'done') read += 1;
    if (l.status === 'handled' || l.status === 'not_yours') handled += 1;
    if (l.status === 'for_you') forYou.add(l.ref ?? l.id);
  }
  return { read, handled, forYou: forYou.size };
}

export function readReducer(state: ReadState, e: OrchProgressEvent): ReadState {
  // One run at a time: a new start begins again.
  if (e.kind === 'start') return { ...initialRead, run: e.run, passes: e.passes, lookups: { used: 0, budget: e.lookups ?? 0 } };
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
        lookups: { ...state.lookups, budget: state.lookups.budget + (e.pass > state.passes || !state.lookups.budget ? e.lookups : 0) },
      };
    case 'card': {
      if (state.cards.includes(e.ref)) return state;
      const cards = [...state.cards, e.ref];
      return { ...state, run, cards, counts: counts(state.lines, cards), firstCardAt: state.firstCardAt ?? e.t };
    }
    case 'end':
      return { ...state, run, ended: { ok: e.ok, ...(e.error ? { error: e.error } : {}), t: e.t } };
    case 'line': {
      const at = state.lines.findIndex((l) => l.id === e.line.id);
      const isNew = at < 0;
      const line: ReadLine = { ...e.line, since: isNew ? e.line.t : state.lines[at]!.since };
      const lines = isNew ? [...state.lines, line] : state.lines.map((l, i) => (i === at ? line : l));
      // A lookup counts once, when it shows; Rig's own steps don't.
      const used = state.lookups.used + (isNew && e.line.connector !== null && !isOutcome(e.line) ? 1 : 0);
      return {
        ...state,
        run,
        lines,
        counts: counts(lines, state.cards),
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

/** The ticker's lines: the newest few, Rig's own state lookups left out once the reading starts. */
export function tickerLines(state: ReadState, max = 8): ReadLine[] {
  const shown = state.lines.filter((l) => l.connector !== 'rig');
  return shown.slice(-max);
}
