import { PanelRightOpen } from 'lucide-react';
import { FOCUS_RING } from '@renderer/features/spaces/components/dock-glass';
import { DockStage, type StageEntry } from '@renderer/features/spaces/components/dock-stage';
import { CORNER_SIZE } from '@renderer/features/spaces/dock-layout';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import { useHome } from './home-context';

/**
 * The Feed folded: a tray in the corner, drawn as the Room's dock rail
 * (`DockStage`) with nothing hanging under it. It says "Feed" with how many
 * cards need you and how many are up next; opening it shows the cards.
 */

const NO_ENTRIES: readonly StageEntry[] = [];

export function FeedDock({
  onOpen,
  onLayout,
}: {
  onOpen: () => void;
  onLayout?: (width: number) => void;
}) {
  const { counts } = useHome();
  const needs = counts.needsYou > 0;
  return (
    <DockStage
      className="absolute top-[18px] right-[18px]"
      onLayout={(width) => onLayout?.(width)}
      entries={NO_ENTRIES}
      float={null}
      corner={
        <button
          type="button"
          aria-label="Open the Feed"
          title="Open the Feed"
          onClick={onOpen}
          data-dir="left"
          className={cn(
            'hf-nudge flex items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-bg-3/60 hover:text-text-primary',
            FOCUS_RING
          )}
          style={{ width: CORNER_SIZE, height: CORNER_SIZE }}
        >
          <PanelRightOpen className="size-4" strokeWidth={1.5} />
        </button>
      }
      rail={
        <div
          className="flex h-10 items-center gap-2 pr-10 pl-3.5 whitespace-nowrap"
          aria-label={`Feed: ${counts.needsYou} need you, ${counts.upNext} up next`}
        >
          <DotMatrix state={needs ? 'waiting' : 'quiet'} tone={needs ? 'warn' : 'mute'} size="sm" />
          <span className="text-sm font-medium text-text-primary">Feed</span>
          <span className="font-mono text-2xs text-text-muted tabular-nums">
            {counts.needsYou} · {counts.upNext}
          </span>
        </div>
      }
    />
  );
}
