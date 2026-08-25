import { Clock } from 'lucide-react';
import { RigMark } from '@renderer/lib/ui/rig-mark';
import { cn } from '@renderer/lib/utils';

/**
 * Navigator v3: a file row's status pill — what is happening to this file,
 * stated in a word.
 *
 * Three kinds, in priority order, all in ONE right-hand column so a row
 * never states its state in two places at two alignments (the earlier
 * mix of an inline dot on files and a right-aligned dot on folders was
 * exactly that):
 *   - `new`: unseen since you last looked. A pill, not a dot — the same
 *     shape as everything else in the column.
 *   - `agent`: an agent session wrote this file inside the live write
 *     window (`write-activity.ts`), the only attribution the renderer can
 *     actually make.
 *   - `recent`: changed on disk within the recency window, by anyone or
 *     anything. Deliberately unattributed: the file watcher cannot tell a
 *     human's editor from the sync daemon, so the pill does not pretend to.
 *
 * A third kind belongs here eventually, "N new comments" with the
 * commenter's avatar, but it needs a rig-wide unresolved-comments-by-path
 * summary the relay does not expose yet (`rig.comments.list` is per-file,
 * so a tree of rows would mean one round trip per row). Not faked in the
 * meantime.
 */
export type RowStatus = { kind: 'agent' } | { kind: 'new' } | { kind: 'recent' };

export function RowStatusPill({ status, className }: { status: RowStatus; className?: string }) {
  if (status.kind === 'agent') {
    return (
      <span
        className={cn(
          'bg-accent-subtle text-accent flex shrink-0 items-center gap-1 rounded-full py-0.5 pr-2 pl-1.5 text-xs',
          className
        )}
      >
        <RigMark size={10} className="shrink-0" />
        Editing
      </span>
    );
  }
  if (status.kind === 'new') {
    return (
      <span
        className={cn(
          'bg-accent-subtle text-accent flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium',
          className
        )}
      >
        New
      </span>
    );
  }
  return (
    <span
      className={cn(
        'bg-bg-2 text-text-muted flex shrink-0 items-center gap-1 rounded-full py-0.5 pr-2 pl-1.5 text-xs',
        className
      )}
    >
      <Clock className="size-2.5 shrink-0" strokeWidth={2} />
      Recent
    </span>
  );
}
