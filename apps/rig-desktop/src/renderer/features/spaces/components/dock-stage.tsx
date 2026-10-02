import { useReducedMotion } from 'motion/react';
import {
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { cn } from '@renderer/lib/utils';
import {
  CARD_RADIUS,
  columnWidth,
  computeLayout,
  CORNER_INSET,
  floatLayout,
  type Box,
  type ColumnItem,
  type DockLayout,
  type Phase,
  type Size,
} from '../dock-layout';
import { GOO_DRIP, GOO_FILL, GOO_SPRING, useGooFilter } from './dock-glass';

/**
 * The dock's two layers, on one set of measured boxes.
 *
 * Behind: ONE goo layer holding only plain filled shapes (the rail's capsule,
 * each pill, the drop, the peek and its neck) with a spring on their position,
 * size and radius. One SVG filter and one shadow cover the whole layer, so
 * shapes that come within a few pixels of each other melt into one column
 * hanging from the rail (`dock-glass.tsx`).
 *
 * Above: the content layer, with the text, avatars and buttons, each in a
 * wrapper placed on the same box as its shape.
 *
 * The pinned panel opens out of the rail: the rail's own shape morphs to the
 * panel's bounds and radius on the same spring (the column folds away into the
 * bead), the rail's content fades out first and the panel's fades in once the
 * shape is mostly open, and the reverse on fold. The panel's content is the
 * caller's; the stage only measures it and draws the shape behind it.
 *
 * Nothing here knows what a pill says. The stage measures each wrapper
 * (`offsetWidth`, so a spring's scale never skews it), lays the boxes out
 * (`dock-layout.ts`), and draws a shape and a wrapper per box.
 */

/** The goo layer reaches past the dock on every side, for the peek to the left and the shadow around. */
const PAD_LEFT = 400;
const PAD_RIGHT = 48;
const PAD_TOP = 48;
const PAD_BOTTOM = 64;
/** An entry that left stays this long, tucking back into the rail. */
const GHOST_MS = 480;
/** The peek stays this long after it is let go of, fading. */
const FLOAT_LINGER_MS = 340;
/** The panel's morph, as long as the shapes' spring, and where in it the content swaps. */
const CARD_MS = 640;
const SWAP_DELAY = 0.42;

export type StageEntry = {
  id: string;
  /** A focused pill: a card, with a card's corners. */
  card: boolean;
  phase: Phase;
  /**
   * A pill: never wider than the rail (its name gives way), so every pill
   * shares the rail's left edge. A card, or a pill swollen with news, is as
   * wide as it needs and only then reaches further left.
   */
  fit?: boolean;
  /** In its birth: its shape falls without overshoot. */
  birthing?: boolean;
  /** Pulses the entry when it changes. */
  bump?: number;
  content: ReactNode;
  /** Hover and focus handlers for the entry's wrapper. */
  wrapperProps?: Pick<
    HTMLAttributes<HTMLDivElement>,
    'onMouseEnter' | 'onMouseLeave' | 'onFocus' | 'onBlur'
  >;
};

/** The pinned panel the rail opens into. */
export type StageCard = {
  open: boolean;
  /** Mounted while open, and kept a moment after, while the shape folds back. */
  content: ReactNode;
};

/** What hangs to the left of the rail or a pill: a peek, the approvals panel. */
export type StageFloat = {
  /** The rail, or an entry's id. */
  anchor: string;
  content: ReactNode;
  /** It has things to press: it takes the pointer. */
  live?: boolean;
};

type Ghost = { entry: StageEntry; index: number };

function useBump(ref: RefObject<HTMLElement | null>, bump: number | undefined, reduced: boolean) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!bump || reduced) return;
    ref.current?.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.1)' }, { transform: 'scale(1)' }],
      { duration: 420, easing: 'cubic-bezier(.3,1.5,.5,1)' }
    );
  }, [ref, bump, reduced]);
}

const move = (reduced: boolean, easing: string) => (reduced ? '.12s ease' : `.6s ${easing}`);

