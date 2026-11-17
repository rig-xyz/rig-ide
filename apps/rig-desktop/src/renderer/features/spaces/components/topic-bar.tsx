import { useReducedMotion } from 'motion/react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { cn } from '@renderer/lib/utils';
import {
  distinctThemeColors,
  forYouCount,
  forYouLine,
  sameFocus,
  splitThemes,
  themeColor,
  type DockFocus,
} from '../dock-model';
import { EMPTY_FOR_YOU } from '../for-you';
import type { RoomSnapshot } from '../types';
import type { DockFocusState } from '../use-dock-focus';
import type { ForYouState } from '../use-for-you';
import { GOO_FILL, GOO_SPRING, useGooFilter } from './dock-glass';

/**
 * The conversation's topics as a row of pills right above the composer (spike, Rig Alpha): a dot
 * in the topic's colour, its title cut short, and how many messages it holds.
 *
 * Pointed at, a pill grows upward into a small card on the dock's goo: the whole title and what
 * the topic is about; meanwhile the transcript dims everything the topic does not hold. Moving along the row, the one card slides from pill to pill. A press shows only
 * that topic's messages; the pressed pill takes a tonal fill of its own colour.
 */
const FOR_YOU: DockFocus = { kind: 'for-you' };
const FOR_YOU_KEY = 'for-you';

const PILL_H = 28;
const CARD_W = 304;
const CARD_RADIUS = 16;
/** The goo layer reaches this far past the row, for the filter's blur and the shadow. */
const PAD = 28;
/** The pointer rests on a pill this long before its card opens; along the row it follows at once. */
const OPEN_MS = 110;
/** The card's content stays this long while its shape goes back into the pill. */
const CLOSE_MS = 300;

/** The pill the card is on: where it is in the row, by the row's left edge. */
type At = { key: string; left: number; w: number };

type Card = {
  key: string;
  color: string;
  name: string;
  count: number;
  about: string;
  selected: boolean;
  ids: ReadonlySet<string> | null;
};

