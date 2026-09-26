import type { RunnableAgent } from '@renderer/features/chat/use-runnable-agents';
import type { AgentMention } from '../comments/comments-store';

/**
 * The comment-mode props both selection components (`comments/comment-selection.tsx`,
 * `preview/preview-comment-selection.tsx`) accept — `undefined` for every
 * caller that hasn't wired it in, matching plain-comment behavior exactly.
 * `agents` are the one-click asks on the selection pill while the mode is off.
 */
export type PaintbrushArming = { on: boolean; mention: AgentMention | null; agents?: RunnableAgent[] } | undefined;

/**
 * Whether a text selection's release opens the composer straight away
 * (addressed to `mention`, or to nobody for just you) instead of showing the
 * selection pill: whenever comment mode is on (canvas board 16). Pure so
 * this one decision can't drift between the two surfaces.
 */
export function isPaintbrushArmed(paintbrush: PaintbrushArming): boolean {
  return paintbrush?.on === true;
}
