import { reanchor } from '../comments/anchors';
import type { RigCommentAnchor } from '@shared/rig/comments';

/**
 * Where a paintbrush proposal's replacement would land against the CURRENT
 * buffer, and the buffer that would result — pure, no side effects, no CM6.
 *
 * Re-resolves the thread's own anchor via the exact same quote-anchor ladder
 * every other reanchor in this app uses (`comments/anchors.ts`'s `reanchor`)
 * rather than trusting the range the stroke captured at request time: the
 * buffer may have moved while the agent was working (another edit, a
 * teammate's change arriving), and applying at a stale offset would silently
 * corrupt the document. Same guardrail as the rest of the comments layer —
 * never fabricate a position: an anchor that only matches after whitespace
 * normalization (no reliable single offset) is refused exactly like a
 * genuine orphan, not guessed at.
 */
export type ProposalApplyResult =
  | { ok: true; from: number; to: number; original: string; nextContent: string }
  | { ok: false; reason: 'no-anchor' | 'orphan' };

export function resolveProposalApply(
  content: string,
  anchor: RigCommentAnchor | null | undefined,
  replacement: string
): ProposalApplyResult {
  if (!anchor) return { ok: false, reason: 'no-anchor' };
  const located = reanchor(content, anchor);
  if (located.status !== 'anchored' || located.index === undefined) {
    return { ok: false, reason: 'orphan' };
  }
  let from = located.index;
  let to = from + anchor.exact.length;
  if (replacement === '') {
    ({ from, to } = expandDeletionToLines(content, from, to));
  }
  return {
    ok: true,
    from,
    to,
    original: content.slice(from, to),
    nextContent: content.slice(0, from) + replacement + content.slice(to),
  };
}

/**
 * A deletion that would leave its line(s) holding nothing but Markdown
 * markers (`# `, `- `, `> `, `1. `) removes the whole line(s) instead —
 * "remove the title" must not leave a bare `# ` behind. A deletion inside a
 * sentence stays exactly as narrow as the passage.
 */
function expandDeletionToLines(
  content: string,
  from: number,
  to: number
): { from: number; to: number } {
  const lineStart = from === 0 ? 0 : content.lastIndexOf('\n', from - 1) + 1;
  const newlineAfter = content.indexOf('\n', to);
  const lineEnd = newlineAfter === -1 ? content.length : newlineAfter;
  const leftover = content.slice(lineStart, from) + content.slice(to, lineEnd);
  if (!/^[\s#>*+-]*(?:\d+\.)?\s*$/.test(leftover)) return { from, to };
  if (newlineAfter !== -1) return { from: lineStart, to: newlineAfter + 1 };
  return { from: lineStart === 0 ? 0 : lineStart - 1, to: lineEnd };
}

/**
 * What `revertProposal` needs to undo an applied stroke later: the text it
 * replaced, the text it put there, and a little context on either side so
 * the applied span can be re-located exactly even when the replacement is
 * empty (a deletion) or repeats elsewhere in the document.
 */
export type AppliedProposalRecord = {
  original: string;
  replacement: string;
  prefix: string;
  suffix: string;
};

const REVERT_CONTEXT = 32;

export function recordProposalApply(
  nextContent: string,
  from: number,
  replacement: string,
  original: string
): AppliedProposalRecord {
  return {
    original,
    replacement,
    prefix: nextContent.slice(Math.max(0, from - REVERT_CONTEXT), from),
    suffix: nextContent.slice(from + replacement.length, from + replacement.length + REVERT_CONTEXT),
  };
}

/**
 * Put the original passage back over an applied replacement — only when the
 * applied span (with its recorded context) is still found exactly once in
 * the current buffer. Anything else is refused rather than guessed at, the
 * same rule as applying.
 */
export function resolveProposalRevert(
  content: string,
  record: AppliedProposalRecord
): { ok: true; nextContent: string } | { ok: false } {
  const needle = record.prefix + record.replacement + record.suffix;
  if (needle.length === 0) return { ok: false };
  const first = content.indexOf(needle);
  if (first === -1 || content.indexOf(needle, first + 1) !== -1) return { ok: false };
  const at = first + record.prefix.length;
  return {
    ok: true,
    nextContent: content.slice(0, at) + record.original + content.slice(at + record.replacement.length),
  };
}

/**
 * Whether a proposal reply's Apply button should be enabled right now — the
 * same check `resolveProposalApply` makes, without computing the spliced
 * content. Used to gate the button and its "text has changed" tooltip
 * before the reader ever clicks.
 */
export function canApplyProposal(
  content: string,
  anchor: RigCommentAnchor | null | undefined
): boolean {
  return resolveProposalApply(content, anchor, '').ok;
}
