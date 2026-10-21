import { useContext, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { Face } from './bits';
import { LandingsContext, useHome } from './home-context';
import { PEOPLE } from './mock';
import type { Flight } from './store';

/**
 * Moving work into the rail: acting on a Feed item flies a copy of it into
 * its new rail entry, which waits invisible until the copy lands, then
 * pulses and starts animating. One arc: up a little, across, down onto the
 * entry, shrinking from the item's size to the entry's.
 */
export function FlyLayer() {
  const { state } = useHome();
  return createPortal(
    <>
      {state.flights.map((flight) => (
        <Flyer key={flight.id} flight={flight} />
      ))}
    </>,
    document.body
  );
}

function Flyer({ flight }: { flight: Flight }) {
  const { dispatch } = useHome();
  const landings = useContext(LandingsContext);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const finish = () => {
      dispatch({ type: 'flight-done', id: flight.id });
      landings.get(flight.id)?.();
      landings.delete(flight.id);
    };
    const target = document.querySelector<HTMLElement>(
      `[data-rail-id="${CSS.escape(flight.targetId)}"]`
    );
    if (!el || !target) {
      finish();
      return;
    }
    target.scrollIntoView({ block: 'nearest' });
    const a = flight.from;
    const b = target.getBoundingClientRect();
    const dx = b.left - a.left;
    const dy = b.top - a.top;
    const anim = el.animate(
      [
        { transform: 'translate(0, 0)', width: `${a.width}px`, height: `${a.height}px` },
        {
          transform: `translate(${dx * 0.4}px, ${dy * 0.4 - 50}px) scale(.96)`,
          width: `${Math.max(b.width, 220)}px`,
          height: '44px',
          offset: 0.45,
        },
        {
          transform: `translate(${dx}px, ${dy}px)`,
          width: `${b.width}px`,
          height: `${b.height}px`,
          opacity: 0.9,
        },
      ],
      { duration: 900, easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'forwards' }
    );
    anim.onfinish = finish;
    return () => {
      anim.onfinish = null;
      anim.cancel();
    };
    // One flight, one run.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const label = flight.label;
  return (
    <div
      ref={ref}
      aria-hidden
      style={{
        left: flight.from.left,
        top: flight.from.top,
        width: flight.from.width,
        height: flight.from.height,
      }}
      className="pointer-events-none fixed z-[60] overflow-hidden rounded-[12px] border border-accent bg-bg-1 shadow-modal"
    >
      <div className="flex items-center gap-2 px-3 py-2.5 text-sm font-semibold whitespace-nowrap">
        {label.kind === 'session' ? (
          <>
            <DotMatrix
              state={label.queued ? 'queued' : 'starting'}
              tone={label.queued ? 'mute' : 'accent'}
              size="sm"
            />
            {label.name}
          </>
        ) : (
          <>
            # {label.name}
            {label.people.slice(0, 2).map((id) => {
              const p = PEOPLE[id];
              return p ? <Face key={id} person={p} /> : null;
            })}
          </>
        )}
      </div>
    </div>
  );
}
