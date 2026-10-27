import { useSyncExternalStore } from 'react';
import { cn } from '@renderer/lib/utils';

/**
 * A 3×3 dot matrix that says what an agent is doing by how it moves, and
 * ends on a glyph when the run is over. Every matrix on screen runs off
 * one shared clock, so two agents working side by side stay in step.
 *
 * Motions (live, in the accent): starting ripples out from the center,
 * thinking orbits the edge, reading scans rows like lines of text,
 * searching hops between cells, editing fills in reading order, running
 * moves like a level meter, planning spirals in and out, and waiting
 * breathes in the center only. End glyphs: done (check), failed (cross),
 * stopped (block), queued (bar), idle (a dim cross: nothing running) and
 * quiet (one dim dot: a suggestion, not a session yet).
 *
 * `tone` recolors a matrix where color carries meaning: amber when an agent
 * waits on you, green when it finished, muted while it waits on someone else.
 *
 * With reduced motion the clock never ticks, so each state shows its first
 * frame, which still differs from the others.
 */

export type DotMatrixActivity =
  | 'starting'
  | 'thinking'
  | 'reading'
  | 'searching'
  | 'editing'
  | 'running'
  | 'planning'
  | 'waiting';
export type DotMatrixEnd = 'done' | 'failed' | 'stopped' | 'queued' | 'idle' | 'quiet';
export type DotMatrixTone = 'accent' | 'warn' | 'ok' | 'mute';
export type DotMatrixState = DotMatrixActivity | DotMatrixEnd;

const TICK_MS = 110;

