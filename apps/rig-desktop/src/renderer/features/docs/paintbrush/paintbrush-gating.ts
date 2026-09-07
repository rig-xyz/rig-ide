import type { AgentMention } from '../comments/comments-store';

/**
 * The paintbrush props both selection components (`comments/comment-selection.tsx`,
 * `preview/preview-comment-selection.tsx`) accept — `undefined` for every
 * caller that hasn't wired paintbrush in at all, matching plain-comment
 * behavior exactly (`isPaintbrushArmed` below returns false either way).
 */
export type PaintbrushArming = { on: boolean; mention: AgentMention | null } | undefined;

/**
 * Whether a text selection's release should auto-open the paintbrush
 * composer (pre-populated with the armed agent) instead of the plain
 * floating "Comment" button — `docs/document-focus-design.md` §2, steps
 * 2-3. True only once BOTH the mode is on AND an agent has actually been
 * chosen: arming the mode alone changes nothing yet — the header's own pill
 * only expands once a model is picked too (§2, step 1), and the selection
 * gesture follows the same rule. Pure so the CM6/DOM-selection glue in
 * either component stays exactly as thin as the pre-paintbrush code was,
 * and so this one decision can't drift between the two surfaces.
 */
export function isPaintbrushArmed(paintbrush: PaintbrushArming): boolean {
  return paintbrush?.on === true && paintbrush.mention !== null;
}
