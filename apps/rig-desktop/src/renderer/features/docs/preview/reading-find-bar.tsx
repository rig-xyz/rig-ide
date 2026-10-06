import { useCallback, useEffect, useRef, useState } from 'react';
import {
  clearFindMatches,
  findCountLabel,
  matchRangesIn,
  paintFindMatches,
  revealRange,
} from './reading-find';

/** What the reading view's find is looking for; `focusNonce` bumps on each Cmd-F to focus and select the field. */
export type ReadingFind = { query: string; caseSensitive: boolean; focusNonce: number };

/**
 * Cmd-F in a doc's reading view: a bar at the top of the doc, like the
 * editor's find (`doc-find.ts`) without replace. Enter and Shift-Enter, or
 * Cmd-G and Shift-Cmd-G, step through the matches; Esc or Close closes it.
 * The matches follow the doc as it changes.
 */
export function ReadingFindBar({
  find,
  onChange,
  onClose,
  content,
  getRoot,
  scrollerRef,
}: {
  find: ReadingFind;
  onChange: (next: ReadingFind) => void;
  onClose: () => void;
  /** The doc's text: a change re-finds in the new rendering. */
  content: string;
  getRoot: () => HTMLElement | null;
  scrollerRef: React.RefObject<HTMLElement | null>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(0);
  const [total, setTotal] = useState(0);
  const rangesRef = useRef<Range[]>([]);
  // Scroll to the current match when the person moves it, not when the doc changes under it.
  const revealRef = useRef(true);
  const searchedRef = useRef<string | null>(null);
  const { query, caseSensitive, focusNonce } = find;

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [focusNonce]);

  // After the doc has rendered (and handed out its root, which a reading
  // view that has just mounted does only in its own layout effects).
  useEffect(() => {
    const root = getRoot();
    const ranges = root ? matchRangesIn(root, query, caseSensitive) : [];
    rangesRef.current = ranges;
    setTotal(ranges.length);
    // A new query starts from its first match; a changed doc keeps its place.
    let index = current;
    const searched = `${caseSensitive ? 'Aa' : 'aa'}:${query}`;
    if (searchedRef.current !== searched) {
      searchedRef.current = searched;
      index = 0;
      revealRef.current = true;
    }
    index = ranges.length === 0 ? 0 : Math.min(index, ranges.length - 1);
    if (index !== current) setCurrent(index);
    paintFindMatches(ranges, index);
    const range = ranges[index];
    const scroller = scrollerRef.current;
    if (revealRef.current && range && scroller) revealRange(range, scroller);
    revealRef.current = false;
  }, [content, query, caseSensitive, current, getRoot, scrollerRef]);

  useEffect(() => () => clearFindMatches(), []);

  const step = useCallback((delta: 1 | -1) => {
    const count = rangesRef.current.length;
    if (count === 0) return;
    revealRef.current = true;
    setCurrent((index) => (index + delta + count) % count);
  }, []);

  // Cmd-G and Shift-Cmd-G from the field or the doc.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || !(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== 'g') return;
      const target = event.target;
      const inDoc =
        !(target instanceof Element) ||
        target === document.body ||
        barRef.current?.contains(target) ||
        getRoot()?.contains(target);
      if (!inDoc) return;
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [getRoot, step]);

  const label = findCountLabel(current, total, query);
  const button =
    'border-border-hairline text-text-secondary hover:bg-bg-2 hover:text-text-primary h-[26px] cursor-pointer rounded-[6px] border bg-transparent px-2.5 text-xs';

  return (
    <div
      ref={barRef}
      role="search"
      className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border-hairline bg-bg-1 px-3 py-2 text-xs text-text-primary"
      data-testid="reading-find"
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => onChange({ ...find, query: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
        placeholder="Find"
        aria-label="Find"
        className="h-[26px] min-w-[200px] rounded-[6px] border border-border-hairline bg-bg-0 px-2 text-xs text-text-primary outline-none placeholder:text-text-muted focus:border-border-strong"
        data-testid="reading-find-input"
      />
      {label && (
        <span
          className="px-1 text-text-muted tabular-nums"
          aria-live="polite"
          data-testid="reading-find-count"
        >
          {label}
        </span>
      )}
      <button type="button" className={button} onClick={() => step(-1)}>
        Previous
      </button>
      <button type="button" className={button} onClick={() => step(1)}>
        Next
      </button>
      <label className="mx-0.5 inline-flex cursor-pointer items-center gap-1 text-text-muted">
        <input
          type="checkbox"
          checked={caseSensitive}
          onChange={(event) => onChange({ ...find, caseSensitive: event.target.checked })}
          className="m-0 accent-accent"
        />
        Match case
      </label>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="ml-auto cursor-pointer border-none bg-transparent px-1 text-base leading-none text-text-muted hover:text-text-primary"
      >
        ×
      </button>
    </div>
  );
}
