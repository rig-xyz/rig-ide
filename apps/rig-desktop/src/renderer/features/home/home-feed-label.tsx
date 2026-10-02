import type { ReactNode } from 'react';

/** The small uppercase label over each of Home's center feeds, with a quiet aside on the right. */
export function HomeFeedLabel({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <h2 className="flex items-baseline gap-2 px-2 text-2xs font-medium tracking-wider text-text-muted uppercase">
      <span className="min-w-0 truncate">{children}</span>
      {aside !== undefined && (
        <span className="ml-auto shrink-0 font-mono tracking-normal normal-case tabular-nums">
          {aside}
        </span>
      )}
    </h2>
  );
}
