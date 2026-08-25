import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { useTruncated } from './use-truncated';

/**
 * Navigator v2 (`docs/file-navigator-design.md` §3.3): a tree/Suggested
 * row's name — a styled `Tooltip` appears ONLY when the visible text is
 * truncated (measured, `useTruncated`'s `scrollWidth` check) or when it's a
 * document TITLE standing in for a different real filename; otherwise no
 * tooltip at all, and never a native `title` attribute repeating what the
 * row already says.
 */
export function RowLabel({
  text,
  filename,
  className,
}: {
  /** The row's own displayed text — a document title, or the filename itself. */
  text: string;
  /** The real filename, shown in the tooltip only when it differs from `text`. */
  filename?: string;
  className?: string;
}) {
  const { ref, truncated } = useTruncated<HTMLSpanElement>();
  const titleDiffers = filename !== undefined && filename !== text;
  const span = (
    <span ref={ref} className={cn('min-w-0 truncate', className)}>
      {text}
    </span>
  );

  if (!truncated && !titleDiffers) return span;

  return (
    <Tooltip>
      <TooltipTrigger render={span} />
      <TooltipContent side="top">{titleDiffers ? filename : text}</TooltipContent>
    </Tooltip>
  );
}
