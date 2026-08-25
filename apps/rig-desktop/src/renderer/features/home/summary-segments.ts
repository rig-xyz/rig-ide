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

/** Something in the prose a reader should be able to click through to. */
export type SummaryTarget =
  | { kind: 'rig'; bindingId: string }
  | { kind: 'file'; relPath: string };

/** A name the narration might mention, and where clicking it should go. */
export type SummaryLink = { match: string; target: SummaryTarget };

export type SummarySegment =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; target: SummaryTarget };

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
 * Splits the cleaned summary on every name the reader can actually open —
 * their rigs, and the files the narration cites. Longest name first, so
 * `rig-bike-old` is never matched as `rig-bike` plus a stray `-old`, and
 * `untitled-1.md` never as `untitled-1`. Matching is case-insensitive
 * while the text shown stays exactly as the model wrote it.
 */
export function summarySegments(summary: string, links: readonly SummaryLink[]): SummarySegment[] {
  const cleaned = stripIdentifiers(summary);
  if (!cleaned) return [];

  const candidates = links
    .filter((link) => link.match.trim().length > 0)
    .sort((a, b) => b.match.length - a.match.length);
  if (candidates.length === 0) return [{ kind: 'text', text: cleaned }];

  const segments: SummarySegment[] = [];
  let rest = cleaned;

  while (rest.length > 0) {
    let bestIndex = -1;
    let best: SummaryLink | null = null;
    for (const link of candidates) {
      const index = rest.toLowerCase().indexOf(link.match.toLowerCase());
      if (index === -1) continue;
      // Earliest match wins; ties go to the longer name, which
      // `candidates` already orders first.
      if (bestIndex === -1 || index < bestIndex) {
        bestIndex = index;
        best = link;
      }
    }
    if (bestIndex === -1 || !best) {
      segments.push({ kind: 'text', text: rest });
      break;
    }
    if (bestIndex > 0) segments.push({ kind: 'text', text: rest.slice(0, bestIndex) });
    segments.push({
      kind: 'link',
      text: rest.slice(bestIndex, bestIndex + best.match.length),
      target: best.target,
    });
    rest = rest.slice(bestIndex + best.match.length);
  }

  return segments;
}

/** Every rig the briefing knows about, as link candidates. */
export function rigLinks(
  rigs: readonly { bindingId: string; rigName: string }[]
): SummaryLink[] {
  return rigs.map((rig) => ({ match: rig.rigName, target: { kind: 'rig', bindingId: rig.bindingId } }));
}

/**
 * Files as link candidates, matched on BASENAME: the narration writes
 * "untitled-1.md", never the full relative path, but clicking has to open
 * the real file, so the path travels in the target while the basename does
 * the matching.
 */
export function fileLinks(files: readonly { relPath: string }[]): SummaryLink[] {
  return files.map((file) => ({
    match: file.relPath.split('/').pop() ?? file.relPath,
    target: { kind: 'file', relPath: file.relPath },
  }));
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
