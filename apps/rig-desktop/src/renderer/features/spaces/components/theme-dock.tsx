import { ChevronDown } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { CORNER_SIZE } from '../dock-layout';
import { agentDisplayName, forYouCount } from '../dock-model';
import { EMPTY_FOR_YOU } from '../for-you';
import type { AgentKind, RoomSnapshot } from '../types';
import type { DockFocusState } from '../use-dock-focus';
import { useDockSignals } from '../use-dock-signals';
import type { ForYouState } from '../use-for-you';
import { ApprovalsPanel, useDismissOutside } from './dock-approvals';
import { usePillColumn } from './dock-pills';
import { FOCUS_RING, GOO_SPRING } from './dock-glass';
import { DockRail } from './dock-rail';
import { DockStage, type StageFloat } from './dock-stage';

/**
 * Room themes (rig/docs/room-themes-spec.md §7): the dock. A rail in the
 * corner where the pinned-card chip used to be (the listener, who is in the Space,
 * the agents, and one chevron that opens the pinned panel) and a column of pills
 * hanging from it, left-aligned to the rail's left edge: For you, then the
 * themes. The Room owns the state (focus, For you); this draws it and
 * reports how much room it takes from the transcript.
 *
 * The dock is two layers (`dock-stage.tsx`): every shape (the rail's capsule,
 * each pill, the drop, the peek and its neck) in one goo layer, so they melt
 * into one column; the text, avatars and buttons above. What the stage draws
 * comes from here: the rail, the column (`usePillColumn`) and the float
 * (the approvals panel, else the hovered pill's peek).
 *
 * TODO(room-themes): a drop flying from a new message's row to its pill
 * (spec §7 Motion). Left out of this round; pills pulse when a message joins.
 */

/** The dock's distance from the right edge, and the gap kept between it and the transcript. */
const RIGHT_INSET_PX = 16;
const GAP_TO_TRANSCRIPT_PX = 12;

const NO_ARRIVALS: ForYouState['arrivals'] = [];

