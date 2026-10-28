import { SourceLogo } from '@renderer/features/home-feed/bits';
import { cn } from '@renderer/lib/utils';
import type { KnownTool } from '@shared/rig/first-run';

/**
 * A tool's mark: its real logo when Rig knows the tool, otherwise a quiet
 * tile with its initial, so every tool Claude has gets a mark of its own
 * without Rig guessing at a brand.
 */
export function ToolMark({
  known,
  name,
  size = 15,
  className,
}: {
  known: KnownTool | null;
  name: string;
  size?: number;
  className?: string;
}) {
  if (known) return <SourceLogo connector={known} size={size} className={className} />;
  return (
    <span
      aria-hidden
      data-tool-mark="neutral"
      className={cn(
        'grid shrink-0 place-items-center rounded-[4px] bg-bg-3 font-semibold text-text-secondary',
        className
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.62), lineHeight: 1 }}
    >
      {name.trim().charAt(0).toUpperCase() || '·'}
    </span>
  );
}
