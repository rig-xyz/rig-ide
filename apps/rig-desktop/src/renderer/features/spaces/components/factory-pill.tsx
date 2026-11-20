import { ChevronLeft } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  fitStandingUnits,
  standingUnits,
  unitLabel,
  type StandingUnit,
} from '@renderer/features/views/standing-units';
import { useSpaceStanding } from '@renderer/features/views/use-space-standing';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import type { ViewManifest } from '@shared/rig/views';
import {
  CARD_RADIUS,
  CORNER_INSET,
  CORNER_SIZE,
  FLOAT_GAP,
  FLOAT_RADIUS,
  floatLayout,
  type Box,
  type Size,
} from '../dock-layout';
import {
  agentDisplayName,
  forYouCount,
  forYouLine,
  pendingFor,
  railAgents,
  sameFocus,
  sameWho,
  splitThemes,
  distinctThemeColors,
  themeColor,
  whoMessageIds,
  type DockFocus,
  type DockWho,
} from '../dock-model';
import { EMPTY_FOR_YOU } from '../for-you';
import { useMySessions } from '../my-sessions';
import type { AgentKind, RoomSnapshot } from '../types';
import type { DockFocusState } from '../use-dock-focus';
import type { ForYouState } from '../use-for-you';
import { ApprovalsPanel, useDismissOutside } from './dock-approvals';
import { FOCUS_RING, GOO_FILL, GOO_SPRING, useGooFilter } from './dock-glass';
import { MINE_MATRIX } from './dock-pills';
import { AgentTile, MoreChip, type FaceHandlers } from './dock-rail';
import { AGENT_NAME } from './identity';

/**
 * The Room's dock, down the right edge (spike, Rig Alpha; "Down the right edge"). The same units
 * as the horizontal dock (`theme-dock.tsx`), stacked in one shape that swells out of the pane's
 * right edge, and above them the space's standing work, which the horizontal dock never showed:
 *
 * 1. what keeps running here: one dot matrix per view of the space and per pass going right now
 *    (`standing-units.ts`);
 * 2. who is here and the agents, with the halos, the approvals badge and the spotlight the
 *    horizontal dock has (the same components, `dock-rail.tsx`);
 * 3. For you and the topics, each a dot and a count, then "+N" and the chevron.
 *
 * It is drawn the way the horizontal dock is (`dock-stage.tsx`), on its own boxes: one goo layer
 * of plain shapes behind (`dock-glass.tsx`: one filter, one shadow), the content above. The
 * shapes: a wall just past the pane's edge, which the goo joins the pill to with a fillet at its
 * head and foot; the pill, which becomes the pinned panel's shape when the chevron opens it; and
 * the label of the unit under the pointer, hanging to its left from a neck. The Room only: a
 * view fills the centre without it.
 */

/** The pill's width: the horizontal rail's height, turned on its end. */
const PILL_WIDTH_PX = 40;
/** The room kept between the pill and the transcript, as for the horizontal dock. */
const GAP_TO_TRANSCRIPT_PX = 12;
/** How far past the pane's edge the shapes reach, so the edge itself is cut by the pane, straight. */
const WALL_PX = 48;
/** How much further past the edge an empty pill waits: its own width, and out of reach of its shadow. */
const TUCKED_PX = PILL_WIDTH_PX + 24;
/** How far the wall runs above and below the pill, for the goo to draw the fillets on. */
const WALL_REACH_PX = 24;
/** The goo layer reaches this far left of the edge, for a label or the panel. */
const GOO_REACH_PX = 480;
/** Never closer than this to the pane's top and bottom. */
const EDGE_MARGIN_PX = 8;
/** The label stays this long after it is let go of, and the panel's content for the fold's length (`dock-stage.tsx`). */
const LABEL_LINGER_MS = 340;
const CARD_MS = 640;
const SWAP_DELAY_S = 0.42;

