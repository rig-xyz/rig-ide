/**
 * Text-anchor helpers for the comments layer.
 *
 * A direct port of `rig/src/comment-anchors.mjs` — the CLI and the web hub run
 * the same algorithm, and an anchor built or resolved differently here would
 * disagree with them about which passage a comment belongs to. Change the three
 * implementations together or not at all.
 *
 * Pure string work: no I/O, no CM6, no relay. Ported verbatim from emdash.
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

/**
 * Among several verbatim occurrences of the same quote, pick the one whose
 * surrounding text best matches the anchor's recorded prefix/suffix.
 */
function bestOccurrence(
  fileText: string,
  exact: string,
  occurrences: number[],
  prefix: string | undefined,
  suffix: string | undefined
): number {
  let best = occurrences[0];
  let bestScore = -1;
  for (const idx of occurrences) {
    const before = fileText.slice(Math.max(0, idx - (prefix?.length ?? 0)), idx);
    const afterStart = idx + exact.length;
    const after = fileText.slice(afterStart, afterStart + (suffix?.length ?? 0));
    let score = 0;
    if (prefix && before === prefix) score += 1;
    if (suffix && after === suffix) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = idx;
    }
  }
  return best;
}

export type ReanchorResult =
  /** Anchor-less (file-level) comment. */
  | { status: 'file-level' }
  /**
   * Located. `index` is the document offset; it is absent when only the
   * whitespace-normalized fallback matched, where no offset in the current text
   * corresponds to the recorded quote.
   */
  | { status: 'anchored'; index?: number; normalized?: boolean }
  | { status: 'orphan' };

/**
 * Locate an existing comment's anchor in the current file text.
 *   1. Exact match(es) of anchor.exact.
 *   2. Multiple matches → pick by prefix/suffix similarity.
 *   3. No exact match → retry whitespace-normalized.
 *   4. Still nothing → orphan.
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
    return { status: 'anchored', index: occurrences[0] };
  }
  if (occurrences.length > 1) {
    return {
      status: 'anchored',
      index: bestOccurrence(text, exact, occurrences, anchor.prefix, anchor.suffix),
    };
  }
  const normExact = normalizeWhitespace(exact);
  const normFile = normalizeWhitespace(text);
  if (normExact && normFile.includes(normExact)) {
    return { status: 'anchored', normalized: true };
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
