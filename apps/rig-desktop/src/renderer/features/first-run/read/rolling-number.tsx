import { useEffect, useRef, useState } from 'react';
import { cn } from '@renderer/lib/utils';

/**
 * A number whose changed digits roll, like SwiftUI's
 * `.contentTransition(.numericText())`: the old digit slides out and blurs
 * away while the new one slides in, upward when it grows and downward when
 * it shrinks. Digits that stay the same hold still. Reduced motion just
 * swaps them (`read.css`).
 */
export function RollingNumber({ value, className }: { value: number; className?: string }) {
  const prev = useRef(value);
  const [roll, setRoll] = useState<{ from: number; key: number } | null>(null);
  useEffect(() => {
    if (value === prev.current) return;
    setRoll({ from: prev.current, key: Date.now() });
    prev.current = value;
    const timer = setTimeout(() => setRoll(null), 450);
    return () => clearTimeout(timer);
  }, [value]);

  const to = String(value);
  const from = roll ? String(roll.from) : null;
  const up = roll ? value > roll.from : true;
  // Line the old digits up with the new ones from the right, as numbers line up.
  const width = Math.max(to.length, from?.length ?? 0);
  const newDigits = to.padStart(width, ' ');
  const oldDigits = from?.padStart(width, ' ') ?? null;

  return (
    <b className={cn('rig-num', className)} aria-label={to} role="img">
      {newDigits.split('').map((d, i) => {
        const old = oldDigits?.[i];
        const changed = roll !== null && old !== d;
        if (d === ' ' && (!changed || old === ' ')) return null;
        return (
          <span key={i} className="rig-num-cell" aria-hidden>
            {changed && old && old !== ' ' && (
              <span key={`o${roll!.key}`} className={up ? 'rig-num-out-up' : 'rig-num-out-down'}>
                {old}
              </span>
            )}
            {d !== ' ' && (
              <span
                key={changed ? `n${roll!.key}` : 'n'}
                className={changed ? (up ? 'rig-num-in-up' : 'rig-num-in-down') : undefined}
              >
                {d}
              </span>
            )}
          </span>
        );
      })}
    </b>
  );
}
