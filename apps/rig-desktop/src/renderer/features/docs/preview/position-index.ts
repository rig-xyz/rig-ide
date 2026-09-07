import {
  alignEscaped,
  contentSlice,
  parseFence,
  parseInlineCodeFence,
  type Breakpoint,
} from './text-alignment';

/**
 * Bidirectional map between rendered preview DOM and markdown source
 * offsets — docs/preview-mode-spec.md, "The core mechanism: the position
 * index". Built once per render (and again on every content/DOM change);
 * consumed by both directions: a DOM selection resolves to a source range
 * (for building a comment anchor), and a source range resolves back to DOM
 * ranges (for painting a highlight).
 *
 * `markdown-position-components.tsx` is the render half: it stamps
 * `data-pos="start:end"` on every element with a source position. This
 * module is the read half — it walks the rendered DOM, and for every LEAF
 * positioned element (one with no positioned descendant of its own) it
 * runs a small local alignment (`text-alignment.ts`) between that leaf's
 * rendered text and its own source slice. The result is a set of "runs" —
 * one per actual DOM Text node — each carrying a short, monotonic list of
 * (dom offset ↔ source offset) breakpoints. Both public directions
 * (`domToSource` / `sourceToDom`) are just lookups into those runs.
 *
 * Offsets are UTF-16 code-unit offsets (plain JS string indexing) on both
 * sides, so multi-unit characters (emoji, most CJK-adjacent symbols) need
 * no special handling — they're just runs of identical code units on both
 * the rendered and source side, which the literal-match fast path in
 * `alignEscaped` already handles.
 */