export type FactoryPillProps = {
  bindingId: string;
  /** The space's views, as their `view.json` says. */
  views: readonly ViewManifest[];
  /** Opens a view's tab. Absent: a unit only says where its view stands. */
  onOpenView?: (name: string) => void;
  /** The Room's snapshot with your pending sends in it. */
  snapshot: RoomSnapshot;
  selfUserId: string;
  /** Null until the Room's For you has been worked out: no asks, no approvals yet. */
  forYouState: ForYouState | null;
  focus: DockFocusState;
  /** Opens the pinned panel, at a section if given. Absent: no chevron, and "+N" is a plain count. */
  onExpand?: (section?: 'people') => void;
  /** The pinned panel: the pill's own shape becomes its shape while `open`; `onFold` closes it. */
  card?: { open: boolean; content: ReactNode; onFold: () => void };
  /** Your own sessions in this space, listed in the open panel. Absent: no list. */
  mine?: { bindingId: string; onOpen: (sessionId: string) => void };
  /** How far from the right edge the pill reaches (the transcript keeps clear of it); 0 when it goes away. */
  onGutterChange?: (px: number) => void;
  /** The messages the hovered topic holds, for the transcript to dim the rest; null when none is. */
  onPreviewChange?: (ids: ReadonlySet<string> | null) => void;
  /** The messages of the hovered face, else of the face the transcript is filtered to. */
  onTrailChange?: (ids: ReadonlySet<string> | null) => void;
  /** The topics are shown elsewhere (the row above the composer): the pill leaves them out. */
  topicsElsewhere?: boolean;
};

const FOR_YOU: DockFocus = { kind: 'for-you' };
const FOR_YOU_KEY = 'for-you';
const topicKey = (id: string) => `topic:${id}`;

type Hover = { key: string; top: number; h: number };
/** The gap between the pill's groups (`gap-2`), which the chevron's row takes too once it is there. */
const RAIL_GAP_PX = 8;
/** Held this long after the pointer leaves, so reaching for the chevron never closes it. */
const WIDE_OUT_MS = 160;
/** What a unit does when the pointer or the keyboard is on it: its label comes out. */
type LabelHandlers = {
  onMouseEnter: (event: { currentTarget: HTMLElement }) => void;
  onMouseLeave: () => void;
  onFocus: (event: { currentTarget: HTMLElement }) => void;
  onBlur: () => void;
};

const sameSize = (a: Size | null, b: Size | null) =>
  a === b || (!!a && !!b && Math.abs(a.w - b.w) < 1 && Math.abs(a.h - b.h) < 1);

