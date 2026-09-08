import type { PositionIndex } from '../preview/position-index';
import type { PaintbrushOverlay } from './paintbrush-decorations';

/**
 * Preview-mode painting for the paintbrush, via the CSS Custom Highlight API
 * (the same mechanism `preview/comment-highlights.ts` uses for comment
 * anchors): a soft tint over the brushed span while its composer is open, a
 * slightly firmer tint on the span a proposal is waiting to be applied to,
 * and a SHIMMER while a stroke streams.
 *
 * `::highlight()` accepts only color, background-color and text-decoration,
 * so a gradient sweep is impossible there. The shimmer is built out of the
 * one thing the API does well instead: many ranges. The streaming span is
 * split into per-character ranges, each assigned to one of `SHIMMER_STEPS`
 * highlight buckets whose background alphas trace a soft bump; a ticker
 * advances which bucket each character sits in, and the bump travels along
 * the text. Exact glyph geometry, no overlay elements, nothing that can
 * drift or shift layout. Reduced motion: one steady tint, no ticker.
 */

const STYLE_ID = 'rig-paintbrush-preview-highlight-styles';
const RESTING_KEY = 'rig-paintbrush';
const READY_KEY = 'rig-paintbrush-ready';
const shimmerKey = (step: number) => `rig-paintbrush-shimmer-${step}`;

const SHIMMER_STEPS = 16;
const SHIMMER_TICK_MS = 80;
/** Minimum passage length the band is scaled against, so a two-word selection still gets a sweep rather than a blink. */
const SHIMMER_MIN_SPAN = 24;

const RESTING_ALPHA = 16;
const READY_ALPHA = 22;
/** Per-bucket alpha (percent of the accent): quiet at the edges, a soft crest in the middle. */
const SHIMMER_ALPHA = Array.from({ length: SHIMMER_STEPS }, (_, step) => {
  const t = step / SHIMMER_STEPS;
  const crest = Math.max(0, Math.cos((t - 0.5) * Math.PI * 2));
  return Math.round(RESTING_ALPHA + 16 * crest * crest);
});

const HIGHLIGHT_CSS = [
  `::highlight(${RESTING_KEY}) { background-color: color-mix(in srgb, var(--accent) ${RESTING_ALPHA}%, transparent); }`,
  `::highlight(${READY_KEY}) { background-color: color-mix(in srgb, var(--accent) ${READY_ALPHA}%, transparent); }`,
  ...SHIMMER_ALPHA.map(
    (alpha, step) =>
      `::highlight(${shimmerKey(step)}) { background-color: color-mix(in srgb, var(--accent) ${alpha}%, transparent); }`
  ),
].join('\n');

const ALL_KEYS = [
  RESTING_KEY,
  READY_KEY,
  ...Array.from({ length: SHIMMER_STEPS }, (_, step) => shimmerKey(step)),
];

function highlightApiSupported(): boolean {
  return typeof window !== 'undefined' && typeof CSS !== 'undefined' && 'highlights' in CSS;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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

/** One Range per character inside `range`, in document order. */
function characterRanges(range: Range): Range[] {
  const out: Range[] = [];
  const doc = range.startContainer.ownerDocument;
  if (!doc) return out;
  const root = range.commonAncestorContainer;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null = root.nodeType === Node.TEXT_NODE ? root : walker.nextNode();
  for (; node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue;
    const text = node as Text;
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : text.data.length;
    for (let i = start; i < end; i++) {
      const char = doc.createRange();
      char.setStart(text, i);
      char.setEnd(text, i + 1);
      out.push(char);
    }
  }
  return out;
}

function setOrClear(key: string, ranges: Range[], painted: Set<string>): void {
  if (ranges.length === 0) {
    if (painted.has(key)) {
      CSS.highlights.delete(key);
      painted.delete(key);
    }
    return;
  }
  ensureStyles();
  CSS.highlights.set(key, new Highlight(...ranges));
  painted.add(key);
}

export type PaintbrushPreviewPainter = {
  /** Replace the painted overlay set: at most one range in practice (the composer's live selection, the one streaming stroke, or the one proposal waiting to be applied). */
  paint(overlays: readonly PaintbrushOverlay[]): void;
  dispose(): void;
};

export function createPaintbrushPreviewPainter(
  getIndex: () => PositionIndex | null
): PaintbrushPreviewPainter {
  const painted = new Set<string>();
  let shimmerChars: Range[] = [];
  let shimmerPhase = 0;
  let ticker: ReturnType<typeof setInterval> | null = null;

  const paintShimmer = () => {
    const buckets: Range[][] = Array.from({ length: SHIMMER_STEPS }, () => []);
    const span = Math.max(shimmerChars.length, SHIMMER_MIN_SPAN);
    shimmerChars.forEach((char, i) => {
      const along = (i / span) * SHIMMER_STEPS;
      const step = (((Math.floor(along - shimmerPhase) % SHIMMER_STEPS) + SHIMMER_STEPS) % SHIMMER_STEPS);
      buckets[step]!.push(char);
    });
    buckets.forEach((ranges, step) => setOrClear(shimmerKey(step), ranges, painted));
  };

  const stopTicker = () => {
    if (ticker !== null) clearInterval(ticker);
    ticker = null;
  };

  return {
    paint(overlays) {
      if (!highlightApiSupported()) return;
      const index = getIndex();
      const resting: Range[] = [];
      const ready: Range[] = [];
      const streaming: Range[] = [];
      if (index) {
        for (const overlay of overlays) {
          const ranges = index
            .sourceToDom(overlay.from, overlay.to)
            ?.filter((range) => range.toString().trim() !== '');
          if (!ranges) continue;
          if (overlay.streaming) streaming.push(...ranges);
          else if (overlay.ready) ready.push(...ranges);
          else resting.push(...ranges);
        }
      }

      setOrClear(RESTING_KEY, resting, painted);

      if (streaming.length > 0 && prefersReducedMotion()) {
        // No motion: the streaming span just wears the firmer tint.
        ready.push(...streaming);
        streaming.length = 0;
      }
      setOrClear(READY_KEY, ready, painted);

      shimmerChars = streaming.flatMap(characterRanges);
      if (shimmerChars.length === 0) {
        stopTicker();
        for (let step = 0; step < SHIMMER_STEPS; step++) setOrClear(shimmerKey(step), [], painted);
        return;
      }
      paintShimmer();
      if (ticker === null) {
        ticker = setInterval(() => {
          shimmerPhase = (shimmerPhase + 1) % SHIMMER_STEPS;
          paintShimmer();
        }, SHIMMER_TICK_MS);
      }
    },

    dispose() {
      stopTicker();
      shimmerChars = [];
      if (!highlightApiSupported()) return;
      for (const key of ALL_KEYS) CSS.highlights.delete(key);
      painted.clear();
    },
  };
}