export function ThemeDock({
  snapshot,
  selfUserId,
  forYouState,
  focus,
  narrow = false,
  onExpand,
  card,
  onGutterChange,
  onPreviewChange,
  className,
}: {
  /** The Room's snapshot with your pending sends in it. */
  snapshot: RoomSnapshot;
  selfUserId: string;
  /** Null until the Room's For you has been worked out: no asks, no approvals yet. */
  forYouState: ForYouState | null;
  focus: DockFocusState;
  /** A narrow Room: under the rail only For you and one "Themes N" pill, so the dock stays out of the conversation. */
  narrow?: boolean;
  /**
   * Opens the pinned panel (the Space's settings), at a section if given. Absent: the rail has no gear. The panel brings
   * its own view of the themes, and the dock is gone while it is open, so a
   * focus is let go of first: the transcript is not left filtered with no card.
   */
  onExpand?: (section?: 'people') => void;
  /**
   * The pinned panel, drawn by the stage: the rail's shape becomes its shape
   * while `open`, and the column folds away. `onFold` closes it again; the
   * dock's chevron is the one control for both, and turns to point up.
   */
  card?: { open: boolean; content: ReactNode; onFold: () => void };
  /**
   * How far from the right edge the pill column reaches, once there is one
   * (the transcript keeps clear of it), else 0. 0 again when the dock goes away.
   */
  onGutterChange?: (px: number) => void;
  /**
   * The messages a hovered (or keyboard-focused) pill holds, for the
   * transcript to light up and dim the rest; null when none is. Null again
   * when the dock goes away.
   */
  onPreviewChange?: (ids: ReadonlySet<string> | null) => void;
  /** Where the dock sits in its parent. */
  className?: string;
}) {
  const themes = snapshot.themes ?? null;
  const forYou = forYouState?.forYou ?? EMPTY_FOR_YOU;
  const forYouShown = forYouCount(forYou) > 0 || focus.focus?.kind === 'for-you';
  const signals = useDockSignals(
    themes,
    forYouState?.arrivals ?? NO_ARRIVALS,
    forYouShown,
    forYouState?.ready ?? false
  );
  const column = usePillColumn({
    snapshot,
    themes,
    forYou,
    selfUserId,
    focus: focus.focus,
    freshThemeIds: signals.freshThemeIds,
    bornIds: signals.bornIds,
    swell: signals.swell,
    narrow,
    onToggle: focus.toggle,
    onClear: focus.clear,
  });

  const [openAgent, setOpenAgent] = useState<AgentKind | null>(null);
  const closeAgent = useCallback(() => setOpenAgent(null), []);
  const railRef = useRef<HTMLDivElement>(null);
  const floatRef = useRef<HTMLDivElement>(null);
  const dismissRoots = useMemo(() => [railRef, floatRef], []);
  // A press in the rail or the panel is inside; Esc hands the keyboard back to the agent whose panel it was.
  useDismissOutside(dismissRoots, openAgent !== null, closeAgent, () =>
    railRef.current?.querySelector<HTMLElement>(
      `[data-testid="dock-agent"][data-own="true"][data-agent="${openAgent}"]`
    )
  );
  const clearFocus = focus.clear;
  const expand = useMemo(
    () =>
      onExpand
        ? (section?: 'people') => {
            clearFocus();
            setOpenAgent(null);
            onExpand(section);
          }
        : undefined,
    [onExpand, clearFocus]
  );
  const cardOpen = card?.open === true;
  const onFold = card?.onFold;

  // The room the dock takes: its widest part, once pills hang under the rail.
  const gutterRef = useRef(onGutterChange);
  gutterRef.current = onGutterChange;
  const onLayout = useCallback((width: number, hasColumn: boolean) => {
    gutterRef.current?.(
      hasColumn ? Math.ceil(width) + RIGHT_INSET_PX + GAP_TO_TRANSCRIPT_PX : 0
    );
  }, []);
  useEffect(() => () => gutterRef.current?.(0), []);

  // The transcript dims what the hovered pill does not hold.
  const previewRef = useRef(onPreviewChange);
  previewRef.current = onPreviewChange;
  const previewIds = column.previewIds;
  useEffect(() => {
    previewRef.current?.(previewIds);
  }, [previewIds]);
  useEffect(() => () => previewRef.current?.(null), []);

  const approvals: StageFloat | null = openAgent
    ? {
        anchor: 'rail',
        live: true,
        content: (
          <ApprovalsPanel
            key={openAgent}
            agentName={agentDisplayName(openAgent, null)}
            approvals={forYou.approvals.filter((a) => a.agent === openAgent)}
            themes={themes}
            selfUserId={selfUserId}
            onApprove={forYouState?.approve ?? noop}
            onApproveAll={forYouState?.approveAll ?? noop}
            onReject={forYouState?.reject ?? noop}
          />
        ),
      }
    : null;

  return (
    <DockStage
      className={className}
      floatRef={floatRef}
      onLayout={onLayout}
      entries={column.entries}
      float={approvals ?? column.peek}
      card={card ? { open: card.open, content: card.content } : null}
      corner={
        expand ? (
          <DockToggle
            open={cardOpen}
            onToggle={() => (cardOpen ? onFold?.() : expand())}
          />
        ) : undefined
      }
      rail={
        <div ref={railRef}>
          <DockRail
            snapshot={snapshot}
            selfUserId={selfUserId}
            forYou={forYou}
            hearing={signals.hearing}
            birthing={signals.bornIds.size > 0}
            openAgent={openAgent}
            onToggleAgent={(agent) =>
              setOpenAgent((current) => (current === agent ? null : agent))
            }
            onExpand={expand}
          />
        </div>
      }
    />
  );
}

function noop(): void {}

/**
 * The dock's one toggle: a chevron in the rail's top-right corner that opens
 * the pinned panel, and, drawn in the same place on the panel's corner, folds
 * it back. It never moves: it turns to point up on the shapes' spring while
 * the rail becomes the panel, and down again as it folds.
 */
function DockToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const reduced = useReducedMotion() ?? false;
  const label = open ? 'Fold into the rail' : 'Open Space details';
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onToggle}
            aria-label={label}
            aria-expanded={open}
            data-testid="dock-toggle"
            className={cn(
              'flex items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-bg-3/60 hover:text-text-primary',
              FOCUS_RING
            )}
            style={{ width: CORNER_SIZE, height: CORNER_SIZE }}
          >
            <ChevronDown
              className="size-4"
              strokeWidth={1.5}
              data-testid="dock-toggle-icon"
              style={{
                transform: `rotate(${open ? 180 : 0}deg)`,
                transition: reduced ? 'none' : `transform .6s ${GOO_SPRING}`,
              }}
            />
          </button>
        }
      />
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
