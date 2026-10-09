/**
 * Text-anchor helpers for the comments layer.
 *
 * Ported from `rig/src/comment-anchors.mjs`. `reanchor` follows the CLI's
 * `locateAnchor` (ties are ambiguous), and goes further in two ways the CLI
 * should follow: surroundings are compared by similarity, not only exact
 * equality, and a whitespace-normalized match is mapped back to a real offset.
 * Anchors are built the same way as the CLI and the web hub.
 *
 * Pure string work: no I/O, no CM6, no relay.
 */

import type { RigCommentAnchor } from '@shared/rig/comments';

/**
 * Collapse whitespace runs and trim — the "whitespace-normalized fallback" used
 * both when re-anchoring an existing comment and when explaining why a quote
 * didn't match verbatim.
 */
export function normalizeWhitespace(text: string): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** All start indices where `needle` occurs verbatim in `text` (non-overlapping). */
export function findAllOccurrences(text: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const idx = text.indexOf(needle, from);
    if (idx === -1) break;
    out.push(idx);
    from = idx + needle.length;
  }
  return out;
}

/** Share of character pairs two strings have in common (Dice), 0 to 1. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const pairs = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const pair = a.slice(i, i + 2);
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const pair = b.slice(i, i + 2);
    const left = pairs.get(pair) ?? 0;
    if (left > 0) {
      pairs.set(pair, left - 1);
      shared++;
    }
  }
  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

/** Two candidates closer than this are a tie. */
const TIE = 0.05;

/**
 * Among several verbatim occurrences of the same quote, the one whose
 * surrounding text is most like the anchor's recorded prefix and suffix. An
 * exact match scores 1 per side; otherwise how alike the two are. Candidates
 * that score the same stay ambiguous, never the first one by default.
 */
function bestOccurrences(
  fileText: string,
  exact: string,
  occurrences: number[],
  prefix: string | undefined,
  suffix: string | undefined
): number[] {
  const scored = occurrences.map((index) => {
    const before = fileText.slice(Math.max(0, index - (prefix?.length ?? 0)), index);
    const afterStart = index + exact.length;
    const after = fileText.slice(afterStart, afterStart + (suffix?.length ?? 0));
    return { index, score: (prefix ? similarity(prefix, before) : 0) + (suffix ? similarity(suffix, after) : 0) };
  });
  const top = Math.max(...scored.map((c) => c.score));
  if (top <= 0) return occurrences;
  return scored.filter((c) => top - c.score < TIE).map((c) => c.index);
}

/**
 * Where a whitespace-normalized match sits in the real text: the offsets of
 * its first and last characters, widened over the quote's own leading and
 * trailing whitespace (a newline only when the quote's has one).
 */
function realSpan(text: string, exact: string, normStart: number, normLength: number): { index: number; length: number } | null {
  // Map each character of the normalized text back to its offset.
  const offsets: number[] = [];
  let pendingSpace = -1;
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i]!)) {
      if (pendingSpace === -1) pendingSpace = i;
      continue;
    }
    if (pendingSpace !== -1 && offsets.length > 0) offsets.push(pendingSpace);
    pendingSpace = -1;
    offsets.push(i);
  }
  const first = offsets[normStart];
  const last = offsets[normStart + normLength - 1];
  if (first === undefined || last === undefined) return null;
  let start = first;
  let end = last + 1;
  const lead = /^\s*/.exec(exact)![0];
  const trail = /\s*$/.exec(exact)![0];
  const leadSpace = lead.includes('\n') ? /\s/ : /[^\S\r\n]/;
  const trailSpace = trail.includes('\n') ? /\s/ : /[^\S\r\n]/;
  if (lead) while (start > 0 && leadSpace.test(text[start - 1]!)) start--;
  if (trail) while (end < text.length && trailSpace.test(text[end]!)) end++;
  return { index: start, length: end - start };
}

export type ReanchorResult =
  /** Anchor-less (file-level) comment. */
  | { status: 'file-level' }
  /**
   * Located at `index`. `normalized` when only the whitespace-normalized
   * fallback matched (a reindent, CRLF line endings): `length` is then the
   * span's real length, which differs from the quote's.
   */
  | { status: 'anchored'; index: number; length?: number; normalized?: boolean }
  /** The quote is there more than once and nothing says which: `candidates` are their offsets. */
  | { status: 'ambiguous'; candidates: number[]; normalized: boolean }
  | { status: 'orphan' };

/**
 * Locate an existing comment's anchor in the current file text, the way the
 * CLI's `locateAnchor` does (`rig/src/comment-anchors.mjs`): a tie is
 * ambiguous, never the first match.
 *   1. One exact match: there.
 *   2. Several: the one whose surroundings best match the recorded prefix
 *      and suffix, by similarity rather than only exact equality, so an edit
 *      next to a repeated line doesn't move its thread. Ties are ambiguous.
 *   3. No exact match: retry whitespace-normalized, mapped back to a real
 *      offset, so a reindented or CRLF block keeps its place.
 *   4. Still nothing: orphan.
 */
