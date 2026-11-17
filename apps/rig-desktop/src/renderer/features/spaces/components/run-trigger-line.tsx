import { Clock } from 'lucide-react';
import { createContext, useContext } from 'react';
import { ViewIcon } from '@renderer/features/views/view-icon';
import { cn } from '@renderer/lib/utils';
import type { ViewManifest } from '@shared/rig/views';
import type { RunTrigger } from '@shared/spaces/room-sees';
import { RigMark } from '@renderer/lib/ui/rig-mark';

/**
 * The space's views, for the lines in the Room that point at one: its title and icon, and how to
 * open its tab. Absent outside a space with views (Rig Alpha off): a line then names the view by
 * its folder and is not a link.
 */
export type SpaceViewLinks = {
  views: readonly ViewManifest[];
  /** Opens the view's tab; absent where the Room cannot move the centre. */
  onOpenView?: (name: string) => void;
};
export const SpaceViewLinksContext = createContext<SpaceViewLinks | null>(null);

/**
 * What started a run nobody typed a message for, shown right above its card (spike, Rig Alpha).
 * A press in a view is the person's own act, so it sits on their side like a message, but as a
 * small chip: the tab, the words on the button, the item. Pressing it opens that tab. A scheduled
 * pass or Rig's own look is nobody's act: a quiet centred line.
 */
export function RunTriggerLine({ trigger, mine }: { trigger: RunTrigger; mine: boolean }) {
  const links = useContext(SpaceViewLinksContext);
  const view = trigger.view ? links?.views.find((v) => v.name === trigger.view) : undefined;
  const title = view?.title ?? trigger.view ?? 'a view';

  if (trigger.by !== 'view') {
    return (
      <div
        data-testid="run-trigger"
        data-by={trigger.by}
        className="col-span-full flex items-center justify-center gap-1.5 pb-1.5 text-2xs text-text-muted"
      >
        {trigger.by === 'clock' ? (
          <Clock className="size-3" strokeWidth={1.7} aria-hidden />
        ) : (
          <RigMark size={11} className="shrink-0" />
        )}
        {trigger.by === 'clock' ? `${title} refreshed on schedule` : 'Rig looked after this space'}
      </div>
    );
  }

  const openView = links?.onOpenView;
  const open = trigger.view && openView ? () => openView(trigger.view!) : undefined;
  const parts = (
    <>
      <span className="flex shrink-0 items-center text-text-muted">
        <ViewIcon view={view} className="size-3.5" strokeWidth={1.7} aria-hidden />
      </span>
      <span className="shrink-0">{title}</span>
      {trigger.label && (
        <>
          <span className="text-text-muted" aria-hidden>
            ·
          </span>
          <span className="shrink-0 font-medium text-text-primary">{trigger.label}</span>
        </>
      )}
      {trigger.item && (
        <>
          <span className="text-text-muted" aria-hidden>
            ·
          </span>
          <span className="min-w-0 truncate">{trigger.item}</span>
        </>
      )}
    </>
  );
  const chip =
    'flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full border border-border-hairline bg-bg-1 px-2.5 text-xs text-text-secondary';
  return (
    <div
      data-testid="run-trigger"
      data-by="view"
      // On the person's side when it was their press, like their messages; on the left for someone else's.
      className={cn('col-span-full flex flex-col gap-1 pb-2', mine ? 'items-end' : 'items-start pl-10')}
    >
      {open ? (
        <button
          type="button"
          onClick={open}
          title={`Open ${title}`}
          data-testid="run-trigger-open"
          className={cn(
            chip,
            'transition-[background-color,border-color,transform] duration-150 ease-out hover:border-border-strong hover:bg-bg-2 active:scale-[0.98]',
            'outline-none focus-visible:ring-2 focus-visible:ring-accent/60'
          )}
        >
          {parts}
        </button>
      ) : (
        <span className={chip}>{parts}</span>
      )}
      {trigger.note && (
        <span className="max-w-[min(100%,34rem)] text-xs text-text-secondary">“{trigger.note}”</span>
      )}
    </div>
  );
}
