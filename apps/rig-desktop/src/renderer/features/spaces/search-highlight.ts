import { matchRanges, type SearchPlan } from './chat-search';

/**
 * Paints a chat search's matches over the rendered transcript with the CSS
 * Custom Highlight API: no DOM mutation, so React's rows and the markdown
 * inside them are left alone. Text is matched within one row at a time
 * (`[data-message-id]`), across its inline pieces (a mention, a link), so
 * a match never runs from the end of one message into the next. The same
 * tint as find in a doc.
 */

const HIGHLIGHT_NAME = 'rig-chat-search';
const STYLE_ID = 'rig-chat-search-highlight-styles';
const HIGHLIGHT_CSS = `
::highlight(${HIGHLIGHT_NAME}) {
  background-color: color-mix(in oklab, var(--accent) 32%, transparent);
  color: inherit;
}
`;

function supported(): boolean {
  return typeof window !== 'undefined' && typeof CSS !== 'undefined' && 'highlights' in CSS;
}

function ensureStyles(): void {
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  if (style.textContent !== HIGHLIGHT_CSS) style.textContent = HIGHLIGHT_CSS;
}

/** The ranges `plan` matches in `row`'s text. */
function rangesIn(row: Element, plan: SearchPlan): Range[] {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const t = node as Text;
    // Not inside a button (Show in chat, a reaction chip): only what was written.
    if (t.parentElement?.closest('button, [data-search-skip]')) continue;
    nodes.push(t);
    starts.push(text.length);
    text += t.data;
  }
  const at = (offset: number, end: boolean): [Text, number] | null => {
    // The node holding `offset` (an end offset sits at the end of the node before).
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const start = starts[i]!;
      if (end ? offset > start : offset >= start) return [nodes[i]!, offset - start];
    }
    return null;
  };
  const ranges: Range[] = [];
  for (const [start, end] of matchRanges(text, plan)) {
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

/** Highlights `plan`'s matches in every row under `root`; returns how many. Null `plan` clears them. */
export function paintSearchMatches(root: Element, plan: SearchPlan | null): number {
  if (!supported()) return 0;
  if (!plan) {
    CSS.highlights.delete(HIGHLIGHT_NAME);
    return 0;
  }
  ensureStyles();
  const ranges: Range[] = [];
  const rows = root.querySelectorAll('[data-message-id]');
  for (const row of rows) {
    // A thread unit holds message rows of its own: each row once.
    if (row.parentElement?.closest('[data-message-id]')) continue;
    ranges.push(...rangesIn(row, plan));
  }
  CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));
  return ranges.length;
}

export function clearSearchMatches(): void {
  if (supported()) CSS.highlights.delete(HIGHLIGHT_NAME);
}
