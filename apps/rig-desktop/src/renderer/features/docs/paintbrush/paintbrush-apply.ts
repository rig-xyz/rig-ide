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
  | { ok: true; from: number; to: number; nextContent: string }
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
  const from = located.index;
  const to = from + anchor.exact.length;
  return {
    ok: true,
    from,
    to,
    nextContent: content.slice(0, from) + replacement + content.slice(to),
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
