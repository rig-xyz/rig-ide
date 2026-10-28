import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { cn } from '@renderer/lib/utils';
import {
  DOT_MATRIX_ENDS,
  DOT_MATRIX_FRAMES,
  getMatrixTick,
  isDotMatrixEnd,
  subscribeMatrixClock,
  type DotMatrixActivity,
  type DotMatrixState,
} from './dot-matrix';

/**
 * A field of the app's 3×3 dot matrices, like a room of agents at work: the
 * website's agent field (hub/web `homepage/agent-field.tsx`), drawn from this
 * app's own `dot-matrix.tsx` frames and clock rather than a copy of them.
 *
 * `ambient`: each tile plays an activity, now and then finishes, rests and
 * starts again. `idle`: every tile rests, dim, until something wakes it.
 * The first run drives it through a ref: `wake` lights a patch in a color
 * (a connector found), and `tile(id)` claims one tile for one thing being
 * read, then settles it to an end glyph.
 *
 * One canvas, drawn on the matrix clock only while something on it moves
 * (ambient tiles, or a claimed tile still at work), it's on screen, and the
 * window is visible; otherwise once after each change. With reduced motion
 * the clock never ticks, so it draws one still frame, again after each change.
 */

export type AgentFieldMode = 'ambient' | 'idle';

/** A circle on the field: center and radius as fractions of its width and height. */
export type AgentFieldRegion = { x: number; y: number; radius: number };

/** A color: a CSS custom property (`--theme-3`) read off the page, or any canvas color. */
export type AgentFieldColor = string;

export type AgentFieldTile = {
  set(state: DotMatrixState, color?: AgentFieldColor): void;
  /** Back to whatever the field is doing. */
  release(): void;
  /**
   * Where the tile sits once `set` has claimed it: its center as fractions of the field's width and
   * height, for something drawn next to it over the field (a caption). Null while unclaimed.
   */
  at(): { x: number; y: number } | null;
};

export type AgentFieldHandle = {
  setMode(mode: AgentFieldMode): void;
  /**
   * The finish: every tile sweeps in toward a point (fractions of the field),
   * outer ones first, brightening and turning green as it goes and fading as
   * it arrives, like a breath out. Then the field is empty and its rest grid
   * fades softly back. Any mode change ends it.
   */
  gather(target: { x: number; y: number }, ms?: number): void;
  wake(region: AgentFieldRegion, color: AgentFieldColor): void;
  /** One tile, held by `id` until released; first claimed near the middle, or anywhere in `near`. */
  tile(id: string, near?: AgentFieldRegion): AgentFieldTile;
};

const ACTIVITIES: DotMatrixActivity[] = [
  'thinking',
  'reading',
  'searching',
  'editing',
  'running',
  'planning',
  'waiting',
];
const CELL = 3;
const GAP = 2;
const PITCH = 34;
const TILE = CELL * 3 + GAP * 2;
/** An idle tile: every dot faintly there. The field's own rest, quieter than any glyph. */
const REST_FRAME = Array<number>(9).fill(0.1);
/** After a gather, how long the empty field takes to let its rest grid back in. */
const GATHER_REST_MS = 1600;
/** At most this many claimed tiles: past it, the oldest (a settled one first) goes back to the field. */
export const MAX_CLAIMED_TILES = 40;

const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

type Ambient = { kind: 'ambient'; state: DotMatrixActivity | 'done' | 'starting'; until: number };
type Fixed = { kind: 'fixed'; state: DotMatrixState; color: AgentFieldColor | null };
type Tile = { x: number; y: number; offset: number; run: Ambient | Fixed | null };

function pick<T>(xs: readonly T[]): T {
  return xs[Math.floor(Math.random() * xs.length)]!;
}