export function FactoryPill({
  bindingId,
  views,
  onOpenView,
  snapshot,
  selfUserId,
  forYouState,
  focus,
  onExpand,
  card,
  mine,
  onGutterChange,
  onPreviewChange,
  onTrailChange,
  topicsElsewhere = false,
}: FactoryPillProps) {
  const reduced = useReducedMotion() ?? false;
  const goo = useGooFilter();

  // 1. What keeps running here.
  const { spaceState, working, justScheduled, now } = useSpaceStanding(bindingId, views);
  const { shown: units, more: moreUnits } = useMemo(
    () =>
      fitStandingUnits(
        standingUnits({
          views,
          state: spaceState,
          agentName: AGENT_NAME,
          viewTurns: working,
          justScheduled,
          members: snapshot.members,
          now,
        })
      ),
    [views, spaceState, working, justScheduled, snapshot.members, now]
  );

  // 2. Faces: the spotlight, as in the horizontal dock.
  const [hoverWho, setHoverWho] = useState<DockWho | null>(null);
  const toggleWho = focus.toggleWho;
  const faces = useMemo<FaceHandlers>(
    () => ({
      selected: focus.who,
      onHover: (who) =>
        setHoverWho((current) => (who === null || !sameWho(current, who) ? who : current)),
      onToggle: toggleWho,
    }),
    [focus.who, toggleWho]
  );
  const hoverIds = useMemo(
    () => (hoverWho ? whoMessageIds(snapshot, hoverWho) : null),
    [hoverWho, snapshot]
  );
  const whoIds = useMemo(
    () => (focus.who ? whoMessageIds(snapshot, focus.who) : null),
    [focus.who, snapshot]
  );
  const { shown: agents, more: moreAgents } = useMemo(
    () => railAgents(snapshot, selfUserId),
    [snapshot, selfUserId]
  );
  const forYou = forYouState?.forYou ?? EMPTY_FOR_YOU;

  // Your agent's approvals, in a panel beside its tile.
  const [openAgent, setOpenAgent] = useState<AgentKind | null>(null);
  const closeAgent = useCallback(() => setOpenAgent(null), []);
  const agentsRef = useRef<HTMLDivElement>(null);
  useDismissOutside(agentsRef, openAgent !== null, closeAgent, () =>
    agentsRef.current?.querySelector<HTMLElement>(
      `[data-testid="dock-approvals-badge"][data-agent="${openAgent}"]`
    )
  );

  // 3. For you and the topics.
  const themes = snapshot.themes ?? null;
  const focusedThemeId = focus.focus?.kind === 'theme' ? focus.focus.themeId : null;
  const { shown: topics, rest: moreTopics } = useMemo(
    () => splitThemes(themes?.list ?? [], snapshot.messages, focusedThemeId),
    [themes, snapshot.messages, focusedThemeId]
  );
  // The topic a message went into last stands out; the others sit back.
  const newestSeq = useMemo(
    () => (themes?.list ?? []).reduce((max, theme) => Math.max(max, theme.lastSeq), 0),
    [themes]
  );
  const topicColors = useMemo(() => distinctThemeColors(themes?.list ?? []), [themes]);
  const forYouN = forYouCount(forYou);
  const forYouShown = forYouN > 0 || focus.focus?.kind === 'for-you';

  // The unit under the pointer or the keyboard: its label comes out to the left.
  const railRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  const labelHandlers = useCallback((key: string): LabelHandlers => {
    const show = (event: { currentTarget: HTMLElement }) => {
      const rail = railRef.current;
      if (!rail) return;
      const unit = event.currentTarget.getBoundingClientRect();
      setHover({ key, top: unit.top - rail.getBoundingClientRect().top, h: unit.height });
    };
    const hide = () => setHover((current) => (current?.key === key ? null : current));
    return { onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide };
  }, []);

  // Pointed at (or holding the keyboard), the pill grows downward and the chevron that opens the
  // space's details is there, under its units. At rest there is no chevron and no room for one.
  const [wide, setWide] = useState(false);
  const wideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enterPill = useCallback(() => {
    if (wideTimer.current) clearTimeout(wideTimer.current);
    setWide(true);
  }, []);
  const leavePill = useCallback(() => {
    if (wideTimer.current) clearTimeout(wideTimer.current);
    wideTimer.current = setTimeout(() => setWide(false), WIDE_OUT_MS);
  }, []);
  useEffect(() => () => void (wideTimer.current && clearTimeout(wideTimer.current)), []);
  const widened = wide && !!onExpand;
  // With nothing standing here, no agent and no topic, there is no pill at rest: an empty shape
  // says nothing. The way into the space's details stays where the pill would be, and the pill
  // comes out of the edge around its chevron when that spot is pointed at or tabbed to.
  const empty =
    units.length === 0 &&
    agents.length === 0 &&
    (topicsElsewhere || (!forYouShown && topics.length === 0 && moreTopics.length === 0));
  /** What the chevron's row adds to the pill's height while it is there (empty, its room is always kept). */
  const grownBy = widened && !empty ? CORNER_SIZE + RAIL_GAP_PX : 0;

  // What each label says, by the key of its unit.
  const labels = new Map<string, ReactNode>();
  for (const unit of units)
    labels.set(unit.key, <Label name={unit.name} line={unit.line} tone={unit.tone} />);
  if (moreUnits.length > 0) {
    labels.set(
      MORE_UNITS_KEY,
      <span className="flex flex-col gap-1.5">
        {moreUnits.map((unit) => (
          <Label key={unit.key} name={unit.name} line={unit.line} tone={unit.tone} />
        ))}
      </span>
    );
  }
  if (forYouShown) labels.set(FOR_YOU_KEY, <Label name="For you" line={forYouLine(forYou)} />);
  for (const topic of topics) {
    labels.set(
      topicKey(topic.id),
      <Label
        name={topic.name}
        line={`${topic.count} ${topic.count === 1 ? 'message' : 'messages'}`}
      />
    );
  }

  // The transcript dims what the hovered topic does not hold, unless it is already filtered.
  const themeOf = themes?.themeOf;
  const focused = focus.focus !== null;
  const hoverKey = hover?.key ?? null;
  const topicIds = useMemo<ReadonlySet<string> | null>(() => {
    if (focused || hoverKey === null) return null;
    if (hoverKey === FOR_YOU_KEY) return forYou.messageIds;
    if (!themeOf || !hoverKey.startsWith('topic:')) return null;
    const themeId = hoverKey.slice('topic:'.length);
    const ids = new Set<string>();
    for (const [messageId, assignment] of Object.entries(themeOf)) {
      if (assignment.themeId === themeId) ids.add(messageId);
    }
    return ids;
  }, [focused, hoverKey, forYou.messageIds, themeOf]);

  // The room the pill takes from the transcript.
  const gutterRef = useRef(onGutterChange);
  gutterRef.current = onGutterChange;
  useEffect(() => {
    gutterRef.current?.(PILL_WIDTH_PX + GAP_TO_TRANSCRIPT_PX);
    return () => gutterRef.current?.(0);
  }, []);

  const previewRef = useRef(onPreviewChange);
  previewRef.current = onPreviewChange;
  const previewIds = hoverIds ?? topicIds;
  useEffect(() => {
    previewRef.current?.(previewIds);
  }, [previewIds]);
  useEffect(() => () => previewRef.current?.(null), []);

  // The outline lights the hovered face's rows, else the filtered face's.
  const trailRef = useRef(onTrailChange);
  trailRef.current = onTrailChange;
  const trailIds = hoverIds ?? whoIds;
  useEffect(() => {
    trailRef.current?.(trailIds);
  }, [trailIds]);
  useEffect(() => () => trailRef.current?.(null), []);

  // The panel: its content stays for the fold's length, while the shape closes (as `dock-stage.tsx`).
  const cardOpen = card?.open === true;
  const cardHeld = useRef<ReactNode>(null);
  if (cardOpen) cardHeld.current = card.content;
  const [prevCardOpen, setPrevCardOpen] = useState(cardOpen);
  const [cardLinger, setCardLinger] = useState(false);
  if (prevCardOpen !== cardOpen) {
    setPrevCardOpen(cardOpen);
    setCardLinger(!cardOpen && !reduced && cardHeld.current !== null);
  }
  useEffect(() => {
    if (!cardLinger) return;
    const timer = setTimeout(() => setCardLinger(false), CARD_MS);
    return () => clearTimeout(timer);
  }, [cardLinger]);
  const cardShown = cardOpen || cardLinger;
  if (!cardShown) cardHeld.current = null;

  // The label: held a moment after it is let go of, and grown out of its neck once measured.
  const shownHover = cardShown ? null : hover && labels.has(hover.key) ? hover : null;
  const labelOpen = shownHover !== null;
  const heldHover = useRef<Hover | null>(null);
  if (shownHover) heldHover.current = shownHover;
  const [labelLinger, setLabelLinger] = useState(false);
  useEffect(() => {
    if (labelOpen) {
      setLabelLinger(false);
      return;
    }
    if (heldHover.current === null) return;
    if (reduced) {
      heldHover.current = null;
      return;
    }
    setLabelLinger(true);
    const timer = setTimeout(() => {
      heldHover.current = null;
      setLabelLinger(false);
    }, LABEL_LINGER_MS);
    return () => clearTimeout(timer);
  }, [labelOpen, reduced]);
  const labelAt = shownHover ?? (labelLinger ? heldHover.current : null);
  const labelNode = labelAt ? labels.get(labelAt.key) : undefined;

  // Measuring: the stage's height and each content's size, after every render and when one resizes.
  const stageRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<{
    stage: number;
    rail: Size | null;
    card: Size | null;
    label: Size | null;
  }>({ stage: 0, rail: null, card: null, label: null });
  const measure = useCallback(() => {
    const sizeOf = (el: HTMLElement | null): Size | null =>
      el ? { w: el.offsetWidth, h: el.offsetHeight } : null;
    const next = {
      stage: stageRef.current?.offsetHeight ?? 0,
      rail: sizeOf(railRef.current),
      card: sizeOf(cardRef.current),
      label: sizeOf(labelRef.current),
    };
    setSizes((previous) =>
      previous.stage === next.stage &&
      sameSize(previous.rail, next.rail) &&
      sameSize(previous.card, next.card) &&
      sameSize(previous.label, next.label)
        ? previous
        : next
    );
  }, []);
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => measure());
    for (const ref of [stageRef, railRef, cardRef, labelRef])
      if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [measure, cardShown, labelAt?.key]);

  const labelMeasured = labelNode !== undefined && sizes.label !== null;
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    if (!labelOpen) {
      setGrown(false);
      return;
    }
    if (!labelMeasured) return;
    if (reduced) {
      setGrown(true);
      return;
    }
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setGrown(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [labelOpen, labelMeasured, reduced]);

  // Layout: every box from the pane's right edge (`right`) and the stage's top (`top`).
  const railH = sizes.rail?.h ?? 0;
  const centred = (h: number) => Math.max(EDGE_MARGIN_PX, (sizes.stage - h) / 2);
  // (Placed by its resting height: it grows from its foot, and no unit moves under the pointer.)
  const railTop = centred(railH - grownBy);
  const cardSize = cardShown ? sizes.card : null;
  const cardTop = cardSize ? centred(cardSize.h) : railTop;
  const ready = sizes.stage > 0 && sizes.rail !== null;
  // Empty and at rest, the shapes wait past the edge; they slide out when the spot is pointed at.
  const tuckedAway = empty && !widened && !cardShown;
  const past = WALL_PX + (tuckedAway ? TUCKED_PX : 0);
  const pill: Box =
    cardOpen && cardSize
      ? { right: -WALL_PX, top: cardTop, w: cardSize.w + WALL_PX, h: cardSize.h, r: CARD_RADIUS }
      : {
          right: -past,
          top: railTop,
          w: PILL_WIDTH_PX + WALL_PX,
          h: railH,
          r: PILL_WIDTH_PX / 2,
        };
  // One pixel past the edge, so the wall itself never shows: only where the goo joins it to the pill.
  const wall: Box = {
    right: -past - 1,
    top: pill.top - WALL_REACH_PX,
    w: WALL_PX,
    h: pill.h + 2 * WALL_REACH_PX,
    r: 0,
  };
  const fl =
    labelAt && sizes.label
      ? floatLayout(
          { right: 0, w: PILL_WIDTH_PX, top: railTop + labelAt.top, h: labelAt.h },
          sizes.label,
          false
        )
      : null;
  const neckCx = fl ? fl.neck.right + fl.neck.w / 2 : 0;
  const neckCy = fl ? fl.neck.top + fl.neck.h / 2 : 0;
  const tucked: Box = { right: neckCx, top: neckCy, w: 0, h: 0, r: 0 };
  const labelBox = fl ? (grown ? { ...fl.box, r: FLOAT_RADIUS } : tucked) : null;
  const neckBox = fl ? (grown ? fl.neck : tucked) : null;

  const move = reduced ? '.12s ease' : `.6s ${GOO_SPRING}`;
  const swap = reduced ? { out: '0s', delay: '0s' } : { out: '.12s', delay: `${SWAP_DELAY_S}s` };
  const hasFaces = agents.length > 0;
  const hasTopics = !topicsElsewhere && (forYouShown || topics.length > 0 || moreTopics.length > 0);

  return (
    <div
      ref={stageRef}
      data-testid="factory-pill"
      data-open={cardOpen ? 'true' : 'false'}
      data-empty={empty ? 'true' : 'false'}
      className="z-20"
      // Placed inline, as the dock's stage is: the boxes below are measured from these edges.
      style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: 0, pointerEvents: 'none' }}
    >
      {goo.defs}
      {/* Behind: one layer of plain shapes, one filter, one shadow. */}
      <div
        data-testid="factory-pill-goo"
        aria-hidden
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          pointerEvents: 'none',
          right: -GOO_PAD_PX,
          width: GOO_REACH_PX + GOO_PAD_PX,
          filter: `url(#${goo.id}) var(--dock-shadow)`,
        }}
      >
        {ready && (
          <>
            <Shape id="wall" box={wall} move={move} />
            <Shape id="pill" box={pill} move={move} />
            {labelBox && neckBox && (
              <>
                <Shape id="label" box={labelBox} move={move} />
                <Shape id="label-neck" box={neckBox} move={move} />
              </>
            )}
          </>
        )}
      </div>
      {/* Above: the matrices, avatars, dots and buttons, on the same boxes. */}
      <div
        ref={railRef}
        data-testid="factory-pill-rail"
        inert={cardOpen || undefined}
        data-wide={widened ? 'true' : 'false'}
        onMouseEnter={enterPill}
        onMouseLeave={leavePill}
        onFocus={enterPill}
        onBlur={leavePill}
        className="group/pill flex flex-col items-center gap-2 py-3"
        style={{
          position: 'absolute',
          right: 0,
          top: railTop,
          width: PILL_WIDTH_PX,
          opacity: !ready || cardOpen ? 0 : 1,
          pointerEvents: !ready || cardOpen ? 'none' : 'auto',
          transition: `top ${move}, opacity ${
            cardOpen ? `${swap.out} ease` : `.25s ease ${cardShown ? swap.delay : '0s'}`
          }`,
        }}
      >
        {units.length > 0 && (
          <div className="flex flex-col items-center gap-1" data-testid="factory-pill-standing">
            {units.map((unit) => (
              <StandingUnitTile
                key={unit.key}
                unit={unit}
                onOpenView={onOpenView}
                label={labelHandlers(unit.key)}
              />
            ))}
            {moreUnits.length > 0 && (
              <span
                tabIndex={0}
                data-testid="factory-pill-units-more"
                aria-label={moreUnits.map(unitLabel).join('. ')}
                className={cn(
                  'rounded-full px-1 text-2xs text-text-muted tabular-nums',
                  FOCUS_RING
                )}
                {...labelHandlers(MORE_UNITS_KEY)}
              >
                +{moreUnits.length}
              </span>
            )}
          </div>
        )}
        {/* People are not in the pill: who is here shows by Invite, at the top of the window. */}
        {agents.length > 0 && (
          <>
            {units.length > 0 && <Hairline />}
            <div
              ref={agentsRef}
              className="relative flex flex-col items-center gap-[5px]"
              data-testid="dock-agents"
            >
              {agents.map((railAgent) => (
                <AgentTile
                  key={`${railAgent.owner}:${railAgent.agent}`}
                  vertical
                  railAgent={railAgent}
                  snapshot={snapshot}
                  pending={railAgent.own ? pendingFor(forYou, railAgent.agent) : 0}
                  open={openAgent === railAgent.agent && railAgent.own}
                  faces={faces}
                  onToggleApprovals={() =>
                    setOpenAgent((current) =>
                      current === railAgent.agent ? null : railAgent.agent
                    )
                  }
                />
              ))}
              {moreAgents > 0 && (
                <MoreChip
                  count={moreAgents}
                  label={`${moreAgents} more ${moreAgents === 1 ? 'agent' : 'agents'}`}
                  testId="dock-agents-more"
                  onClick={onExpand ? () => onExpand() : undefined}
                />
              )}
              {openAgent && (
                <div
                  data-testid="factory-pill-approvals"
                  className="card-pop-in absolute top-0 right-full origin-top-right"
                  style={{
                    marginRight: FLOAT_GAP + (PILL_WIDTH_PX - 28) / 2,
                    borderRadius: FLOAT_RADIUS,
                    background: GOO_FILL,
                    filter: 'var(--dock-shadow)',
                  }}
                >
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
                </div>
              )}
            </div>
          </>
        )}
        {hasTopics && (
          <>
            {(units.length > 0 || hasFaces) && <Hairline />}
            <div className="flex flex-col items-center gap-0.5" data-testid="factory-pill-topics">
              {forYouShown && (
                <TopicTile
                  testId="factory-pill-for-you"
                  color="var(--accent)"
                  count={forYouN}
                  name="For you"
                  selected={sameFocus(focus.focus, FOR_YOU)}
                  onToggle={() => focus.toggle(FOR_YOU)}
                  label={labelHandlers(FOR_YOU_KEY)}
                />
              )}
              {topics.map((topic) => (
                <TopicTile
                  key={topic.id}
                  testId="factory-pill-topic"
                  color={topicColors.get(topic.id) ?? themeColor(topic.id)}
                  count={topic.count}
                  dotOnly
                  recent={topic.lastSeq === newestSeq}
                  name={topic.name}
                  selected={focusedThemeId === topic.id}
                  onToggle={() => focus.toggle({ kind: 'theme', themeId: topic.id })}
                  label={labelHandlers(topicKey(topic.id))}
                />
              ))}
              {moreTopics.length > 0 && (
                <MoreChip
                  count={moreTopics.length}
                  label={`${moreTopics.length} more ${moreTopics.length === 1 ? 'topic' : 'topics'}`}
                  testId="factory-pill-topics-more"
                  onClick={onExpand ? () => onExpand() : undefined}
                />
              )}
            </div>
          </>
        )}
        {/* The way into the space's details: a row the pill grows at its foot when it is pointed
            at. At rest the row has no height (and gives back the gap above it). */}
        {onExpand && (
          <span
            className="flex items-center justify-center"
            style={{
              height: widened || empty ? CORNER_SIZE : 0,
              marginTop: widened || empty ? 0 : -RAIL_GAP_PX,
              opacity: widened ? 1 : 0,
              transform: widened || reduced ? 'none' : 'translateY(-8px) scale(0.6)',
              pointerEvents: widened ? 'auto' : 'none',
              transition: widened
                ? `opacity .2s ease .12s, transform .5s ${GOO_SPRING} .06s`
                : 'opacity .08s ease, transform .12s ease',
            }}
          >
            <PanelToggle open={false} reduced={reduced} onToggle={() => onExpand()} />
          </span>
        )}
      </div>
      {labelNode !== undefined && (
        <div
          ref={labelRef}
          data-testid="factory-pill-label"
          data-open={grown ? 'true' : 'false'}
          aria-hidden
          className="max-w-xs px-3 py-1.5 text-xs text-text-secondary"
          style={{
            position: 'absolute',
            width: 'max-content',
            pointerEvents: 'none',
            right: fl?.box.right ?? 0,
            top: fl?.box.top ?? 0,
            opacity: fl && grown && labelOpen ? 1 : 0,
            transition: `right ${move}, top ${move}, opacity ${
              grown && labelOpen ? '.25s ease .12s' : '.15s ease'
            }`,
          }}
        >
          {labelNode}
        </div>
      )}
      {cardShown && (
        <>
          <div
            ref={cardRef}
            data-testid="factory-pill-card"
            inert={!cardOpen || undefined}
            style={{
              position: 'absolute',
              right: 0,
              width: 'max-content',
              top: cardTop,
              opacity: cardOpen && cardSize ? 1 : 0,
              pointerEvents: cardOpen ? 'auto' : 'none',
              transition: `top ${move}, opacity ${
                cardOpen ? `.25s ease ${swap.delay}` : `${swap.out} ease`
              }`,
            }}
          >
            {cardOpen ? card.content : cardHeld.current}
            {mine && <PanelSessions mine={mine} />}
          </div>
          {cardOpen && card && (
            <div
              style={{
                position: 'absolute',
                zIndex: 2,
                pointerEvents: 'auto',
                right: CORNER_INSET,
                top: cardTop + CORNER_INSET,
              }}
            >
              <PanelToggle open reduced={reduced} onToggle={card.onFold} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function noop(): void {}

const MORE_UNITS_KEY = 'more-units';
/** The goo layer reaches past the pane's edge by the wall and a little more, for the filter's blur. */
const GOO_PAD_PX = WALL_PX + 16;

/** One plain filled shape of the goo layer, on the spring the dock's shapes move on. */
function Shape({ id, box, move }: { id: string; box: Box; move: string }) {
  return (
    <div
      data-shape={id}
      style={{
        position: 'absolute',
        right: box.right + GOO_PAD_PX,
        top: box.top,
        width: box.w,
        height: box.h,
        borderRadius: box.r,
        background: GOO_FILL,
        transition: `right ${move}, top ${move}, width ${move}, height ${move}, border-radius ${move}`,
      }}
    />
  );
}

function Hairline() {
  return <span className="h-px w-4 shrink-0 bg-border-hairline" aria-hidden />;
}

const LINE_TONE = { bad: 'text-danger', warn: 'text-warning' } as const;

/** What comes out to the left of a unit: its name, and where it stands. */
function Label({ name, line, tone }: { name: string; line?: string; tone?: 'bad' | 'warn' }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-medium text-text-primary">{name}</span>
      {line && <span className={tone ? LINE_TONE[tone] : undefined}>{line}</span>}
    </span>
  );
}

/** A small fixed offset from a unit's key. */
function hashPhase(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return (hash % 97) * 7;
}

const UNIT_CLASS = 'flex size-7 items-center justify-center rounded-full transition-colors';

/** One piece of standing work: its dot matrix; its name and status line come out when it is pointed at. */
function StandingUnitTile({
  unit,
  onOpenView,
  label,
}: {
  unit: StandingUnit;
  onOpenView?: (name: string) => void;
  label: LabelHandlers;
}) {
  const view = unit.view;
  // Every loop is an LED grid: moving while it works, shimmering softly while it waits for
  // its next run. Each is offset so no two show the same pattern.
  const matrix = (
    <DotMatrix state={unit.matrix} tone={unit.matrixTone} size="md" phase={hashPhase(unit.key)} />
  );
  const shared = {
    'data-testid': 'factory-pill-unit',
    'data-unit': unit.key,
    'data-state': unit.matrix,
    ...label,
  };
  if (view && onOpenView) {
    return (
      <button
        type="button"
        {...shared}
        aria-label={`${unitLabel(unit)}. Open ${unit.name}.`}
        onClick={() => onOpenView(view)}
        className={cn(UNIT_CLASS, 'hover:bg-bg-3/60', unit.arrived && 'card-pop-in', FOCUS_RING)}
      >
        {matrix}
      </button>
    );
  }
  return (
    <span
      {...shared}
      role="img"
      tabIndex={0}
      aria-label={unitLabel(unit)}
      className={cn(UNIT_CLASS, unit.arrived && 'card-pop-in', FOCUS_RING)}
    >
      {matrix}
    </span>
  );
}

/** A topic (or For you): its dot and its count; its name comes out when it is pointed at. A press filters the transcript to it. */
function TopicTile({
  testId,
  color,
  count,
  dotOnly,
  recent = true,
  name,
  selected,
  onToggle,
  label,
}: {
  testId: string;
  color: string;
  count: number;
  /** A topic: its dot alone. Its name and count come out as the label. */
  dotOnly?: boolean;
  /** The newest message of the conversation is in it: its dot is at full strength. */
  recent?: boolean;
  name: string;
  selected: boolean;
  onToggle: () => void;
  label: LabelHandlers;
}) {
  // A message just went into the topic: a ring goes out from its dot, once.
  const seen = useRef(count);
  const [ping, setPing] = useState(0);
  useEffect(() => {
    if (count > seen.current) setPing((n) => n + 1);
    seen.current = count;
  }, [count]);
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={selected}
      aria-label={
        selected
          ? `${name}, ${count}. Showing only its messages; press to show every message.`
          : `${name}, ${count}. Press to show only its messages.`
      }
      onClick={onToggle}
      {...label}
      className={cn(
        dotOnly
          ? 'flex size-6 items-center justify-center rounded-full'
          : // One column for the dot and one for the count, so both line up down the pill.
            'grid h-6 w-10 grid-cols-[8px_1fr] items-center gap-1.5 rounded-full px-1.5 text-left',
        'transition-[background-color,transform] duration-150 ease-out hover:bg-bg-3/60 active:scale-[0.97]',
        selected && 'bg-bg-3/60 shadow-[0_0_0_1.5px_var(--accent)]',
        FOCUS_RING
      )}
    >
      <span className="relative flex size-2">
        {ping > 0 && (
          <span
            key={ping}
            data-testid="factory-pill-topic-ping"
            className="topic-ping absolute inset-0 rounded-full"
            style={{ background: color }}
            aria-hidden
          />
        )}
        <span
          className={cn(
            'relative size-2 rounded-full transition-opacity duration-300 ease-out',
            !recent && !selected && 'opacity-50'
          )}
          style={{ background: color }}
          aria-hidden
        />
      </span>
      {!dotOnly && (
        <span className="text-2xs leading-none font-medium text-text-secondary tabular-nums">
          {count}
        </span>
      )}
    </button>
  );
}

/** The chevron: at the pill's foot it opens the pinned panel out of the pill; on the panel's corner it folds it back. */
function PanelToggle({
  open,
  reduced,
  onToggle,
}: {
  open: boolean;
  reduced: boolean;
  onToggle: () => void;
}) {
  const label = open ? 'Fold Space details' : 'Open Space details';
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
            <ChevronLeft
              className="size-4"
              strokeWidth={1.5}
              style={{
                transform: `rotate(${open ? 180 : 0}deg)`,
                transition: reduced ? 'none' : `transform .6s ${GOO_SPRING}`,
              }}
            />
          </button>
        }
      />
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}

/** Your own sessions in this space, at the foot of the open panel: the ones going now first. */
function PanelSessions({
  mine,
}: {
  mine: { bindingId: string; onOpen: (sessionId: string) => void };
}) {
  const { all } = useMySessions(mine.bindingId);
  if (all.length === 0) return null;
  const going = all.filter((s) => s.state === 'waiting' || s.state === 'working');
  const rest = all.filter((s) => s.state !== 'waiting' && s.state !== 'working');
  return (
    <div
      className="flex w-[304px] flex-col gap-0.5 border-t border-border-hairline p-2"
      data-testid="factory-pill-sessions"
    >
      <span className="px-2 pt-1 pb-0.5 font-mono text-2xs tracking-wider text-text-muted uppercase">
        Your sessions
      </span>
      <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
        {[...going, ...rest].map((session) => (
          <button
            key={session.id}
            type="button"
            onClick={() => mine.onOpen(session.id)}
            className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 rounded-control px-2 py-1.5 text-left text-xs outline-none hover:bg-bg-2 focus-visible:bg-bg-2"
          >
            <DotMatrix state={MINE_MATRIX[session.state]} size="sm" />
            <span
              className={cn(
                'truncate',
                session.state === 'idle' ? 'text-text-secondary' : 'text-text-primary'
              )}
            >
              {session.title}
            </span>
            <span
              className={cn(
                'text-2xs',
                session.state === 'waiting' ? 'text-warning' : 'text-text-muted'
              )}
            >
              {session.state === 'waiting'
                ? 'Waiting on you'
                : session.state === 'working'
                  ? 'Working'
                  : new Date(session.at).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
            </span>
          </button>
        ))}
      </div>
      <span className="px-2 pt-1 text-2xs leading-snug text-text-muted">
        Only you see these. The Room sees what you post to it.
      </span>
    </div>
  );
}
