import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { useTruncated } from './use-truncated';

/**
 * Navigator v3: a row's name is the REAL FILENAME, extension included —
 * files here are things agents write, reference by path, and humans open in
 * other tools, so the filename is the identity (Drive can lead with a
 * document title because Drive has no filenames; we do). The extracted
 * document title becomes secondary information, shown in the tooltip when
 * it says something the filename doesn't.
 *
 * A styled `Tooltip` appears ONLY when the visible text is truncated
 * (measured, `useTruncated`'s `scrollWidth` check) or when a distinct
 * document title is worth surfacing. Never a native `title` attribute
 * repeating what the row already says.
 */
export function RowLabel({
  text,
  title,
  className,
}: {
  /** The row's own displayed text — the filename. */
  text: string;
  /** The document's extracted title, shown in the tooltip when it differs from the filename. */
  title?: string;
  className?: string;
}) {
  const { ref, truncated } = useTruncated<HTMLSpanElement>();
  const hasTitle = title !== undefined && title !== text;
  const span = (
    <span ref={ref} className={cn('min-w-0 truncate', className)}>
      {text}
    </span>
  );

  if (!truncated && !hasTitle) return span;

  return (
    <Tooltip>
      <TooltipTrigger render={span} />
      <TooltipContent side="top">{hasTitle ? title : text}</TooltipContent>
    </Tooltip>
  );
}
