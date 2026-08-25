import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Navigator v2 (`docs/file-navigator-design.md` §3.3): "Tooltip ONLY when
 * the visible name is truncated ... never a native title attr repeating
 * what the row already says." A `scrollWidth > clientWidth` check on the
 * label span itself — re-measured on resize, since a row can go from
 * truncated to not (or back) as the panel is resized.
 */
export function useTruncated<T extends HTMLElement>(): { ref: React.RefObject<T | null>; truncated: boolean } {
  const ref = useRef<T | null>(null);
  const [truncated, setTruncated] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setTruncated(el.scrollWidth > el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { ref, truncated };
}
