/**
 * Find in a doc's reading view (the rendered markdown): where a query
 * matches the text as shown, painted with the CSS Custom Highlight API so
 * react-markdown's tree is never touched. Literal text, like the editor's
 * find; ignoring case unless asked. A match never runs from one block (a
 * paragraph, a list item, a cell) into the next.
 */

const ALL = 'rig-doc-find';
const CURRENT = 'rig-doc-find-current';
const STYLE_ID = 'rig-doc-find-highlight-styles';
// The editor's find tints (`doc-find.ts`), the current match stronger.
const HIGHLIGHT_CSS = `
::highlight(${ALL}) {
  background-color: color-mix(in oklab, var(--accent) 18%, transparent);
  color: inherit;
}
::highlight(${CURRENT}) {
  background-color: color-mix(in oklab, var(--accent) 40%, transparent);
  color: inherit;
}
`;

/** Where `query` occurs in `text`, as `[start, end)` ranges in order, never overlapping. */
export function findOffsets(
  text: string,
  query: string,
  caseSensitive: boolean
): Array<[number, number]> {
  if (!query) return [];
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const out: Array<[number, number]> = [];
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) {
    out.push([i, i + needle.length]);
  }
  return out;
}

/** "3 of 12", "No matches"; nothing before anything is typed. */
export function findCountLabel(current: number, total: number, query: string): string | null {
  if (!query) return null;
  return total === 0 ? 'No matches' : `${current + 1} of ${total}`;
}

const BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th, dt, dd, figcaption, tr, div';

/** The ranges `query` matches in the text under `root`. */
export function matchRangesIn(root: Element, query: string, caseSensitive: boolean): Range[] {
  if (!query) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  let block: Element | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const t = node as Text;
    const parent = t.parentElement;
    // KaTeX keeps a hidden MathML copy of each formula for screen readers.
    if (!parent || parent.closest('.katex-mathml')) continue;
    const nextBlock = parent.closest(BLOCK);
    // A line break the query can't contain keeps blocks apart.
    if (nodes.length > 0 && nextBlock !== block) text += '\n';
    block = nextBlock;
    nodes.push(t);
    starts.push(text.length);
    text += t.data;
  }
  const at = (offset: number, end: boolean): [Text, number] | null => {
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const start = starts[i]!;
      if (end ? offset > start : offset >= start) return [nodes[i]!, offset - start];
    }
    return null;
  };
  const ranges: Range[] = [];
  for (const [start, end] of findOffsets(text, query, caseSensitive)) {
    const from = at(start, false);
    const to = at(end, true);
    if (!from || !to) continue;
    const range = document.createRange();
    range.setStart(from[0], from[1]);
    range.setEnd(to[0], to[1]);
    ranges.push(range);
  }
  return ranges;
}

function supported(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS;
}

/** Paints `ranges`, `current` the strongest. */
export function paintFindMatches(ranges: readonly Range[], current: number): void {
  if (!supported()) return;
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  if (style.textContent !== HIGHLIGHT_CSS) style.textContent = HIGHLIGHT_CSS;
  CSS.highlights.set(ALL, new Highlight(...ranges));
  const currentRange = ranges[current];
  const strong = currentRange ? new Highlight(currentRange) : new Highlight();
  strong.priority = 1;
  CSS.highlights.set(CURRENT, strong);
}

export function clearFindMatches(): void {
  if (!supported()) return;
  CSS.highlights.delete(ALL);
  CSS.highlights.delete(CURRENT);
}

/** Scrolls `scroller` so `range` sits a third of the way down, unless it's already in view. */
export function revealRange(range: Range, scroller: HTMLElement): void {
  const r = range.getBoundingClientRect();
  const s = scroller.getBoundingClientRect();
  const margin = 24;
  if (r.top >= s.top + margin && r.bottom <= s.bottom - margin) return;
  scroller.scrollTop += r.top - s.top - s.height / 3;
}