/** Woken patches and ambient runs end with a mode change; claimed tiles keep their state. */
function clearUnclaimed(f: { tiles: Tile[]; claims: Map<string, { index: number }> }): void {
  const claimed = new Set([...f.claims.values()].map((c) => c.index));
  f.tiles.forEach((tile, index) => {
    if (!claimed.has(index)) tile.run = null;
  });
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export const AgentField = forwardRef<
  AgentFieldHandle,
  { mode?: AgentFieldMode; className?: string }
>(function AgentField({ mode = 'ambient', className }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const field = useRef<{
    tiles: Tile[];
    width: number;
    height: number;
    mode: AgentFieldMode;
    claims: Map<string, { index: number; run: Fixed | null }>;
    gather: { start: number; ms: number; x: number; y: number } | null;
    /** Draws now, after a change, and starts or stops the clock for what's moving. */
    draw: () => void;
  }>({ tiles: [], width: 0, height: 0, mode, claims: new Map(), gather: null, draw: () => {} });

  useImperativeHandle(ref, () => {
    const f = field.current;
    const claim = (id: string, region?: AgentFieldRegion): number => {
      const existing = f.claims.get(id);
      if (existing) return existing.index;
      if (f.claims.size >= MAX_CLAIMED_TILES) {
        // The oldest settled one goes back to the field, else the oldest.
        const held = [...f.claims.entries()];
        const [oldest, { index: freed }] =
          held.find(([, c]) => c.run && isDotMatrixEnd(c.run.state)) ?? held[0]!;
        f.claims.delete(oldest);
        const tile = f.tiles[freed];
        if (tile) tile.run = null;
      }
      const taken = new Set([...f.claims.values()].map((c) => c.index));
      if (region) {
        const inside = f.tiles
          .map((tile, index) => ({ tile, index }))
          .filter(
            ({ tile, index }) =>
              !taken.has(index) &&
              Math.hypot(
                (tile.x + TILE / 2) / f.width - region.x,
                (tile.y + TILE / 2) / f.height - region.y
              ) <= region.radius
          );
        if (inside.length > 0) {
          const index = pick(inside).index;
          f.claims.set(id, { index, run: null });
          return index;
        }
      }
      const free = f.tiles
        .map((tile, index) => ({
          index,
          d: Math.hypot(tile.x / f.width - 0.5, tile.y / f.height - 0.5),
        }))
        .filter((t) => !taken.has(t.index))
        .sort((a, b) => a.d - b.d);
      // Near the middle, where the mask leaves the field brightest, but not in a ring.
      const near = free.slice(0, Math.max(1, Math.ceil(free.length * 0.4)));
      const index = near.length > 0 ? pick(near).index : 0;
      f.claims.set(id, { index, run: null });
      return index;
    };
    return {
      setMode(next) {
        f.mode = next;
        f.gather = null;
        clearUnclaimed(f);
        f.draw();
      },
      gather(target, ms = 1700) {
        f.claims.clear();
        f.tiles.forEach((tile) => {
          if (tile.run?.kind === 'fixed') tile.run = { ...tile.run };
        });
        const start = performance.now();
        f.gather = { start, ms: prefersReducedMotion() ? 0 : ms, x: target.x, y: target.y };
        // Frame by frame while it moves, then a little longer for the grid to fade back.
        const step = () => {
          if (!f.gather || f.gather.start !== start) return;
          f.draw();
          if (performance.now() < start + f.gather.ms + GATHER_REST_MS) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      },
      wake(region, color) {
        const claimed = new Set([...f.claims.values()].map((c) => c.index));
        f.tiles.forEach((tile, index) => {
          if (claimed.has(index)) return;
          const dx = (tile.x + TILE / 2) / f.width - region.x;
          const dy = (tile.y + TILE / 2) / f.height - region.y;
          if (Math.hypot(dx, dy) <= region.radius) {
            tile.run = { kind: 'fixed', state: pick(ACTIVITIES), color };
          }
        });
        f.draw();
      },
      tile(id, near) {
        return {
          set(state, color) {
            const index = claim(id, near);
            const run: Fixed = { kind: 'fixed', state, color: color ?? null };
            f.claims.set(id, { index, run });
            const tile = f.tiles[index];
            if (tile) tile.run = run;
            f.draw();
          },
          release() {
            const held = f.claims.get(id);
            f.claims.delete(id);
            const tile = held ? f.tiles[held.index] : undefined;
            if (tile) tile.run = null;
            f.draw();
          },
          at() {
            const held = f.claims.get(id);
            const tile = held ? f.tiles[held.index] : undefined;
            if (!tile || !f.width || !f.height) return null;
            return { x: (tile.x + TILE / 2) / f.width, y: (tile.y + TILE / 2) / f.height };
          },
        };
      },
    };
  }, []);

  useEffect(() => {
    field.current.mode = mode;
    clearUnclaimed(field.current);
    field.current.draw();
  }, [mode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const f = field.current;
    const still = prefersReducedMotion();
    const colors = { accent: '', rest: '', ok: '' };
    /** Custom properties read off the page, kept until the theme changes (never read per tile per frame). */
    const read = new Map<string, string>();

    const resolve = (color: AgentFieldColor | null, fallback: string) => {
      if (!color) return fallback;
      if (!color.startsWith('--')) return color;
      let value = read.get(color);
      if (value === undefined) {
        value = getComputedStyle(canvas).getPropertyValue(color).trim();
        read.set(color, value);
      }
      return value || fallback;
    };
    const readColors = () => {
      read.clear();
      colors.accent = resolve('--accent', '#62a4f5');
      colors.rest = resolve('--text-muted', '#6b7480');
      colors.ok = resolve('--status-ok', '#4ade80');
    };

    const layout = () => {
      const { width, height } = canvas.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cols = Math.floor(width / PITCH);
      const rows = Math.floor(height / PITCH);
      const ox = (width - (cols - 1) * PITCH - TILE) / 2;
      const oy = (height - (rows - 1) * PITCH - TILE) / 2;
      // Where each claimed tile stood, as fractions of the old field, to find it again below.
      const spots = new Map(
        [...f.claims.entries()].map(([id, c]) => {
          const tile = f.tiles[c.index];
          return [id, tile ? { x: tile.x / f.width, y: tile.y / f.height } : { x: 0.5, y: 0.5 }];
        })
      );
      f.width = width;
      f.height = height;
      f.tiles = [];
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++)
          f.tiles.push({
            x: ox + c * PITCH,
            y: oy + r * PITCH,
            offset: Math.floor(Math.random() * 200),
            run: null,
          });
      // Claimed tiles keep their state, on the free tile nearest where they stood.
      const held = [...f.claims.entries()];
      f.claims.clear();
      for (const [id, { run }] of held) {
        const spot = spots.get(id)!;
        let free = -1;
        let nearest = Infinity;
        f.tiles.forEach((tile, index) => {
          if (tile.run) return;
          const d = Math.hypot(tile.x / width - spot.x, tile.y / height - spot.y);
          if (d < nearest) {
            nearest = d;
            free = index;
          }
        });
        if (free < 0) break;
        f.claims.set(id, { index: free, run });
        f.tiles[free]!.run = run;
      }
    };

    const ambient = (tile: Tile, t: number): Ambient => {
      if (tile.run?.kind === 'ambient') {
        const run = tile.run;
        if (still || t < run.until) return run;
        if (run.state === 'done') return { kind: 'ambient', state: 'starting', until: t + 12 };
        if (run.state === 'starting')
          return {
            kind: 'ambient',
            state: pick(ACTIVITIES),
            until: t + 60 + Math.floor(Math.random() * 300),
          };
        return { kind: 'ambient', state: 'done', until: t + 40 + Math.floor(Math.random() * 120) };
      }
      const done = Math.random() < 0.18;
      return {
        kind: 'ambient',
        state: done ? 'done' : pick(ACTIVITIES),
        until: t + 30 + Math.floor(Math.random() * 260),
      };
    };

    const draw = () => {
      const t = getMatrixTick();
      ctx.clearRect(0, 0, f.width, f.height);
      const g = f.gather;
      const now = performance.now();
      const G = g ? (g.ms ? (now - g.start) / g.ms : 1) : 0;
      if (g && G >= 1) {
        // Gathered: an empty field, its rest grid coming softly back.
        const back = clamp01((now - g.start - g.ms) / GATHER_REST_MS) * 0.6;
        ctx.fillStyle = colors.rest;
        for (const tile of f.tiles) {
          for (let k = 0; k < 9; k++) {
            ctx.globalAlpha = REST_FRAME[k]! * back;
            ctx.beginPath();
            ctx.arc(
              tile.x + (k % 3) * (CELL + GAP) + CELL / 2,
              tile.y + Math.floor(k / 3) * (CELL + GAP) + CELL / 2,
              CELL / 2,
              0,
              Math.PI * 2
            );
            ctx.fill();
          }
        }
        ctx.globalAlpha = 1;
        return;
      }
      const tx = g ? g.x * f.width : 0;
      const ty = g ? g.y * f.height : 0;
      const far = g
        ? Math.max(
            Math.hypot(tx, ty),
            Math.hypot(f.width - tx, ty),
            Math.hypot(tx, f.height - ty),
            Math.hypot(f.width - tx, f.height - ty)
          )
        : 1;
      for (const tile of f.tiles) {
        let frame: number[];
        let color: string;
        let glow = false;
        if (tile.run?.kind === 'fixed') {
          const { state } = tile.run;
          frame = isDotMatrixEnd(state)
            ? DOT_MATRIX_ENDS[state].frame
            : DOT_MATRIX_FRAMES[state](t + tile.offset);
          const fallback =
            state === 'done' ? colors.ok : isDotMatrixEnd(state) ? colors.rest : colors.accent;
          color = resolve(tile.run.color, fallback);
          glow = state === 'waiting';
        } else if (f.mode === 'ambient') {
          const run = ambient(tile, t);
          tile.run = run;
          frame =
            run.state === 'done'
              ? DOT_MATRIX_ENDS.done.frame
              : DOT_MATRIX_FRAMES[run.state](t + tile.offset);
          color = run.state === 'done' ? colors.rest : colors.accent;
        } else {
          frame = REST_FRAME;
          color = colors.rest;
        }
        // Gathering: sweep toward the point, outer tiles first; brighten, go green, and fade on arrival.
        let dx = 0;
        let dy = 0;
        let fade = 1;
        let boost = 0;
        let radius = CELL / 2;
        if (g) {
          const cx0 = tile.x + TILE / 2;
          const cy0 = tile.y + TILE / 2;
          const d = Math.hypot(tx - cx0, ty - cy0) / far;
          const p = clamp01((G - (1 - d) * 0.45) / 0.55);
          if (p >= 1) continue;
          const e = easeInOut(p);
          dx = (tx - cx0) * e;
          dy = (ty - cy0) * e;
          fade = 1 - e * e;
          boost = Math.sin(Math.PI * Math.min(1, p * 1.25)) * 0.75;
          radius = (CELL / 2) * (1 - 0.35 * e);
          if (p > 0.08) color = colors.ok;
          glow = false;
        }
        if (glow) {
          const cx = tile.x + TILE / 2;
          const cy = tile.y + TILE / 2;
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 20);
          g.addColorStop(0, color);
          g.addColorStop(1, 'transparent');
          ctx.globalAlpha = 0.35;
          ctx.fillStyle = g;
          ctx.fillRect(cx - 20, cy - 20, 40, 40);
        }
        ctx.fillStyle = color;
        for (let k = 0; k < 9; k++) {
          ctx.globalAlpha = Math.min(1, frame[k]! + boost) * fade;
          ctx.beginPath();
          ctx.arc(
            tile.x + dx + (k % 3) * (CELL + GAP) + CELL / 2,
            tile.y + dy + Math.floor(k / 3) * (CELL + GAP) + CELL / 2,
            radius,
            0,
            Math.PI * 2
          );
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    };

    /** Ambient tiles, or a claimed tile still at work (an end glyph holds still). */
    const moving = () =>
      f.mode === 'ambient' ||
      f.tiles.some((tile) => tile.run?.kind === 'fixed' && !isDotMatrixEnd(tile.run.state));

    // Ticks only while something moves, the field is on screen and the window is showing.
    let onScreen = false;
    let unsubscribe: (() => void) | null = null;
    const sync = () => {
      const run = onScreen && document.visibilityState === 'visible' && !still && moving();
      if (run && !unsubscribe) unsubscribe = subscribeMatrixClock(tick);
      else if (!run && unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    };
    const tick = () => {
      draw();
      sync();
    };
    f.draw = tick;

    readColors();
    layout();
    draw();

    const io = new IntersectionObserver(([entry]) => {
      onScreen = entry?.isIntersecting ?? false;
      sync();
    });
    io.observe(canvas);
    document.addEventListener('visibilitychange', sync);

    const ro = new ResizeObserver(() => {
      layout();
      draw();
    });
    ro.observe(canvas);

    const recolor = () => {
      readColors();
      draw();
    };
    const mo = new MutationObserver(recolor);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });
    const scheme = window.matchMedia('(prefers-color-scheme: light)');
    scheme.addEventListener('change', recolor);

    return () => {
      unsubscribe?.();
      io.disconnect();
      ro.disconnect();
      mo.disconnect();
      scheme.removeEventListener('change', recolor);
      document.removeEventListener('visibilitychange', sync);
      unsubscribe = null;
      f.draw = () => {};
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={cn('pointer-events-none absolute inset-0 size-full', className)}
    />
  );
});