// DOM node type constants (avoids depending on a global `Node` — this
// module has no reason to require one, only the `Node`/`Text`/`Element`
// TYPES, which come from the DOM lib types already in tsconfig).
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** One DOM Text node's local view of a leaf's (or a gap's) alignment. */
type Run = {
  node: Text;
  /** `dom` here is local to THIS text node (0-based); `src` is absolute. */
  breakpoints: Breakpoint[];
  /** How much of this node's text (from its start) is actually aligned. */
  matchedDomLen: number;
};

export type PlainDomRange = {
  startNode: Node;
  startOffset: number;
  endNode: Node;
  endOffset: number;
};

export type SourceRange = { start: number; end: number };

export type PositionIndex = {
  /** DOM (node, offset) → source offset, or `null` for unknown/unmapped regions. */
  domToSource(node: Node, offset: number): number | null;
  /** A DOM Range (or the plain-object equivalent) → its source span. */
  rangeToSource(range: Range | PlainDomRange): SourceRange | null;
  /**
   * A source span → the DOM range(s) that render it. Multiple ranges when
   * the span crosses a boundary the DOM can't represent as one contiguous
   * selection (a table cell edge, a block boundary, a stretch the index
   * couldn't align at all) — one Range per contiguous aligned run touched.
   */
  sourceToDom(start: number, end: number): Range[] | null;
};

function parsePos(attr: string): [number, number] | null {
  const m = /^(\d+):(\d+)$/.exec(attr);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function hasPositionedDescendant(el: Element): boolean {
  return el.querySelector('[data-pos]') !== null;
}

function collectTextNodes(el: Node): Text[] {
  const out: Text[] = [];
  const walk = (n: Node) => {
    for (const child of Array.from(n.childNodes)) {
      if (child.nodeType === TEXT_NODE) out.push(child as Text);
      else if (child.nodeType === ELEMENT_NODE) walk(child);
    }
  };
  walk(el);
  return out;
}

function firstTextIn(node: Node): Text | null {
  if (node.nodeType === TEXT_NODE) return node as Text;
  for (const child of Array.from(node.childNodes)) {
    const t = firstTextIn(child);
    if (t) return t;
  }
  return null;
}

function lastTextIn(node: Node): Text | null {
  if (node.nodeType === TEXT_NODE) return node as Text;
  const kids = Array.from(node.childNodes);
  for (let i = kids.length - 1; i >= 0; i--) {
    const t = lastTextIn(kids[i]!);
    if (t) return t;
  }
  return null;
}

/** First text node in document order strictly AFTER `node`, bounded by `root`. */
function nextTextInDocument(node: Node, root: Node): Text | null {
  let cur: Node = node;
  while (cur !== root) {
    let sib = cur.nextSibling;
    while (sib) {
      const t = firstTextIn(sib);
      if (t) return t;
      sib = sib.nextSibling;
    }
    if (!cur.parentNode) return null;
    cur = cur.parentNode;
  }
  return null;
}

/** Last text node in document order strictly BEFORE `node`, bounded by `root`. */
function prevTextInDocument(node: Node, root: Node): Text | null {
  let cur: Node = node;
  while (cur !== root) {
    let sib = cur.previousSibling;
    while (sib) {
      const t = lastTextIn(sib);
      if (t) return t;
      sib = sib.previousSibling;
    }
    if (!cur.parentNode) return null;
    cur = cur.parentNode;
  }
  return null;
}

/**
 * Resolve a DOM Range boundary point (which per the Range spec may name
 * either a Text node + character offset, or an Element + child index) down
 * to an actual Text node + character offset — the same collapsing a real
 * Selection does. Child-index offsets land "immediately before childAt" or
 * "immediately after the previous child", falling back across sibling/
 * ancestor boundaries when the immediate neighbor has no text at all (e.g.
 * an empty cell, or a lone `<input>` checkbox).
 */
function resolveBoundary(
  container: Node,
  offset: number,
  root: Node
): { node: Text; offset: number } | null {
  if (container.nodeType === TEXT_NODE) {
    const data = (container as Text).data;
    return { node: container as Text, offset: Math.max(0, Math.min(offset, data.length)) };
  }
  if (container.nodeType !== ELEMENT_NODE) return null;

  const children = container.childNodes;
  if (offset <= 0) {
    const t = firstTextIn(container) ?? nextTextInDocument(container, root);
    return t ? { node: t, offset: 0 } : null;
  }
  if (offset >= children.length) {
    const t = lastTextIn(container) ?? prevTextInDocument(container, root);
    return t ? { node: t, offset: t.data.length } : null;
  }
  const childAt = children[offset]!;
  const forward = firstTextIn(childAt) ?? nextTextInDocument(childAt, root);
  if (forward) return { node: forward, offset: 0 };
  const prevChild = children[offset - 1]!;
  const backward = lastTextIn(prevChild) ?? prevTextInDocument(prevChild, root);
  return backward ? { node: backward, offset: backward.data.length } : null;
}

/**
 * Split concatenated-leaf breakpoints (dom offsets 0-based across ALL of a
 * leaf's text nodes joined together) into one Run per actual text node,
 * rebasing each node's breakpoints to that node's own 0-based offsets.
 *
 * `breakpoints` doesn't necessarily start at `dom: 0` — `alignSimpleLeaf`'s
 * task-list-checkbox handling passes one starting at `dom: 1` to mark a
 * single leading synthetic character as unmapped. A node whose own start
 * falls entirely before the first breakpoint gets NO local breakpoint for
 * that leading stretch (rather than a fabricated one) — `mapForward`
 * correctly reports those offsets as unmapped instead of returning a
 * plausible-looking wrong answer.
 */
function distributeAcrossNodes(
  textNodes: Text[],
  breakpoints: Breakpoint[],
  matchedLen: number,
  runs: Run[]
): void {
  let concatOffset = 0;
  for (const node of textNodes) {
    const nodeLen = node.data.length;
    const nodeStart = concatOffset;
    const nodeEnd = concatOffset + nodeLen;
    const matchedDomLen = Math.max(0, Math.min(nodeLen, matchedLen - nodeStart));

    let active: Breakpoint | null = null;
    for (const bp of breakpoints) {
      if (bp.dom <= nodeStart) active = bp;
      else break;
    }
    const localBreakpoints: Breakpoint[] = active
      ? [{ dom: 0, src: active.src + (nodeStart - active.dom) }]
      : [];
    for (const bp of breakpoints) {
      if (bp.dom > nodeStart && bp.dom <= nodeEnd) {
        localBreakpoints.push({ dom: bp.dom - nodeStart, src: bp.src });
      }
    }
    // Wholly before the first breakpoint — leave this node unmapped (no Run) rather than fabricate one.
    if (localBreakpoints.length > 0)
      runs.push({ node, breakpoints: localBreakpoints, matchedDomLen });
    concatOffset = nodeEnd;
  }
}

function alignSimpleLeaf(
  el: Element,
  start: number,
  end: number,
  source: string,
  runs: Run[]
): void {
  const textNodes = collectTextNodes(el);
  if (textNodes.length === 0) return;
  const rendered = textNodes.map((t) => t.data).join('');
  // `el`'s own [start,end) includes its marker syntax (see
  // markdown-position-components.tsx) — peel that back off per tag before
  // aligning; tags with no markers of their own get the identity range.
  const { innerStartRel, innerEndRel } = contentSlice(el.tagName, source.slice(start, end));
  const innerStart = start + innerStartRel;
  const innerEnd = start + innerEndRel;

  // A GFM task-list checkbox's `<input>` is immediately followed by ONE
  // synthetic space with no source position at all — mdast-util-to-hast's
  // own rendering glue, separate from (and in addition to) the one REAL
  // source space after `[x]`/`[ ]` that `contentSlice`'s checkbox pattern
  // already excludes from `innerStart`. Whether that glue survives HTML
  // (de)serialization as its own Text node or gets coalesced into the next
  // one, it's always exactly one leading character of `rendered` to drop
  // before aligning — so drop it at the string level rather than depend on
  // DOM node boundaries that aren't guaranteed to survive a render round-trip.
  const hasLeadingCheckbox = el.querySelector(':scope > input[type="checkbox"]') !== null;
  const dropLeading = hasLeadingCheckbox && rendered.startsWith(' ') ? 1 : 0;

  const { breakpoints: aligned, matchedLen } = alignEscaped(
    rendered.slice(dropLeading),
    source.slice(innerStart, innerEnd),
    innerStart
  );
  const breakpoints = dropLeading
    ? aligned.map((bp) => ({ dom: bp.dom + dropLeading, src: bp.src }))
    : aligned;
  distributeAcrossNodes(textNodes, breakpoints, matchedLen + dropLeading, runs);
}

/**
 * `code` is never a "leaf" in the `alignEscaped` sense — its content is
 * literal (no escapes/entities to explain) but its full [start,end) source
 * span carries fence or backtick syntax the rendered text never does (see
 * `markdown-position-components.tsx` for why that syntax couldn't just be
 * excluded at stamp time the way it is for strong/em/headings/links).
 */
function alignCodeLeaf(el: Element, start: number, end: number, source: string, runs: Run[]): void {
  const textNodes = collectTextNodes(el);
  if (textNodes.length === 0) return;
  const rendered = textNodes.map((t) => t.data).join('');
  const slice = source.slice(start, end);
  const isFenced = el.parentElement?.tagName === 'PRE';

  if (isFenced) {
    const fence = parseFence(slice);
    if (!fence) return; // Indented code block or malformed — leave unmapped.
    const innerStart = start + fence.innerStartRel;
    const innerEnd = start + fence.innerEndRel;
    const inner = source.slice(innerStart, innerEnd);
    if (!rendered.startsWith(inner)) return;
    const breakpoints: Breakpoint[] = [{ dom: 0, src: innerStart }];
    let matchedLen = inner.length;
    // mdast-util-to-hast always appends a synthetic trailing "\n" to fenced
    // code text that has no source counterpart — map it to the same
    // trailing offset rather than leave it unmapped.
    if (rendered.length > inner.length && rendered[inner.length] === '\n') {
      breakpoints.push({ dom: inner.length, src: innerEnd });
      matchedLen = inner.length + 1;
    }
    distributeAcrossNodes(textNodes, breakpoints, matchedLen, runs);
    return;
  }

  const inline = parseInlineCodeFence(slice);
  if (!inline) return;
  const innerStart = start + inline.innerStartRel;
  const innerEnd = start + inline.innerEndRel;
  const literal = source.slice(innerStart, innerEnd);
  // Inline code's one substitution: an embedded line ending renders as a
  // single space (CommonMark code-span rule) — same length either way.
  const renderedFromSource = literal.replace(/\r\n|\r|\n/g, ' ');
  if (!rendered.startsWith(renderedFromSource)) return;
  distributeAcrossNodes(textNodes, [{ dom: 0, src: innerStart }], renderedFromSource.length, runs);
}

type WalkState = {
  runs: Run[];
  buffer: Text[];
  cursor: number | null;
  /**
   * Set right after `walk` skips a task-list checkbox `<input>` — see
   * there. Consumed by the very next `flushBuffer` that actually has
   * something buffered: a GFM checkbox is always immediately followed by
   * exactly one synthetic space with no source position of its own (the
   * same rendering glue `alignSimpleLeaf` drops for a checkbox item that's
   * a LEAF — this is the same fix for one that's a CONTAINER instead,
   * e.g. a task-list item that also holds a nested list, so its own
   * "Wire up the preview pane"-style text is gap-buffered rather than
   * leaf-aligned).
   */
  pendingCheckboxGlue: boolean;
};

function flushBuffer(state: WalkState, boundEnd: number | null, source: string): void {
  if (state.buffer.length === 0) return;
  if (state.cursor !== null && boundEnd !== null) {
    const rendered = state.buffer.map((t) => t.data).join('');
    const dropLeading = state.pendingCheckboxGlue && rendered.startsWith(' ') ? 1 : 0;
    const slice = source.slice(state.cursor, boundEnd);
    const { breakpoints: aligned, matchedLen } = alignEscaped(
      rendered.slice(dropLeading),
      slice,
      state.cursor
    );
    const breakpoints = dropLeading
      ? aligned.map((bp) => ({ dom: bp.dom + dropLeading, src: bp.src }))
      : aligned;
    distributeAcrossNodes(state.buffer, breakpoints, matchedLen + dropLeading, state.runs);
  }
  // With no active bound (stray text outside any positioned ancestor —
  // doesn't happen for real react-markdown output, but not crashing on it
  // matters more than explaining it) the buffer is simply dropped: those
  // text nodes never get a Run, so lookups against them return null.
  state.buffer = [];
  state.pendingCheckboxGlue = false;
}

function walk(el: Element, state: WalkState, source: string, boundEnd: number | null): void {
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === TEXT_NODE) {
      state.buffer.push(child as Text);
      continue;
    }
    if (child.nodeType !== ELEMENT_NODE) continue;
    const childEl = child as Element;
    const posAttr = childEl.getAttribute('data-pos');

    if (posAttr) {
      const parsed = parsePos(posAttr);
      if (!parsed) continue; // Malformed attribute — skip defensively.
      const [s, e] = parsed;
      flushBuffer(state, s, source);
      state.cursor = s;

      if (childEl.tagName === 'CODE') {
        alignCodeLeaf(childEl, s, e, source, state.runs);
      } else if (!hasPositionedDescendant(childEl)) {
        alignSimpleLeaf(childEl, s, e, source, state.runs);
      } else {
        // Recursing into a container whose own [s,e) starts with a marker
        // no child represents (a list item's `- `/checkbox, a heading's
        // `# `) — advance the cursor past it BEFORE walking, or the first
        // bit of real content inside (if it's plain text, buffered before
        // any positioned grandchild) would align against a slice that
        // still starts with that marker and fail outright. Tags with no
        // leading marker of their own get `innerStartRel: 0` — no-op.
        const { innerStartRel } = contentSlice(childEl.tagName, source.slice(s, e));
        state.cursor = s + innerStartRel;
        walk(childEl, state, source, e);
        flushBuffer(state, e, source);
      }
      state.cursor = e;
    } else if (hasPositionedDescendant(childEl)) {
      // A transparent wrapper we didn't stamp (react-markdown/remark-gfm's
      // synthesized <thead>/<tbody>, or our own container <div>s) — keep
      // walking through it under the SAME enclosing bound.
      walk(childEl, state, source, boundEnd);
    } else if (childEl.tagName === 'INPUT') {
      // A task-list checkbox — see `pendingCheckboxGlue`'s doc.
      state.pendingCheckboxGlue = true;
    }
    // Else: an opaque, unpositioned subtree with no positioned descendant
    // at all (a <br>, an <hr>, or any tag we didn't override) — it
    // contributes no text nodes to `state.buffer` that would need a
    // bound, so it's simply skipped.
  }
}

