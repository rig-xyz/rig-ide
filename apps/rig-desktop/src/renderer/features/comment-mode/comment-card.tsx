import type { ReactNode } from 'react';
import { formatFull, formatRelative } from '@renderer/lib/time-format';
import { cn } from '@renderer/lib/utils';

/**
 * The comment card's pieces, shared by a file's margin (`comments-margin.tsx`)
 * and a page's pins (`page-view.tsx`) so a draft or a thread reads the same
 * wherever it's open (canvas board 16, item 4).
 */

/** The card itself: hairline edge, soft shadow; accent edge for the thread you're in (grey once resolved). */
export function CommentCardFrame({
  active = false,
  resolved = false,
  className,
  children,
  ...rest
}: {
  active?: boolean;
  resolved?: boolean;
  className?: string;
  children: ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'className' | 'children'>) {
  return (
    <div
      className={cn(
        'border-border-hairline bg-bg-1 rounded-card relative flex flex-col gap-2 border px-2.5 py-2.5 shadow-soft transition-colors',
        active && (resolved ? 'border-border-strong' : 'border-accent'),
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/** What the comment is on: the thread's number (as its pin wears it) and the quoted passage or element. */
export function CommentCardQuote({
  n,
  quote,
  active = false,
  resolved = false,
}: {
  /** None on a draft: it has no number yet. */
  n?: number;
  quote: string;
  active?: boolean;
  resolved?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-start gap-1.5">
      {n !== undefined && <CommentNumber n={n} active={active} resolved={resolved} />}
      <p className="border-border-strong text-text-muted line-clamp-2 min-w-0 flex-1 border-l-2 pl-2 text-xs" title={quote}>
        {quote}
      </p>
    </div>
  );
}

/** A thread's number on its card: the same small teardrop as its pin. */
export function CommentNumber({ n, active = false, resolved = false }: { n: number; active?: boolean; resolved?: boolean }) {
  return (
    <span
      className={cn(
        'mt-px grid size-4 shrink-0 place-items-center rounded-[999px_999px_999px_2px] text-[9px] font-bold',
        resolved ? 'bg-border-strong text-text-muted' : active ? 'bg-accent text-white' : 'bg-text-muted/80 text-bg-1'
      )}
    >
      {n}
    </span>
  );
}

/** Who wrote it and when, as one line. `who` can carry an agent's own attribution. */
export function CommentCardAuthor({ who, at }: { who: ReactNode; at: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="text-text-primary min-w-0 truncate text-xs font-medium">{who}</span>
      <time dateTime={at} title={formatFull(at)} className="text-text-muted ml-auto shrink-0 font-mono text-xs">
        {formatRelative(at)}
      </time>
    </div>
  );
}

/** Above a draft addressed to an agent: who it goes to. */
export function CommentCardTo({ icon, name }: { icon: ReactNode; name: string }) {
  return (
    <div className="bg-bg-2 text-text-secondary inline-flex w-fit items-center gap-1.5 rounded-chip px-2 py-1 text-xs">
      {icon}
      <span>{name}</span>
    </div>
  );
}

export const COMMENT_PLACEHOLDER = 'Add a comment, @ to mention';
export const REPLY_PLACEHOLDER = 'Reply, @ to mention';
