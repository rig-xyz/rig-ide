import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import { DICE_FACES, idlePattern, MAX_NEW_MESSAGES, type SpaceAttention } from './space-status-state';

/**
 * The 1b grammar's own small rounded tile, saying the one thing in a space
 * most worth your attention (`deriveSpaceAttention`): `lib/ui/dot-matrix.tsx`'s
 * own `DotMatrix` for a live motion and for the failed (✕) / finished (✓)
 * end glyphs; new messages as accent dice faces; and, when there's nothing
 * for you, the space's own faint pattern (seeded by its bindingId, so it
 * never changes). The dice and idle frames are still grids local to Home —
 * neither is a run state, so they stay out of `DotMatrix`, which the Room's
 * session cards also depend on.
 */
export function SpaceStatusTile({
  attention,
  seed,
  size = 'md',
  dot,
  quiet = false,
  className,
}: {
  attention: SpaceAttention;
  /** The space's bindingId — seeds its idle pattern. */
  seed: string;
  size?: 'sm' | 'md' | 'lg';
  /** A dot on the top right corner: accent when something is for you, grey for plain unread. */
  dot?: 'forYou' | 'unread' | null;
  /** Fades the dots only, so every tile keeps the same background. */
  quiet?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn('bg-bg-2 relative inline-flex shrink-0 items-center justify-center rounded-control p-1.5', className)}
      aria-hidden
      data-tile={attention.kind}
    >
      <span className={cn('inline-flex transition-opacity', quiet && 'opacity-55')}>
        {attention.kind === 'live' ? (
          <DotMatrix state={attention.state} size={size} />
        ) : attention.kind === 'failed' ? (
          <DotMatrix state="failed" size={size} />
        ) : attention.kind === 'finished' ? (
          <DotMatrix state="done" size={size} />
        ) : attention.kind === 'messages' || attention.kind === 'forYou' ? (
          <StillDots
            size={size}
            lit={DICE_FACES[Math.min(attention.count, MAX_NEW_MESSAGES)]!}
            tone="bg-accent"
            on={0.95}
            off={0.08}
          />
        ) : (
          <StillDots size={size} lit={idlePattern(seed)} tone="bg-text-muted" on={0.42} off={0.1} />
        )}
      </span>
      {dot && (
        <span
          className={cn(
            'ring-bg-1 absolute top-0 right-0 size-2 rounded-full ring-2',
            dot === 'forYou' ? 'bg-accent' : 'bg-text-muted'
          )}
          data-testid="space-row-dot"
          data-dot={dot}
        />
      )}
    </span>
  );
}

/** Mirrors `dot-matrix.tsx`'s own `SIZES` cell/gap classes so a still tile sits flush with a live one at every size. */
const STILL_SIZES = {
  sm: { cell: 'size-[3px]', gap: 'gap-px' },
  md: { cell: 'size-1', gap: 'gap-0.5' },
  lg: { cell: 'size-2', gap: 'gap-1' },
} as const;

function StillDots({
  size,
  lit,
  tone,
  on,
  off,
}: {
  size: 'sm' | 'md' | 'lg';
  lit: readonly number[];
  tone: string;
  on: number;
  off: number;
}) {
  const { cell, gap } = STILL_SIZES[size];
  return (
    <span className={cn('inline-grid grid-cols-3', gap)}>
      {Array.from({ length: 9 }, (_, i) => (
        <span
          key={i}
          data-lit={lit.includes(i) || undefined}
          className={cn('rounded-full', cell, tone)}
          style={{ opacity: lit.includes(i) ? on : off }}
        />
      ))}
    </span>
  );
}
