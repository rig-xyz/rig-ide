import type { ReactNode } from 'react';

/** The small mono uppercase label over each of Home's center feeds, with a quiet mono aside on the right. */
export function HomeFeedLabel({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <h2 className="flex items-center justify-between gap-2 font-mono text-2xs font-normal tracking-[.08em] text-text-muted uppercase">
      <span className="min-w-0 truncate">{children}</span>
      {aside !== undefined && (
        <span className="shrink-0 tracking-normal normal-case tabular-nums">{aside}</span>
      )}
    </h2>
  );
}