function Shape({
  id,
  box,
  easing = GOO_SPRING,
  bump,
  reduced,
  pace,
}: {
  id: string;
  box: Box;
  easing?: string;
  bump?: number;
  reduced: boolean;
  /** Overrides the shape's duration: the panel's shape follows its content closely once it is open, and swaps instantly with reduced motion. */
  pace?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useBump(ref, bump, reduced);
  const t = pace ? `${pace} ease-out` : move(reduced, easing);
  return (
    <div
      ref={ref}
      data-shape={id}
      data-edge={Math.round(box.right + box.w)}
      data-width={Math.round(box.w)}
      style={{
        position: 'absolute',
        right: box.right + PAD_RIGHT,
        top: box.top + PAD_TOP,
        width: box.w,
        height: box.h,
        borderRadius: box.r,
        background: GOO_FILL,
        transition: `right ${t}, top ${t}, width ${t}, height ${t}, border-radius ${pace ?? (reduced ? '.12s' : '.6s')} ease`,
      }}
    />
  );
}

function Item({
  id,
  box,
  hidden,
  ghost,
  live = true,
  phase,
  maxWidth,
  easing = GOO_SPRING,
  bump,
  reduced,
  watch,
  wrapperProps,
  fade,
  children,
}: {
  id: string;
  box: Box;
  /** Not showing yet (unmeasured, still the bead, or folded away): invisible. */
  hidden: boolean;
  /** Out of the keyboard's way too: a ghost, or something not there yet. */
  ghost?: boolean;
  /** Takes the pointer. */
  live?: boolean;
  phase?: Phase;
  /** The widest the wrapper may be. */
  maxWidth?: number;
  easing?: string;
  bump?: number;
  reduced: boolean;
  watch: (id: string) => (el: HTMLElement | null) => void;
  wrapperProps?: StageEntry['wrapperProps'];
  /** The content swap between the rail and the panel: how long it takes to leave, and how long to wait before it shows. */
  fade?: { out: string; delay: string };
  children: ReactNode;
}) {
  const local = useRef<HTMLDivElement>(null);
  const measure = watch(id);
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      local.current = el;
      measure(el);
    },
    [measure]
  );
  useBump(local, bump, reduced);
  const t = move(reduced, easing);
  const out = hidden || !!ghost;
  return (
    <div
      ref={ref}
      data-dock-item={id}
      data-edge={Math.round(box.right + box.w)}
      data-width={Math.round(box.w)}
      data-phase={phase}
      inert={ghost || undefined}
      style={{
        position: 'absolute',
        right: box.right,
        top: box.top,
        width: 'max-content',
        maxWidth,
        pointerEvents: out || !live ? 'none' : 'auto',
        opacity: out ? 0 : 1,
        // A drop shows its name once its shape has grown enough to hold it.
        transition: `right ${t}, top ${t}, opacity ${
          fade
            ? out
              ? `${fade.out} ease`
              : `.25s ease ${fade.delay}`
            : out
              ? '.15s ease'
              : `.25s ease ${phase === 'drop' ? '.32s' : '.12s'}`
        }`,
      }}
      {...wrapperProps}
    >
      {children}
    </div>
  );
}