// ── the shared clock ────────────────────────────────────────────────────────
let tick = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Ticks every 110 ms while anyone listens; never with reduced motion. `AgentField` draws off it too. */
export function subscribeMatrixClock(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer && !prefersReducedMotion()) {
    timer = setInterval(() => {
      tick += 1;
      for (const l of listeners) l();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export const getMatrixTick = () => tick;

// ── frames ──────────────────────────────────────────────────────────────────
const LO = 0.14;
const blank = () => Array<number>(9).fill(LO);
const EDGE = [0, 1, 2, 5, 8, 7, 6, 3];
const SPIRAL = [0, 1, 2, 5, 8, 7, 6, 3, 4];
const HOPS = [4, 0, 5, 2, 7, 3, 8, 1, 6, 4, 2, 6, 1, 8, 3, 5, 0, 7];

/** Each activity's frame at clock tick `t`: nine opacities, row by row. */
export const DOT_MATRIX_FRAMES: Record<DotMatrixActivity, (t: number) => number[]> = {
  starting(t) {
    const phase = Math.floor(t / 2) % 5;
    const f = blank();
    [[4], [1, 3, 5, 7], [0, 2, 6, 8]].forEach((ring, i) => {
      const d = phase - i;
      const v = d === 0 ? 1 : d === 1 ? 0.4 : LO;
      for (const c of ring) f[c] = Math.max(f[c]!, v);
    });
    return f;
  },
  thinking(t) {
    const f = blank();
    [1, 0.5, 0.22].forEach((v, k) => {
      f[EDGE[(t - k + 800) % 8]!] = v;
    });
    return f;
  },
  reading(t) {
    const row = Math.floor(t / 2) % 4;
    const f = blank();
    for (let c = 0; c < 3; c++) {
      if (row < 3) f[row * 3 + c] = 1;
      if (row >= 1 && row <= 3) f[(row - 1) * 3 + c] = 0.35;
    }
    return f;
  },
  searching(t) {
    const i = Math.floor(t / 2);
    const f = blank();
    f[HOPS[(i + HOPS.length - 1) % HOPS.length]!] = 0.35;
    f[HOPS[i % HOPS.length]!] = 1;
    return f;
  },
  editing(t) {
    const n = Math.floor(t / 2) % 14;
    const f = blank();
    if (n <= 9) for (let k = 0; k < n; k++) f[k] = k === n - 1 ? 1 : 0.7;
    else if (n <= 11) f.fill(0.7);
    return f;
  },
  running(t) {
    const f = blank();
    for (let c = 0; c < 3; c++) {
      const h = Math.max(1, Math.min(3, Math.round(2 + 1.4 * Math.sin(t * 0.45 + c * 2.1))));
      for (let r = 0; r < 3; r++) if (2 - r < h) f[r * 3 + c] = r === 3 - h ? 1 : 0.55;
    }
    return f;
  },
  planning(t) {
    const n = Math.floor(t / 2) % 22;
    const f = blank();
    if (n < 9) for (let k = 0; k <= n; k++) f[SPIRAL[k]!] = k === n ? 1 : 0.65;
    else if (n < 12) f.fill(0.65);
    else for (let k = n - 11; k < 9; k++) f[SPIRAL[k]!] = 0.65;
    return f;
  },
  waiting(t) {
    const v = 0.3 + 0.7 * (0.5 - 0.5 * Math.cos(t / 5));
    const f = blank();
    f[4] = v;
    for (const c of [1, 3, 5, 7]) f[c] = LO + (v - 0.3) * 0.35;
    return f;
  },
};

const glyph = (on: number[], v = 1) => {
  const f = Array<number>(9).fill(0.08);
  for (const c of on) f[c] = v;
  return f;
};

/** Each end glyph's one frame and its default color class. */
export const DOT_MATRIX_ENDS: Record<DotMatrixEnd, { frame: number[]; tone: string }> = {
  done: { frame: glyph([3, 7, 5, 1]), tone: 'bg-success' },
  failed: { frame: glyph([0, 2, 4, 6, 8]), tone: 'bg-danger' },
  stopped: { frame: glyph([0, 1, 2, 3, 4, 5, 6, 7, 8], 0.55), tone: 'bg-text-muted' },
  queued: { frame: glyph([3, 4, 5], 0.7), tone: 'bg-text-muted' },
  idle: { frame: glyph([0, 2, 4, 6, 8], 0.32), tone: 'bg-accent' },
  quiet: { frame: glyph([4], 0.45), tone: 'bg-text-muted' },
};

const TONES: Record<DotMatrixTone, string> = {
  accent: 'bg-accent',
  warn: 'bg-status-warn',
  ok: 'bg-status-ok',
  mute: 'bg-text-muted',
};

const SIZES = {
  sm: { cell: 'size-[3px]', gap: 'gap-px' },
  md: { cell: 'size-1', gap: 'gap-0.5' },
  /** The context view's header tile. */
  xl: { cell: 'size-1.5', gap: 'gap-[3px]' },
  lg: { cell: 'size-2', gap: 'gap-1' },
} as const;

export function isDotMatrixEnd(state: DotMatrixState): state is DotMatrixEnd {
  return state in DOT_MATRIX_ENDS;
}

function LiveMatrix({
  state,
  cell,
  tone,
}: {
  state: DotMatrixActivity;
  cell: string;
  tone: string;
}) {
  const t = useSyncExternalStore(subscribeMatrixClock, getMatrixTick, getMatrixTick);
  return <Cells frame={DOT_MATRIX_FRAMES[state](t)} tone={tone} cell={cell} />;
}

function Cells({ frame, tone, cell }: { frame: number[]; tone: string; cell: string }) {
  return (
    <>
      {frame.map((opacity, i) => (
        <span
          key={i}
          className={cn('rounded-full transition-opacity duration-150 ease-out', cell, tone)}
          style={{ opacity }}
        />
      ))}
    </>
  );
}

export function DotMatrix({
  state,
  size = 'md',
  className,
  label,
  tone,
}: {
  state: DotMatrixState;
  size?: keyof typeof SIZES;
  className?: string;
  /** Overrides the state's own color; live states default to the accent. */
  tone?: DotMatrixTone;
  /** Spoken name for the state; the matrix is decorative without one. */
  label?: string;
}) {
  const { cell, gap } = SIZES[size];
  return (
    <span
      className={cn('inline-grid shrink-0 grid-cols-3', gap, className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-state={state}
    >
      {isDotMatrixEnd(state) ? (
        <Cells
          frame={DOT_MATRIX_ENDS[state].frame}
          tone={tone ? TONES[tone] : DOT_MATRIX_ENDS[state].tone}
          cell={cell}
        />
      ) : (
        <LiveMatrix state={state} cell={cell} tone={TONES[tone ?? 'accent']} />
      )}
    </span>
  );
}
