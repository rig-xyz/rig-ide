/**
 * The pulse summary is prose written by a model over the account's real
 * activity, and it leaks two things a reader should never see: internal
 * identifiers (`int_gs05m2`), and rig names that look like plain words
 * when they should be doors into the rig.
 *
 * This turns one summary string into segments the header can render: plain
 * text, and links carrying the bindingId to open. Pure and tested, because
 * the input is model output and every odd shape it produces (an ID with no
 * known rig, a name appearing twice, a parenthetical of nothing but IDs)
 * has to degrade into readable English rather than a broken sentence.
 *
 * Fixing this here rather than in the relay's prompt is deliberate: a
 * prompt can ask a model not to print IDs, it cannot guarantee it.
 */

export type SummarySegment =
  | { kind: 'text'; text: string }
  | { kind: 'rig'; text: string; bindingId: string };

/** Internal identifiers the narration sometimes cites. Never shown to a reader. */
const ID_PATTERN = /\b(?:int|bnd|dev|chg)_[A-Za-z0-9]+\b/g;

/**
 * Strips ID citations, then tidies what their removal leaves behind: an
 * emptied parenthetical, a doubled space, a space before punctuation.
 * Done in that order so `(int_a and int_b)` disappears completely rather
 * than collapsing to a stray `( and )`.
 */
export function stripIdentifiers(summary: string): string {
  const withoutIds = summary.replace(ID_PATTERN, '');
  return withoutIds
    // A parenthetical whose contents are now only separators and whitespace.
    .replace(/\s*\([\s,;]*(?:and|or)?[\s,;]*\)/g, '')
    .replace(/\(\s*(?:and|or)\s+/g, '(')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim();
}

/**
 * Splits the cleaned summary on the names of rigs the reader actually has,
 * longest name first so `rig-bike-old` is never matched as `rig-bike`
 * followed by a stray `-old`. Matching is case-insensitive but the text
 * the reader sees is preserved exactly as the model wrote it.
 */
export function summarySegments(
  summary: string,
  rigs: readonly { bindingId: string; rigName: string }[]
): SummarySegment[] {
  const cleaned = stripIdentifiers(summary);
  if (!cleaned) return [];

  const named = rigs
    .filter((rig) => rig.rigName.trim().length > 0)
    .sort((a, b) => b.rigName.length - a.rigName.length);
  if (named.length === 0) return [{ kind: 'text', text: cleaned }];

  const segments: SummarySegment[] = [];
  let rest = cleaned;

  while (rest.length > 0) {
    let bestIndex = -1;
    let best: { bindingId: string; rigName: string } | null = null;
    for (const rig of named) {
      const index = rest.toLowerCase().indexOf(rig.rigName.toLowerCase());
      if (index === -1) continue;
      // Earliest match wins; ties go to the longer name, which `named`
      // already orders first.
      if (bestIndex === -1 || index < bestIndex) {
        bestIndex = index;
        best = rig;
      }
    }
    if (bestIndex === -1 || !best) {
      segments.push({ kind: 'text', text: rest });
      break;
    }
    if (bestIndex > 0) segments.push({ kind: 'text', text: rest.slice(0, bestIndex) });
    segments.push({
      kind: 'rig',
      text: rest.slice(bestIndex, bestIndex + best.rigName.length),
      bindingId: best.bindingId,
    });
    rest = rest.slice(bestIndex + best.rigName.length);
  }

  return segments;
}

/**
 * The per-rig line arrives prefixed with the rig it is about
 * ("rig-bike: Updated untitled-1.md today; …"). Inside that rig the prefix
 * is redundant twice over — the surface is the rig, and its header already
 * names it — and it forces the line onto a row of its own instead of
 * reading as a sentence. Matched against the known name rather than "any
 * word before a colon", so a line that legitimately opens with a clause
 * ending in a colon is never truncated.
 */
export function stripRigPrefix(line: string, rigName: string | null | undefined): string {
  if (!rigName) return line;
  const prefix = `${rigName}:`;
  if (!line.toLowerCase().startsWith(prefix.toLowerCase())) return line;
  return line.slice(prefix.length).trimStart();
}