export function DockStage({
  className,
  rail,
  corner,
  card,
  entries: columnEntries,
  float: floatProp,
  floatRef,
  onLayout,
}: {
  className?: string;
  /** The rail's content: its capsule is drawn behind it. */
  rail: ReactNode;
  /** The dock's one toggle, drawn in the rail's top-right corner whether the rail or the panel is showing. */
  corner?: ReactNode;
  /** The pinned panel the rail opens into; absent, the rail only opens nothing. */
  card?: StageCard | null;
  /** The column under the rail, in order. It folds away while the panel is open. */
  entries: readonly StageEntry[];
  float: StageFloat | null;
  /** The element holding the float's content, for a dismissal that counts a click in it as inside. */
  floatRef?: RefObject<HTMLDivElement | null>;
  /** The dock's width (its widest part), and whether a column hangs from the rail. */
  onLayout?: (width: number, hasColumn: boolean) => void;
}) {
  const reduced = useReducedMotion() ?? false;
  const goo = useGooFilter();

  // The panel: its content stays mounted for the fold's length. Worked out
  // while rendering (like the ghosts below) so it never unmounts for a frame.
  const cardOpen = card?.open === true;
  const cardHeld = useRef<ReactNode>(null);
  if (cardOpen) cardHeld.current = card!.content;
  const [prevCardOpen, setPrevCardOpen] = useState(cardOpen);
  const [cardLinger, setCardLinger] = useState(false);
  if (prevCardOpen !== cardOpen) {
    setPrevCardOpen(cardOpen);
    setCardLinger(!cardOpen && !reduced && cardHeld.current !== null);
  }
  useEffect(() => {
    if (!cardLinger) return;
    const timer = setTimeout(() => {
      cardHeld.current = null;
      setCardLinger(false);
    }, CARD_MS);
    return () => clearTimeout(timer);
  }, [cardLinger]);
  if (!cardOpen && !cardLinger) cardHeld.current = null;
  const cardShown = cardOpen || cardLinger;
  // Once open, the shape follows its content's height closely (an accordion opening), not on the long spring.
  const [cardSettled, setCardSettled] = useState(false);
  useEffect(() => {
    if (!cardOpen) {
      setCardSettled(false);
      return;
    }
    const timer = setTimeout(() => setCardSettled(true), CARD_MS);
    return () => clearTimeout(timer);
  }, [cardOpen]);
  // The column folds into the bead while the panel is open, and comes back after.
  const entries = cardShown ? NO_ENTRIES : columnEntries;
  const floatNow = cardShown ? null : floatProp;
  const float = floatNow;

  // Measuring: every wrapper's size, read after each render and when one resizes.
  const [sizes, setSizes] = useState<Record<string, Size>>({});
  const nodes = useRef(new Map<string, HTMLElement>());
  const measure = useCallback(() => {
    setSizes((previous) => {
      let next = previous;
      for (const [id, el] of nodes.current) {
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        const was = previous[id];
        if (!was || Math.abs(was.w - w) >= 1 || Math.abs(was.h - h) >= 1) {
          if (next === previous) next = { ...previous };
          next[id] = { w, h };
        }
      }
      return next;
    });
  }, []);
  useLayoutEffect(measure);
  const observer = useRef<ResizeObserver | null>(null);
  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => measure());
    observer.current = ro;
    for (const el of nodes.current.values()) ro.observe(el);
    return () => {
      ro.disconnect();
      observer.current = null;
    };
  }, [measure]);
  const watchers = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const watch = useCallback((id: string) => {
    let fn = watchers.current.get(id);
    if (!fn) {
      fn = (el) => {
        const old = nodes.current.get(id);
        if (old && old !== el) observer.current?.unobserve(old);
        if (el) {
          nodes.current.set(id, el);
          observer.current?.observe(el);
        } else nodes.current.delete(id);
      };
      watchers.current.set(id, fn);
    }
    return fn;
  }, []);

  // Entries that leave stay a moment, tucking back into the rail. Worked out
  // while rendering so the element never leaves the DOM before it is a ghost.
  const idKey = entries.map((e) => e.id).join('\n');
  const [known, setKnown] = useState<{ key: string; entries: readonly StageEntry[] }>({
    key: idKey,
    entries,
  });
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  if (known.key !== idKey) {
    setKnown({ key: idKey, entries });
    const gone = known.entries
      .map((entry, index): Ghost => ({ entry, index }))
      .filter(({ entry }) => !entries.some((e) => e.id === entry.id));
    if (gone.length > 0) {
      setGhosts((current) => [
        ...current.filter((g) => !gone.some((x) => x.entry.id === g.entry.id)),
        ...gone,
      ]);
    }
  }
  useEffect(() => {
    if (ghosts.length === 0) return;
    const timer = setTimeout(() => setGhosts([]), GHOST_MS);
    return () => clearTimeout(timer);
  }, [ghosts]);
  const rows: Array<{ entry: StageEntry; ghost: boolean }> = entries.map((entry) => ({
    entry,
    ghost: false,
  }));
  for (const g of [...ghosts].sort((a, b) => a.index - b.index)) {
    if (entries.some((e) => e.id === g.entry.id)) continue;
    rows.splice(Math.min(g.index, rows.length), 0, { entry: g.entry, ghost: true });
  }

  // The float: one shape that grows out of a neck on what it hangs from, moves
  // between pills, and folds back. Its content stays a moment after it is let go of.
  const open = float !== null;
  const heldRef = useRef<StageFloat | null>(null);
  if (float) heldRef.current = float;
  const [linger, setLinger] = useState(false);
  useEffect(() => {
    if (open) {
      setLinger(false);
      return;
    }
    if (heldRef.current === null) return;
    if (reduced) {
      heldRef.current = null;
      return;
    }
    setLinger(true);
    const timer = setTimeout(() => {
      heldRef.current = null;
      setLinger(false);
    }, FLOAT_LINGER_MS);
    return () => clearTimeout(timer);
  }, [open, reduced]);
  const shownFloat = float ?? (linger ? heldRef.current : null);
  const floatMeasured = shownFloat !== null && sizes.float !== undefined;
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    if (!open) {
      setGrown(false);
      return;
    }
    if (!floatMeasured) return;
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
  }, [open, floatMeasured, reduced]);

  // Layout.
  const railSize = sizes.rail;
  const column: ColumnItem[] = rows.map(({ entry, ghost }) => ({
    id: entry.id,
    size: ghost ? undefined : sizes[entry.id],
    card: entry.card,
    phase: entry.phase,
  }));
  // A ghost takes no room: only the live entries are laid out, and it goes to the bead.
  const live = column.filter((_, i) => !rows[i]!.ghost);
  const layout: DockLayout | null = railSize ? computeLayout(railSize, live) : null;
  const hasColumn = entries.length > 0;
  const width = layout?.width ?? 0;
  const cardSize = cardShown ? sizes.card : undefined;
  const cardBox: Box | null =
    cardOpen && cardSize
      ? { right: 0, top: 0, w: cardSize.w, h: cardSize.h, r: CARD_RADIUS }
      : null;
  const measured = layout !== null;
  useLayoutEffect(() => {
    if (measured) onLayout?.(width, hasColumn);
  }, [onLayout, measured, width, hasColumn]);

  const anchorBox = (() => {
    if (!layout || !shownFloat) return null;
    if (shownFloat.anchor === 'rail') return layout.rail;
    return layout.items[shownFloat.anchor] ?? null;
  })();
  const floatSize = sizes.float;
  const fl =
    anchorBox && floatSize
      ? floatLayout(anchorBox, floatSize, shownFloat?.anchor === 'rail')
      : null;
  const neckCx = fl ? fl.neck.right + fl.neck.w / 2 : 0;
  const neckCy = fl ? fl.neck.top + fl.neck.h / 2 : 0;
  const floatBox: Box | null = fl
    ? grown
      ? fl.box
      : { right: neckCx, top: neckCy, w: 0, h: 0, r: 0 }
    : null;
  const neckBox: Box | null = fl
    ? grown
      ? fl.neck
      : { right: neckCx, top: neckCy, w: 0, h: 0, r: 0 }
    : null;

  const height = Math.max(
    layout?.height ?? 0,
    fl ? fl.box.top + fl.box.h : 0,
    cardSize ? cardSize.h : 0
  );
  const gooHeight = height + PAD_TOP + PAD_BOTTOM;
  const dockWidth = Math.max(width, cardSize ? cardSize.w : 0);
  const swap = reduced ? { out: '0s', delay: '0s' } : { out: '.12s', delay: `${SWAP_DELAY}s` };
  // The rail's content leaves quickly as the panel opens, and comes back once the shape has closed most of the way.
  const railFade = cardShown
    ? { out: reduced ? '0s' : '.1s', delay: cardOpen ? '0s' : swap.delay }
    : undefined;
  const instant = reduced ? '0s' : undefined;

  return (
    <div
      data-testid="theme-dock"
      className={cn('z-20', className)}
      style={{
        pointerEvents: 'none',
        ...(layout
          ? { width: dockWidth, height: Math.max(layout.height, cardSize ? cardSize.h : 0) }
          : null),
      }}
    >
      {goo.defs}
      {/* Behind: one layer of plain shapes, one filter, one shadow. */}
      <div
        data-testid="dock-goo"
        aria-hidden
        style={{
          position: 'absolute',
          left: -PAD_LEFT,
          top: -PAD_TOP,
          width: dockWidth + PAD_LEFT + PAD_RIGHT,
          height: gooHeight,
          pointerEvents: 'none',
          filter: `url(#${goo.id}) var(--dock-shadow)`,
        }}
      >
        {layout && (
          <>
            <Shape
              id="rail"
              box={cardBox ?? layout.rail}
              reduced={reduced}
              pace={instant ?? (cardOpen && cardSettled ? '.2s' : undefined)}
            />
            {rows.map(({ entry, ghost }) => {
              const box = ghost || !layout.items[entry.id] ? layout.bead : layout.items[entry.id]!;
              return (
                <Shape
                  key={entry.id}
                  id={entry.id}
                  box={box}
                  easing={entry.birthing ? GOO_DRIP : GOO_SPRING}
                  bump={entry.bump}
                  reduced={reduced}
                />
              );
            })}
            {floatBox && neckBox && (
              <>
                <Shape id="float" box={floatBox} reduced={reduced} />
                <Shape id="float-neck" box={neckBox} reduced={reduced} />
              </>
            )}
          </>
        )}
      </div>
      {/* Above: the text, avatars and buttons, on the same boxes. */}
      <div
        data-testid="dock-content"
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      >
        <Item
          id="rail"
          box={layout?.rail ?? { right: 0, top: 0, w: 0, h: 0, r: 0 }}
          hidden={!layout || cardOpen}
          ghost={cardOpen}
          fade={railFade}
          reduced={reduced}
          watch={watch}
        >
          {rail}
        </Item>
        {corner && (
          <div
            data-testid="dock-corner"
            style={{
              position: 'absolute',
              right: CORNER_INSET,
              top: CORNER_INSET,
              zIndex: 2,
              opacity: layout ? 1 : 0,
              pointerEvents: layout ? 'auto' : 'none',
            }}
          >
            {corner}
          </div>
        )}
        {rows.length > 0 && (
          <div
            data-testid="dock-pills"
            style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
          >
            {rows.map(({ entry, ghost }) => {
              const placed = layout?.items[entry.id];
              const measured = sizes[entry.id] !== undefined;
              return (
                <Item
                  key={entry.id}
                  id={entry.id}
                  box={ghost || !layout || !placed ? (layout?.bead ?? ZERO) : placed}
                  hidden={!layout || !measured || entry.phase === 'bead'}
                  ghost={ghost || entry.phase === 'bead'}
                  phase={ghost ? undefined : entry.phase}
                  maxWidth={entry.fit && railSize ? columnWidth(railSize.w) : undefined}
                  easing={entry.birthing ? GOO_DRIP : GOO_SPRING}
                  bump={entry.bump}
                  reduced={reduced}
                  watch={watch}
                  wrapperProps={entry.wrapperProps}
                >
                  {entry.content}
                </Item>
              );
            })}
          </div>
        )}
        {cardShown && (
          <div
            data-testid="dock-card"
            data-open={cardOpen ? 'true' : 'false'}
            style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
          >
            <Item
              id="card"
              box={cardBox ?? ZERO}
              hidden={!cardOpen || !cardSize}
              ghost={!cardOpen}
              fade={swap}
              reduced={reduced}
              watch={watch}
            >
              {cardOpen ? card!.content : cardHeld.current}
            </Item>
          </div>
        )}
        {shownFloat && (
          <div
            ref={floatRef}
            data-testid="dock-float"
            data-open={grown ? 'true' : 'false'}
            style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
          >
            <Item
              id="float"
              box={fl?.box ?? ZERO}
              hidden={!fl || !grown}
              ghost={!open}
              live={open && !!shownFloat.live}
              reduced={reduced}
              watch={watch}
            >
              {shownFloat.content}
            </Item>
          </div>
        )}
      </div>
    </div>
  );
}

const ZERO: Box = { right: 0, top: 0, w: 0, h: 0, r: 0 };
const NO_ENTRIES: readonly StageEntry[] = [];