export function reanchor(
  fileText: string,
  anchor: Pick<RigCommentAnchor, 'exact' | 'prefix' | 'suffix'> | null | undefined
): ReanchorResult {
  if (!anchor?.exact) return { status: 'file-level' };
  const exact = anchor.exact;
  const text = String(fileText ?? '');
  const occurrences = findAllOccurrences(text, exact);
  if (occurrences.length === 1) {
    return { status: 'anchored', index: occurrences[0]! };
  }
  if (occurrences.length > 1) {
    const best = bestOccurrences(text, exact, occurrences, anchor.prefix, anchor.suffix);
    return best.length === 1 ? { status: 'anchored', index: best[0]! } : { status: 'ambiguous', candidates: best, normalized: false };
  }
  const normExact = normalizeWhitespace(exact);
  if (!normExact) return { status: 'orphan' };
  const normOccurrences = findAllOccurrences(normalizeWhitespace(text), normExact);
  const spans = normOccurrences.map((at) => realSpan(text, exact, at, normExact.length)).filter((s) => s !== null);
  if (spans.length === 1) return { status: 'anchored', index: spans[0]!.index, length: spans[0]!.length, normalized: true };
  if (spans.length > 1) {
    // Pick by surroundings, as for exact matches.
    const byIndex = new Map(spans.map((s) => [s.index, s]));
    const best = bestOccurrences(text, exact, [...byIndex.keys()], anchor.prefix, anchor.suffix);
    if (best.length === 1) {
      const span = byIndex.get(best[0]!)!;
      return { status: 'anchored', index: span.index, length: span.length, normalized: true };
    }
    return { status: 'ambiguous', candidates: best, normalized: true };
  }
  return { status: 'orphan' };
}

export type BuildAnchorResult =
  | { ok: true; anchor: RigCommentAnchor }
  | { ok: false; whitespaceOnly: boolean };

/**
 * Build an anchor for a NEW comment: the quote must occur verbatim in
 * `fileText` (the anti-hallucination guardrail — a comment whose quote isn't
 * real text is refused). On success, prefix/suffix are ~`contextLen` chars of
 * real surrounding text.
 *
 * `whitespaceOnly` is true when the quote only matches after whitespace
 * normalization, so the caller can be specific instead of saying "not found".
 */
export function buildAnchor(
  fileText: string,
  quote: string,
  { contextLen = 32 }: { contextLen?: number } = {}
): BuildAnchorResult {
  const text = String(fileText ?? '');
  const idx = text.indexOf(quote);
  if (idx === -1) {
    const normQuote = normalizeWhitespace(quote);
    const whitespaceOnly = Boolean(normQuote) && normalizeWhitespace(text).includes(normQuote);
    return { ok: false, whitespaceOnly };
  }
  const prefix = text.slice(Math.max(0, idx - contextLen), idx);
  const suffixStart = idx + quote.length;
  const suffix = text.slice(suffixStart, suffixStart + contextLen);
  return { ok: true, anchor: { exact: quote, prefix, suffix } };
}

/**
 * Build an anchor from a SOURCE range that is already known good — the
 * Preview position index's `rangeToSource` (docs/preview-mode-spec.md
 * "Selection → anchor") maps a DOM selection to real offsets in the current
 * buffer, so unlike `buildAnchor` there is nothing to verify: a slice of
 * `fileText` is verbatim by construction, markers and all (a selection
 * spanning into a `**bold**` span yields an `exact` that includes the `**`).
 * Never refuses — a range never needs to.
 */
export function buildAnchorFromRange(
  fileText: string,
  start: number,
  end: number,
  { contextLen = 32 }: { contextLen?: number } = {}
): RigCommentAnchor {
  const text = String(fileText ?? '');
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  const prefix = text.slice(Math.max(0, s - contextLen), s);
  const suffix = text.slice(e, e + contextLen);
  return { exact: text.slice(s, e), prefix, suffix };
}

type Threadable = { id: string; parentId: string | null };

export type ThreadGroup<M extends Threadable> = { root: M; replies: M[] };

/**
 * Group a flat list of binding messages (roots + replies, as returned by
 * `GET .../messages?path=…`) into threads. A reply whose parent isn't in the
 * list is shown as its own thread rather than silently dropped.
 */
export function groupThreads<M extends Threadable>(messages: readonly M[]): ThreadGroup<M>[] {
  const list = Array.isArray(messages) ? messages : [];
  const roots: M[] = [];
  const repliesByParent = new Map<string, M[]>();
  for (const m of list) {
    if (m.parentId) {
      const arr = repliesByParent.get(m.parentId) ?? [];
      arr.push(m);
      repliesByParent.set(m.parentId, arr);
    } else {
      roots.push(m);
    }
  }
  const rootIds = new Set(roots.map((r) => r.id));
  for (const [parentId, replies] of repliesByParent) {
    if (!rootIds.has(parentId)) {
      roots.push(...replies);
      repliesByParent.delete(parentId);
    }
  }
  return roots.map((root) => ({ root, replies: repliesByParent.get(root.id) ?? [] }));
}

/** Shorten a quote for single-line display. */
export function shortenQuote(text: string, maxLen = 80): string {
  const collapsed = normalizeWhitespace(text);
  return collapsed.length > maxLen ? `${collapsed.slice(0, maxLen - 1)}…` : collapsed;
}
