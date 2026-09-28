import type { ReactElement } from 'react';
import { NEEDS_CONNECTION_TOOLTIP } from '@renderer/features/home/home-connection';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';

/**
 * Wraps an action that needs the relay. While `blocked`, the action is shown
 * but inert (its own `disabled` is the caller's job) and a wrapper carries
 * the "Needs a connection" tooltip — a disabled button gets no pointer
 * events of its own, so the tooltip can't hang off it.
 */
export function NeedsConnection({
  blocked,
  children,
  className,
}: {
  blocked: boolean;
  children: ReactElement;
  className?: string;
}) {
  if (!blocked) return children;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            data-needs-connection
            className={className ?? 'inline-flex cursor-not-allowed'}
          >
            {children}
          </span>
        }
      />
      <TooltipContent side="top">{NEEDS_CONNECTION_TOOLTIP}</TooltipContent>
    </Tooltip>
  );
}