function runSourceRange(run: Run): SourceRange {
  const start = run.breakpoints[0]!.src;
  let last = run.breakpoints[0]!;
  for (const bp of run.breakpoints) {
    if (bp.dom <= run.matchedDomLen) last = bp;
    else break;
  }
  return { start, end: last.src + (run.matchedDomLen - last.dom) };
}

function mapForward(run: Run, localOffset: number): number | null {
  if (localOffset < 0 || localOffset > run.matchedDomLen) return null;
  // No `??` fallback to breakpoints[0] here: a run's first breakpoint isn't
  // always at dom 0 (a dropped leading synthetic character — see
  // `distributeAcrossNodes`), and an offset before it is genuinely unmapped,
  // not "close enough" to round down to.
  let chosen: Breakpoint | null = null;
  for (const bp of run.breakpoints) {
    if (bp.dom <= localOffset) chosen = bp;
    else break;
  }
  return chosen ? chosen.src + (localOffset - chosen.dom) : null;
}

function mapBackward(run: Run, srcOffset: number): number | null {
  let chosen: Breakpoint | null = null;
  for (const bp of run.breakpoints) {
    if (bp.src <= srcOffset) chosen = bp;
    else break;
  }
  if (!chosen) return null;
  const dom = chosen.dom + (srcOffset - chosen.src);
  return dom < 0 || dom > run.matchedDomLen ? null : dom;
}

