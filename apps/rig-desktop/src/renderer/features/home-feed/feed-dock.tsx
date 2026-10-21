import { PanelRightOpen } from 'lucide-react';
import { useState } from 'react';
import { FOCUS_RING } from '@renderer/features/spaces/components/dock-glass';
import { DockStage, type StageEntry } from '@renderer/features/spaces/components/dock-stage';
import { CORNER_SIZE } from '@renderer/features/spaces/dock-layout';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import { useHome } from './home-context';
import { chosen, plainSay, sayParts, spaceLabel, VERB_LABEL } from './say';
import type { FeedEntry } from './store';

/**
 * The Feed folded: the Room's dock (`DockStage`), the same goo and the same
 * grammar as its topics. A capsule says "Feed" with what's waiting; each item
 * hangs under it as a pill, amber for what needs you, the accent for what's
 * next. Hovering a pill peeks its proposal; clicking it opens the Feed on it.
 */

/** Pills under the capsule before the rest fold into "+N", like the Room's topics. */
const MAX_PILLS = 7;

const TONE = { needs_you: 'var(--status-warn)', up_next: 'var(--accent)' } as const;

export function FeedDock({
  onOpen,
  onLayout,
}: {
  /** Opens the Feed, on an item when one was clicked. */
  onOpen: (itemId?: string) => void;
  onLayout?: (width: number) => void;
}) {
  const { state, counts, spaces } = useHome();
  const [hover, setHover] = useState<string | null>(null);
  const live = state.feed.filter((e) => !e.ignored);
  const shown = live.slice(0, MAX_PILLS);
  const more = live.length - shown.length;

  const entries: StageEntry[] = shown.map((entry) => ({
    id: entry.item.id,
    card: false,
    phase: 'placed',
    fit: true,
    content: <FeedPill entry={entry} onClick={() => onOpen(entry.item.id)} />,
    wrapperProps: {
      onMouseEnter: () => setHover(entry.item.id),
      onMouseLeave: () => setHover((h) => (h === entry.item.id ? null : h)),
      onFocus: () => setHover(entry.item.id),
      onBlur: () => setHover((h) => (h === entry.item.id ? null : h)),
    },
  }));
  if (more > 0) {
    entries.push({
      id: 'more',
      card: false,
      phase: 'placed',
      content: (
        <button
          type="button"
          onClick={() => onOpen()}
          aria-label={`${more} more in the Feed`}
          className={cn(
            'flex h-[30px] items-center rounded-full px-3 text-xs text-text-secondary hover:text-text-primary',
            FOCUS_RING
          )}
        >
          +{more}
        </button>
      ),
    });
  }

  const hovered = hover ? live.find((e) => e.item.id === hover) : undefined;
  const float = hovered
    ? {
        anchor: hovered.item.id,
        content: (
          <Peek
            entry={hovered}
            where={spaceLabel(hovered.item, chosen(hovered.item, hovered.pick), spaces)}
          />
        ),
      }
    : null;

  const needs = counts.needsYou > 0;
  return (
    <DockStage
      className="absolute top-[18px] right-[18px]"
      onLayout={(width) => onLayout?.(width)}
      entries={entries}
      float={float}
      corner={
        <button
          type="button"
          aria-label="Open the Feed"
          title="Open the Feed"
          onClick={() => onOpen()}
          data-dir="left"
          className={cn(
            'hf-nudge flex items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-bg-3/60 hover:text-text-primary',
            FOCUS_RING
          )}
          style={{ width: CORNER_SIZE, height: CORNER_SIZE }}
        >
          <PanelRightOpen className="size-4" strokeWidth={1.5} />
        </button>
      }
      rail={
        <div
          className="flex h-10 items-center gap-2 pr-10 pl-3.5 whitespace-nowrap"
          aria-label={`Feed: ${counts.needsYou} need you, ${counts.upNext} up next`}
        >
          <DotMatrix state={needs ? 'waiting' : 'quiet'} tone={needs ? 'warn' : 'mute'} size="sm" />
          <span className="text-sm font-medium text-text-primary">Feed</span>
          <span className="font-mono text-2xs text-text-muted tabular-nums">
            {counts.needsYou} · {counts.upNext}
          </span>
        </div>
      }
    />
  );
}

/** One item as a topic pill: its dot, its title, how old it is. */
function FeedPill({ entry, onClick }: { entry: FeedEntry; onClick: () => void }) {
  const { item } = entry;
  return (
    <button
      type="button"
      onClick={onClick}
      data-feed-pill={item.id}
      className={cn(
        'relative flex h-[30px] max-w-full items-center gap-2 rounded-full pr-3 pl-2.5 text-xs whitespace-nowrap text-text-primary',
        FOCUS_RING
      )}
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ background: TONE[item.group] }}
      />
      <span className="max-w-[170px] min-w-0 truncate">{item.title}</span>
      <span className="shrink-0 font-mono text-2xs text-text-muted tabular-nums">{item.age}</span>
    </button>
  );
}

/** What hovering a pill says: the proposal's first words, where it happens and what the button would do. */
function Peek({ entry, where }: { entry: FeedEntry; where: string }) {
  const { item } = entry;
  const choice = chosen(item, entry.pick);
  const { lead, context } = sayParts(item, choice);
  return (
    <div className="px-3 py-2.5 text-xs" style={{ width: 260, pointerEvents: 'none' }}>
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="size-[7px] shrink-0 rounded-full"
          style={{ background: TONE[item.group] }}
        />
        <b className="min-w-0 truncate font-semibold text-text-primary">{item.title}</b>
      </div>
      <p className="mt-1 line-clamp-3 leading-snug text-text-prose">
        <b className="font-semibold">{plainSay(lead)}</b> {plainSay(context)}
      </p>
      <p className="mt-1.5 text-text-muted">
        {where} · {VERB_LABEL[choice.verb]}
      </p>
    </div>
  );
}