export function TopicBar({
  snapshot,
  focus,
  forYouState,
  onPreviewChange,
  className,
}: {
  snapshot: RoomSnapshot;
  focus: DockFocusState;
  forYouState: ForYouState | null;
  /** The messages the pointed-at topic holds, for the transcript to dim the rest; null when none is. */
  onPreviewChange?: (ids: ReadonlySet<string> | null) => void;
  className?: string;
}) {
  const reduced = useReducedMotion() ?? false;
  const goo = useGooFilter();
  const themes = snapshot.themes ?? null;
  const focusedThemeId = focus.focus?.kind === 'theme' ? focus.focus.themeId : null;
  const { shown, rest } = useMemo(
    () => splitThemes(themes?.list ?? [], snapshot.messages, focusedThemeId),
    [themes, snapshot.messages, focusedThemeId]
  );
  const colors = useMemo(() => distinctThemeColors(themes?.list ?? []), [themes]);
  const forYou = forYouState?.forYou ?? EMPTY_FOR_YOU;
  const forYouN = forYouCount(forYou);
  const forYouOn = sameFocus(focus.focus, FOR_YOU);
  const forYouShown = forYouN > 0 || forYouOn;

  // The card: `at` is the pill it is open on, `held` what is still drawn while it closes.
  const wrapRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<At | null>(null);
  const [held, setHeld] = useState<At | null>(null);
  const [grown, setGrown] = useState(false);
  const [contentH, setContentH] = useState(0);
  const [wrapW, setWrapW] = useState(0);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showing = useRef(false);
  showing.current = held !== null;

  const point = useCallback((key: string, el: HTMLElement) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const wrapBox = wrap.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const next = { key, left: box.left - wrapBox.left, w: box.width };
    if (openTimer.current) clearTimeout(openTimer.current);
    if (showing.current) setAt(next);
    else openTimer.current = setTimeout(() => setAt(next), OPEN_MS);
  }, []);
  const leave = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    setAt(null);
  }, []);
  useEffect(() => () => void (openTimer.current && clearTimeout(openTimer.current)), []);

  useEffect(() => {
    if (at) {
      setHeld(at);
      if (reduced) {
        setGrown(true);
        return;
      }
      // Two frames: the shape is drawn on the pill first, then grows out of it.
      let second = 0;
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setGrown(true));
      });
      return () => {
        cancelAnimationFrame(first);
        cancelAnimationFrame(second);
      };
    }
    setGrown(false);
    const timer = setTimeout(() => setHeld(null), reduced ? 0 : CLOSE_MS);
    return () => clearTimeout(timer);
  }, [at, reduced]);

  useLayoutEffect(() => {
    const h = contentRef.current?.offsetHeight ?? 0;
    const w = wrapRef.current?.offsetWidth ?? 0;
    if (h !== contentH) setContentH(h);
    if (w !== wrapW) setWrapW(w);
  });

  // What the card says, for the pill it is on.
  const themeOf = themes?.themeOf;
  const heldKey = held?.key ?? null;
  const card = useMemo<Card | null>(() => {
    if (heldKey === null) return null;
    if (heldKey === FOR_YOU_KEY) {
      return {
        key: heldKey,
        color: 'var(--accent)',
        name: 'For you',
        count: forYouN,
        about: forYouLine(forYou),
        selected: forYouOn,
        ids: forYou.messageIds,
      };
    }
    const topic = shown.find((t) => t.id === heldKey);
    if (!topic) return null;
    const ids = new Set<string>();
    for (const [messageId, assignment] of Object.entries(themeOf ?? {})) {
      if (assignment.themeId === topic.id) ids.add(messageId);
    }
    return {
      key: heldKey,
      color: colors.get(topic.id) ?? themeColor(topic.id),
      name: topic.name,
      count: topic.count,
      about: topic.description,
      selected: focusedThemeId === topic.id,
      ids,
    };
  }, [heldKey, forYouN, forYou, forYouOn, shown, themeOf, snapshot, colors, focusedThemeId]);

  // The transcript dims what the pointed-at topic does not hold, unless it is already filtered.
  const previewRef = useRef(onPreviewChange);
  previewRef.current = onPreviewChange;
  const previewIds = at && card && card.key === at.key && focus.focus === null ? card.ids : null;
  useEffect(() => {
    previewRef.current?.(previewIds);
  }, [previewIds]);
  useEffect(() => () => previewRef.current?.(null), []);

  if (!forYouShown && shown.length === 0) return null;

  // The card stands on its pill and grows upward; it stays inside the row's width.
  const cardW = Math.min(Math.max(CARD_W, held?.w ?? 0), wrapW || CARD_W);
  const cardLeft = held ? Math.max(0, Math.min(held.left, (wrapW || cardW) - cardW)) : 0;
  const open = grown && at !== null && contentH > 0;
  const shape = held
    ? open
      ? { left: cardLeft, w: cardW, h: contentH, r: CARD_RADIUS }
      : { left: held.left, w: held.w, h: PILL_H, r: PILL_H / 2 }
    : null;
  const move = reduced ? '.12s ease' : `.5s ${GOO_SPRING}`;

  return (
    <div ref={wrapRef} className={cn('relative', className)} onMouseLeave={leave}>
      <div
        data-testid="topic-bar"
        role="group"
        aria-label="Topics"
        onScroll={leave}
        // One line that scrolls sideways when there are many; no scrollbar to look at, and the
        // row fades out at its right end so a pill that runs past it does not look cut off.
        className={cn(
          'flex items-center gap-1.5 overflow-x-auto pr-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          '[mask-image:linear-gradient(to_right,black_calc(100%-28px),transparent)]'
        )}
      >
        {forYouShown && (
          <TopicPill
            testId="topic-pill-for-you"
            color="var(--accent)"
            name="For you"
            count={forYouN}
            selected={forYouOn}
            onToggle={() => focus.toggle(FOR_YOU)}
            onPoint={(el) => point(FOR_YOU_KEY, el)}
          />
        )}
        {shown.map((topic) => (
          <TopicPill
            key={topic.id}
            testId="topic-pill"
            color={colors.get(topic.id) ?? themeColor(topic.id)}
            name={topic.name}
            count={topic.count}
            selected={focusedThemeId === topic.id}
            onToggle={() => focus.toggle({ kind: 'theme', themeId: topic.id })}
            onPoint={(el) => point(topic.id, el)}
          />
        ))}
        {rest.length > 0 && (
          <span
            className="shrink-0 px-1.5 text-2xs text-text-muted tabular-nums"
            title={rest.map((topic) => topic.name).join(', ')}
          >
            +{rest.length}
          </span>
        )}
      </div>

      {goo.defs}
      {/* The card's shape: one filled shape on the dock's goo, which starts as the pill's own
          outline and springs out to the card's. Nothing here takes the pointer. */}
      <div
        aria-hidden
        data-testid="topic-card-goo"
        className="z-30"
        style={{
          position: 'absolute',
          left: -PAD,
          right: -PAD,
          bottom: -PAD,
          height: contentH + PILL_H + 2 * PAD,
          pointerEvents: 'none',
          filter: `url(#${goo.id}) var(--dock-shadow)`,
        }}
      >
        {shape && (
          <div
            style={{
              position: 'absolute',
              left: shape.left + PAD,
              bottom: PAD,
              width: shape.w,
              height: shape.h,
              borderRadius: shape.r,
              background: GOO_FILL,
              opacity: at ? 1 : 0,
              transition: `left ${move}, width ${move}, height ${move}, border-radius ${move}, opacity ${
                at ? '.08s ease' : '.16s ease .12s'
              }`,
            }}
          />
        )}
      </div>
      {card && (
        <div
          ref={contentRef}
          data-testid="topic-card"
          data-open={open ? 'true' : 'false'}
          aria-hidden
          className="z-30 flex flex-col text-xs"
          style={
            {
              '--topic': card.color,
              position: 'absolute',
              left: cardLeft,
              bottom: 0,
              width: cardW,
              pointerEvents: 'none',
              opacity: open ? 1 : 0,
              transition: `left ${move}, opacity ${open ? '.2s ease .1s' : '.08s ease'}`,
            } as CSSProperties
          }
        >
          {/* Keyed by the pill, so the words come in afresh as the card slides along the row. */}
          {card.about && (
            <p
              key={card.key}
              className="topic-card-in px-3.5 pt-3 pb-1.5 leading-snug text-text-prose"
            >
              {card.about}
            </p>
          )}
          {/* The pill itself, where it was, now with its whole title. */}
          <div className="flex shrink-0 items-center gap-1.5 px-[11px]" style={{ height: PILL_H }}>
            <span aria-hidden className="size-1.5 shrink-0 scale-125 rounded-full bg-[var(--topic)]" />
            <span className="min-w-0 truncate font-medium text-text-primary">{card.name}</span>
            <span className="ml-auto shrink-0 text-2xs text-text-muted tabular-nums">
              {card.count}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function TopicPill({
  testId,
  color,
  name,
  count,
  selected,
  onToggle,
  onPoint,
}: {
  testId: string;
  color: string;
  name: string;
  count: number;
  selected: boolean;
  onToggle: () => void;
  onPoint: (el: HTMLElement) => void;
}) {
  // A message went into this topic: its count ticks over and a ring goes out from its dot, once.
  const [tick, setTick] = useState(0);
  const seen = useRef(count);
  useEffect(() => {
    if (seen.current === count) return;
    const more = count > seen.current;
    seen.current = count;
    if (more) setTick((n) => n + 1);
  }, [count]);

  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={selected}
      aria-label={`${name}, ${count} ${count === 1 ? 'message' : 'messages'}`}
      onClick={onToggle}
      onMouseEnter={(event) => onPoint(event.currentTarget)}
      onFocus={(event) => onPoint(event.currentTarget)}
      // (Height inline: the card's shape starts from exactly this box.)
      style={{ '--topic': color, height: PILL_H } as CSSProperties}
      className={cn(
        'group/topic flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs outline-none',
        // Tonal: the pill's fill and outline are tints of its own topic colour.
        'transition-[background-color,border-color,color,transform] duration-150 ease-out active:scale-[0.96]',
        'focus-visible:ring-2 focus-visible:ring-accent/60',
        selected
          ? 'border-[color-mix(in_oklab,var(--topic)_55%,transparent)] bg-[color-mix(in_oklab,var(--topic)_18%,transparent)] text-text-primary'
          : 'border-border-hairline text-text-secondary hover:border-[color-mix(in_oklab,var(--topic)_35%,transparent)] hover:text-text-primary'
      )}
    >
      <span className="relative flex size-1.5 shrink-0">
        {tick > 0 && (
          <span
            key={tick}
            aria-hidden
            className="topic-ping absolute inset-0 rounded-full bg-[var(--topic)]"
          />
        )}
        <span
          aria-hidden
          className={cn(
            'size-1.5 rounded-full bg-[var(--topic)] transition-[transform,box-shadow] duration-200 ease-out group-hover/topic:scale-125',
            selected && 'shadow-[0_0_0_3px_color-mix(in_oklab,var(--topic)_28%,transparent)]'
          )}
        />
      </span>
      <span className="max-w-[9rem] truncate">{name}</span>
      <span
        key={tick}
        className={cn('shrink-0 text-2xs text-text-muted tabular-nums', tick > 0 && 'count-tick')}
      >
        {count}
      </span>
    </button>
  );
}
