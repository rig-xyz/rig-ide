/**
 * Pulls a paintbrush stroke's proposed replacement out of the headless
 * agent's plain-prose answer.
 *
 * The ACP session has no structured output channel for this — `readAnswer`
 * (`comment-agent.ts`) reads plain assistant text off the transcript, the
 * same as any other reply — so the prompt (`comment-agent-prompt.ts`) asks
 * the agent to wrap a replacement in these sentinel markers when (and only
 * when) the paintbrush instruction calls for a change to the anchored
 * passage. An answer with no markers passes through untouched, `proposal:
 * null` — a question ("what does this mean?") or a refusal never gets a
 * fabricated proposal.
 *
 * Pure string work, mirroring `renderer/features/docs/comments/anchors.ts`'s
 * own "no I/O, no ACP, just text" shape — kept in main only because the
 * markers are an implementation detail of this one prompt, not a contract
 * the renderer needs to know about (it only ever sees the parsed result via
 * `meta.proposal`, `shared/rig/comments.ts`'s `getCommentProposal`).
 */

export const PAINTBRUSH_REPLACEMENT_START = '<<<RIG_PAINTBRUSH_REPLACEMENT>>>';
export const PAINTBRUSH_REPLACEMENT_END = '<<<END_RIG_PAINTBRUSH_REPLACEMENT>>>';

/**
 * Breaks sentinel-marker occurrences in UNTRUSTED text before it is embedded
 * in the agent's prompt (the anchored passage, earlier thread messages). A
 * document or teammate comment that contains the markers verbatim could
 * otherwise be echoed by the model and picked up by `extractProposal` as a
 * doc-authored proposal. Dropping one angle bracket keeps the text readable
 * while making the token unmatchable.
 */
export function neutralizeSentinels(text: string): string {
  return text
    .split(PAINTBRUSH_REPLACEMENT_START)
    .join('<<RIG_PAINTBRUSH_REPLACEMENT>>')
    .split(PAINTBRUSH_REPLACEMENT_END)
    .join('<<END_RIG_PAINTBRUSH_REPLACEMENT>>');
}

export type ExtractedAnswer = {
  /** The reader-facing reply, with the sentinel block (if any) removed. */
  body: string;
  proposal: { replacement: string } | null;
};

/**
 * `answer` is exactly what `readAnswer`/`progress.latestText()` produced —
 * this never rejects malformed input, it just fails to find a proposal in
 * it. A start marker with no matching end marker (a truncated turn, or the
 * model simply not closing the block) is treated the same way: no proposal,
 * original text untouched, rather than guessing where it would have ended.
 */
export function extractProposal(answer: string): ExtractedAnswer {
  const start = answer.indexOf(PAINTBRUSH_REPLACEMENT_START);
  if (start === -1) return { body: answer, proposal: null };
  const contentStart = start + PAINTBRUSH_REPLACEMENT_START.length;
  const end = answer.indexOf(PAINTBRUSH_REPLACEMENT_END, contentStart);
  if (end === -1) return { body: answer, proposal: null };

  const replacement = answer.slice(contentStart, end).replace(/^\n/, '').replace(/\n$/, '');
  const body = (answer.slice(0, start) + answer.slice(end + PAINTBRUSH_REPLACEMENT_END.length)).trim();

  return {
    // A block-only answer (no surrounding prose) still needs something to
    // post as the visible reply — the thread must never show an empty comment.
    body: body.length > 0 ? body : 'Proposed a change to the selected passage.',
    proposal: replacement.length > 0 ? { replacement } : null,
  };
}