/** Build the bidirectional position index for one rendered preview + its source. */
export function buildPositionIndex(root: HTMLElement, source: string): PositionIndex {
  const state: WalkState = { runs: [], buffer: [], cursor: null, pendingCheckboxGlue: false };
  walk(root, state, source, null);
  flushBuffer(state, null, source);

  const runByTextNode = new Map<Text, Run>();
  for (const run of state.runs) runByTextNode.set(run.node, run);
  const runsBySource = [...state.runs].sort(
    (a, b) => runSourceRange(a).start - runSourceRange(b).start
  );

  function domToSource(node: Node, offset: number): number | null {
    const resolved = resolveBoundary(node, offset, root);
    if (!resolved) return null;
    const run = runByTextNode.get(resolved.node);
    if (!run) return null;
    return mapForward(run, resolved.offset);
  }

  /**
   * A drag that ends exactly at the start of the NEXT block hands us a
   * Range whose end names that next block's own leaf text node at
   * `endOffset: 0` — nothing in it is actually selected. Mapped naively
   * through `domToSource`, that boundary lands past the next block's OWN
   * marker syntax (`alignSimpleLeaf`'s `innerStart` — a heading's `# `, a
   * list item's `- `), because that is the first position its own Run
   * actually covers. `source.slice(start, end)` then silently swallows
   * that marker text: it sits BEFORE `end`, inside the slice, even though
   * the drag never touched the next block at all (a selected heading
   * "idk man" ending at the following bullet's start came back as
   * "idk man\n\n- ").
   *
   * Recovered by walking backward from the boundary to the last real text
   * node that is still genuinely inside the selection, and mapping to the
   * END of that node's own aligned span instead — the same
   * `prevTextInDocument` walk `resolveBoundary` already uses for the
   * mirror-image (backward) case, reused here as a public tail on
   * `rangeToSource` rather than duplicated.
   */
  function endOfLastMappedTextBefore(boundary: Node): number | null {
    let candidate = prevTextInDocument(boundary, root);
    while (candidate) {
      const mapped = domToSource(candidate, candidate.data.length);
      if (mapped !== null) return mapped;
      candidate = prevTextInDocument(candidate, root);
    }
    return null;
  }

  /**
   * Drop trailing whitespace from a RECOVERED span only — never on the
   * ordinary path. A leaf's own aligned span can end on a run of source
   * whitespace with no rendered counterpart (a heading line's trailing
   * blank lines before the next block), and the recovery above walks to
   * the END of that leaf's whole matched length, whitespace included; this
   * trims it back off. Applying this to every ordinary (non-recovered)
   * `end` is NOT safe: a leaf can legitimately have a real skipped-marker
   * boundary (a blockquote's per-line `> `, mid-run) sitting right at
   * `end`, whose OWN un-rendered characters (a space) look identical to
   * "trailing whitespace" but are load-bearing for `sourceToDom`'s
   * backward mapping — trimming those miscounts the round trip by exactly
   * the marker's width. Recovered ends never have that hazard: they are
   * by construction the boundary of one whole leaf, past any such skip.
   */
  function trimTrailingWhitespace(from: number, to: number): number {
    let end = to;
    while (end > from && /\s/.test(source[end - 1]!)) end--;
    return end;
  }

  function rangeToSource(range: Range | PlainDomRange): SourceRange | null {
    const startNode = 'startContainer' in range ? range.startContainer : range.startNode;
    const endNode = 'endContainer' in range ? range.endContainer : range.endNode;
    const endOffset = range.endOffset;
    const start = domToSource(startNode, range.startOffset);
    if (start === null) return null;

    let end = domToSource(endNode, endOffset);
    // Structural signature of the overrun: a boundary naming a DIFFERENT
    // node than the start at offset 0 (nothing of that node selected), or
    // — belt and braces — a "mapped" end that comes out before start,
    // the clearest possible sign it landed in an unrelated, earlier run.
    const overran = (endOffset === 0 && endNode !== startNode) || (end !== null && end < start);
    if (overran) {
      const recovered = endOfLastMappedTextBefore(endNode);
      if (recovered !== null) end = trimTrailingWhitespace(start, recovered);
    }
    if (end === null || end < start) return null;
    return { start, end };
  }

  function sourceToDom(start: number, end: number): Range[] | null {
    if (!(end > start)) return null;
    const doc = root.ownerDocument;
    if (!doc) return null;
    const ranges: Range[] = [];
    for (const run of runsBySource) {
      const span = runSourceRange(run);
      const overlapStart = Math.max(start, span.start);
      const overlapEnd = Math.min(end, span.end);
      if (overlapStart >= overlapEnd) continue;
      const domStart = mapBackward(run, overlapStart);
      const domEnd = mapBackward(run, overlapEnd);
      if (domStart === null || domEnd === null) continue;
      const range = doc.createRange();
      range.setStart(run.node, domStart);
      range.setEnd(run.node, domEnd);
      ranges.push(range);
    }
    return ranges.length > 0 ? ranges : null;
  }

  return { domToSource, rangeToSource, sourceToDom };
}
