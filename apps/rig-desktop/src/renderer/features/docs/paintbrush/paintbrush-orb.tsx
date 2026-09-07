import { useEffect, useState } from 'react';
import { ThinkingOrb } from 'thinking-orbs';
import { cn } from '@renderer/lib/utils';

/**
 * One orb, everywhere (punch-list finding 3 — "one orb, everywhere"): the
 * header pill (`paintbrush-control.tsx`), the pointer chip
 * (`paintbrush-cursor-chip.tsx`), and a streaming thread's card
 * (`comments-margin.tsx`'s `AgentReplyCard`) all render THIS component
 * rather than their own copy, so a reader sees one consistent "this is the
 * agent, and here's how hard it's working" language instead of three
 * different-looking indicators.
 *
 * `thinking-orbs`'s only nine animations are genuinely different designs
 * (`OrbState`) — armed/idle/streaming must NOT pick different ones (that
 * reads as three unrelated indicators, the bug being fixed here). Every
 * spin state below renders the SAME `searching` animation; only `speed`
 * and `paused` change, which is what the library's own props are for.
 *
 * `thinking-orbs` has no color/tint prop at all — it paints a fixed
 * grayscale ink (mirrored dark/light per its own theme detection), so
 * matching the app's accent has to happen in CSS. Hue-rotate alone does
 * nothing to pure-grayscale pixels (zero saturation for it to rotate), so
 * the recipe first manufactures saturation (`sepia(1)`, which lands the
 * hue around a warm ~40°) and then rotates THAT to this app's own accent
 * hue: `tokens.css`'s light (`#7d88e8`) and dark (`#5560c8`) `--accent`
 * values both resolve to ~234° in HSL (agreeing to under a degree), so one
 * rotation works for both themes. Saturation is boosted afterward so the
 * tint still reads at the small sizes every caller here uses. Verified by
 * rendering the exact filter over a canvas of grayscale dots and eyeballing
 * it against the accent swatch in Chromium — a real color-managed check,
 * not a guess — but it is still an approximation of the library's actual
 * per-pixel ink values, not a mathematically exact recolor; nudge the
 * `hue-rotate`/`saturate` numbers here (once, for every caller) if a
 * future accent hue drifts far enough to read wrong.
 */
const TINT_FILTER = 'grayscale(1) sepia(1) hue-rotate(194deg) saturate(3)';

/** The library's only tuned "inline" preset — every display size here is this canvas, CSS-scaled. */
const CANVAS_SIZE = 20;

export type PaintbrushOrbSpin =
  /** Mode is off: the same `searching` animation, paused on its resting frame and dimmed. */
  | 'off'
  /** Armed, nothing streaming: resting pace. */
  | 'idle'
  /** A stroke is actively streaming: same animation, just faster (`speed`, not a different state). */
  | 'streaming';

const SPEED: Record<PaintbrushOrbSpin, number> = { off: 1, idle: 1, streaming: 1.8 };

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

export function PaintbrushOrb({
  spin,
  size = CANVAS_SIZE,
  className,
}: {
  spin: PaintbrushOrbSpin;
  /** Rendered CSS px. The canvas always draws at the tuned 20px preset and is scaled via `transform` — 20 and 64 are the library's only two tuned sizes, and every placement here wants something in between or below 20. */
  size?: number;
  className?: string;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const scale = size / CANVAS_SIZE;
  const paused = spin === 'off' || reducedMotion;

  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center',
        spin === 'off' && 'opacity-40',
        className
      )}
      style={{ width: size, height: size, filter: TINT_FILTER }}
    >
      <span style={{ transform: `scale(${scale})` }}>
        <ThinkingOrb state="searching" size={CANVAS_SIZE} speed={SPEED[spin]} paused={paused} />
      </span>
    </span>
  );
}
