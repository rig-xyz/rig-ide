import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import type { RigSpaceStatus } from '@shared/rig/space-status';
import { deriveSpaceTileState } from './space-status-state';

/**
 * The 1b grammar's own small rounded tile (design doc: "a small status tile
 * on the LEFT... live motions per agent activity... quiet spaces = a
 * still, dim tile"). Wraps `lib/ui/dot-matrix.tsx`'s own `DotMatrix` for
 * every LIVE/END state; a genuinely quiet space (no run ever, or one too
 * old to still call "recent") gets a plain static dim grid instead —
 * `DotMatrix` itself has no "quiet" state of its own (only `done`/`failed`/
 * `stopped`/`queued`, none of which honestly means "nothing has happened
 * in a while"), so this stays a local, additive look rather than one more
 * state added to a component this app's other features also depend on.
 */
export function SpaceStatusTile({
  status,
  size = 'md',
  className,
}: {
  status: RigSpaceStatus | undefined;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const tile = deriveSpaceTileState(status, Date.now());
  return (
    <span
      className={cn('bg-bg-2 inline-flex shrink-0 items-center justify-center rounded-control p-1.5', className)}
      aria-hidden
    >
      {tile.kind === 'quiet' ? <StillDots size={size} /> : <DotMatrix state={tile.state} size={size} />}
    </span>
  );
}

/** Mirrors `dot-matrix.tsx`'s own `SIZES` cell/gap classes so a quiet tile sits flush with a live one at every size. */
const STILL_SIZES = {
  sm: { cell: 'size-[3px]', gap: 'gap-px' },
  md: { cell: 'size-1', gap: 'gap-0.5' },
  lg: { cell: 'size-2', gap: 'gap-1' },
} as const;

function StillDots({ size }: { size: 'sm' | 'md' | 'lg' }) {
  const { cell, gap } = STILL_SIZES[size];
  return (
    <span className={cn('inline-grid grid-cols-3', gap)}>
      {Array.from({ length: 9 }, (_, i) => (
        <span key={i} className={cn('bg-text-muted rounded-full opacity-20', cell)} />
      ))}
    </span>
  );
}
