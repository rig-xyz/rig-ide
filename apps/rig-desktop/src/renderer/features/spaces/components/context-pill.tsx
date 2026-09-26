import { X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { cn } from '@renderer/lib/utils';

/**
 * What the composer understood about the message you're writing (which
 * agent it goes to, what it replies to, what it's about), as a glass pill
 * above the input. Hovering it lets two round buttons ooze out of its edge:
 * "?" stretches into the reason, "×" drops it. The pill body and both
 * bubbles are one liquid layer (an SVG goo filter over a single fill), so
 * at rest the bubbles sit inside the pill's own fill and nothing shows;
 * the blur and the edge are separate layers, and the text sits above it
 * all, crisp. Hover is forgiving: open at once, close after a short grace,
 * with an invisible bridge over the gap to the buttons.
 */

const FILL = 'var(--pill-fill)';
const SPRING = 'cubic-bezier(.34,1.56,.64,1)';
const CLOSE_GRACE_MS = 280;

export function ContextPill({
  children,
  reason,
  pending = false,
  onDismiss,
  dismissLabel = 'Dismiss',
  clear = false,
  testId,
}: {
  children: ReactNode;
  /** Why the composer thinks this; shown when "?" is hovered. */
  reason?: string;
  /** A guess, not yet confirmed (Tab): dashed edge. */
  pending?: boolean;
  onDismiss?: () => void;
  dismissLabel?: string;
  /** Clearer glass (less fill, more blur), for a pill floating over a document. */
  clear?: boolean;
  testId?: string;
}) {
  const filterId = `pill-goo-${useId().replace(/:/g, '')}`;
  const [out, setOut] = useState(false);
  const [why, setWhy] = useState(false);
  const leaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const whyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (leaveRef.current) clearTimeout(leaveRef.current);
      if (whyRef.current) clearTimeout(whyRef.current);
    },
    []
  );

  const hasButtons = !!reason || !!onDismiss;
  const enter = () => {
    if (leaveRef.current) clearTimeout(leaveRef.current);
    if (hasButtons) setOut(true);
  };
  const leave = () => {
    if (leaveRef.current) clearTimeout(leaveRef.current);
    leaveRef.current = setTimeout(() => {
      setOut(false);
      setWhy(false);
    }, CLOSE_GRACE_MS);
  };
  const showWhy = (open: boolean) => {
    if (whyRef.current) clearTimeout(whyRef.current);
    whyRef.current = setTimeout(() => setWhy(open), open ? 90 : 240);
  };

  const whyWidth = why && reason ? Math.min(320, 28 + reason.length * 6.4) : 26;
  const whyX = out ? 38 : 0;
  const xX = out ? (reason ? 38 + whyWidth + 6 : 38) : 0;

  return (
    <div
      className="context-pill relative inline-flex h-[30px] max-w-full items-center"
      onMouseEnter={enter}
      onMouseLeave={leave}
      onFocus={enter}
      onBlur={leave}
      data-testid={testId}
      data-pending={pending || undefined}
    >
      <svg width="0" height="0" className="absolute" aria-hidden>
        <defs>
          <filter id={filterId} x="-20%" y="-150%" width="320%" height="400%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
            <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7" result="goo" />
            <feBlend in="SourceGraphic" in2="goo" />
          </filter>
        </defs>
      </svg>
      {/* glass: blur of what's behind, then one liquid fill, then a thin edge */}
      <span
        className={cn('shadow-float absolute inset-0 rounded-full', clear ? 'backdrop-blur-xl backdrop-saturate-150' : 'backdrop-blur-md')}
        aria-hidden
      />
      {/* the fill's own opacity, after the goo filter: the filter makes it opaque, this lets the page show through */}
      <span
        className="pointer-events-none absolute inset-0"
        style={{ filter: `url(#${filterId})`, opacity: clear ? 0.55 : 0.9 }}
        aria-hidden
      >
        <span className="absolute inset-0 rounded-full" style={{ background: FILL }} />
        {reason && (
          <span
            className="absolute top-[2px] h-[26px] rounded-full motion-reduce:transition-none"
            style={{
              left: 'calc(100% - 30px)',
              width: whyWidth,
              background: FILL,
              transform: `translateX(${whyX}px)`,
              transition: `transform 550ms ${SPRING}, width 500ms cubic-bezier(.34,1.3,.64,1)`,
            }}
          />
        )}
        {onDismiss && (
          <span
            className="absolute top-[2px] size-[26px] rounded-full motion-reduce:transition-none"
            style={{
              left: 'calc(100% - 30px)',
              background: FILL,
              transform: `translateX(${xX}px)`,
              transition: `transform 550ms ${SPRING} 40ms`,
            }}
          />
        )}
      </span>
      <span
        className={cn(
          'pointer-events-none absolute inset-0 rounded-full border shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]',
          pending ? 'border-dashed border-border-strong' : 'border-border-hairline'
        )}
        aria-hidden
      />
      {/* an invisible bridge over the gap, so crossing to the buttons never counts as leaving */}
      {out && <span className="absolute top-[-6px] left-full h-[42px]" style={{ width: xX + 8 }} aria-hidden />}

      <span className="relative z-10 flex min-w-0 items-center gap-1.5 pr-3 pl-2.5 text-xs whitespace-nowrap text-text-secondary">
        {children}
        {pending && (
          <kbd className="border-border-strong ml-0.5 rounded border px-1 font-mono text-2xs leading-4 text-text-muted">Tab</kbd>
        )}
      </span>

      {reason && (
        <button
          type="button"
          aria-label={`Why: ${reason}`}
          onMouseEnter={() => showWhy(true)}
          onMouseLeave={() => showWhy(false)}
          onFocus={() => showWhy(true)}
          onBlur={() => showWhy(false)}
          tabIndex={out ? 0 : -1}
          className={cn(
            'absolute top-[2px] z-10 flex h-[26px] items-center justify-center overflow-hidden rounded-full text-xs whitespace-nowrap text-text-secondary transition-opacity duration-200 hover:text-text-primary motion-reduce:transition-none',
            out ? 'pointer-events-auto opacity-100 delay-100' : 'pointer-events-none opacity-0'
          )}
          style={{
            left: `calc(100% + ${whyX - 30}px)`,
            width: whyWidth,
            padding: why ? '0 12px' : 0,
            transition: `opacity 200ms, left 550ms ${SPRING}, width 500ms cubic-bezier(.34,1.3,.64,1)`,
          }}
          data-testid="context-pill-why"
        >
          {why ? reason : '?'}
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          aria-label={dismissLabel}
          title={dismissLabel}
          onClick={onDismiss}
          tabIndex={out ? 0 : -1}
          className={cn(
            'absolute top-[2px] z-10 flex size-[26px] items-center justify-center rounded-full text-text-secondary hover:text-text-primary motion-reduce:transition-none',
            out ? 'pointer-events-auto opacity-100 delay-100' : 'pointer-events-none opacity-0'
          )}
          style={{ left: `calc(100% + ${xX - 30}px)`, transition: `opacity 200ms, left 550ms ${SPRING} 40ms` }}
          data-testid="context-pill-dismiss"
        >
          <X className="size-3" strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
