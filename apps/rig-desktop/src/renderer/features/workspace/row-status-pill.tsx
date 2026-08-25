import { RigMark } from '@renderer/lib/ui/rig-mark';
import { cn } from '@renderer/lib/utils';

/**
 * A row's status pill. ONE kind, deliberately: an agent is writing this
 * file right now.
 *
 * There used to be three. "New" and "Recent" were badges for states most
 * rows in a working rig are in at any moment, and a badge that appears on
 * every row communicates nothing while making the list shout. Both are
 * expressed by the row itself now: unseen is a medium-weight name with its
 * timestamp in accent, recent is simply the timestamp being recent. A pill
 * is reserved for the genuinely exceptional thing, which is a machine
 * touching your file while you look at it.
 *
 * A comments kind belongs here eventually ("2 comments" with an avatar),
 * but it needs a rig-wide unresolved-comments-by-path summary the relay
 * does not expose yet. Not faked in the meantime.
 */
export type RowStatus = { kind: 'agent' };

export function RowStatusPill({ status, className }: { status: RowStatus; className?: string }) {
  void status;
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
