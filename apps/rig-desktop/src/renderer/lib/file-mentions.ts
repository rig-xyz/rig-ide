/**
 * Shared core of the file-mention matcher. Originally written once, for
 * chat's `linkFileMentions` (`features/chat/link-file-mentions.ts` — still
 * the canonical doc comment for WHY the boundary rules below exist: quote/
 * bold/backtick delimiters read as neutral boundaries, a `..` escape is
 * rejected, a trailing sentence period doesn't get swallowed, etc.). Moved
 * here so a second consumer — the Home pulse narration's file-mention
 * linking (`features/home/pulse-file-mentions.ts`) — can scan against its
 * OWN candidate index (resolved main-side, not from an already-loaded file
 * tree) without forking these rules. Chat re-exports `linkFileMentions`
 * unchanged from here, so its own tests keep passing untouched.
 *
 * PURE: no IO, no Electron/IPC imports.
 */

export type FileMentionSegment = {
  text: string;
  /** Set when this segment is a clickable file mention. */
  path?: string;
};

export type FileMentionCandidate = {
  /** The literal string to search for. */
  pattern: string;
  /** What a match resolves to — opaque to this module (a relPath for every caller so far). */
  relPath: string;
};

export type FileMentionIndex = {
  readonly candidates: readonly FileMentionCandidate[];
};

/** Characters that mean "this position is a continuation of a longer token, not a clean boundary." */
const CONTINUATION = /[A-Za-z0-9_/-]/;

function leftBoundaryOk(text: string, start: number): boolean {
  if (start === 0) return true;
  const ch = text[start - 1];
  return !(CONTINUATION.test(ch) || ch === '.');
}

function rightBoundaryOk(text: string, end: number): boolean {
  const ch = text[end];
  if (ch === undefined) return true;
  if (CONTINUATION.test(ch)) return false;
  if (ch === '.') {
    // A single trailing period reads as end-of-sentence punctuation UNLESS
    // it's immediately followed by more word characters (a real extension
    // continuation, e.g. matching "notes.md" inside "notes.md.bak").
    const next = text[end + 1];
    return !(next !== undefined && /[A-Za-z0-9]/.test(next));
  }
  return true;
}

/**
 * Scans `text` for mentions of anything in `index` and returns it split into
 * segments — `path` set means "clickable", unset means "plain text".
 * Concatenating every segment's `text` in order always reconstructs `text`
 * exactly. `index.candidates` is expected pattern-length-descending (each
 * caller's own index builder sorts it) so a candidate whose pattern is a
 * prefix of another's never steals a match meant for the longer one; ties
 * at the same start position resolve to whichever was checked first, i.e.
 * the longer one.
 */
export function linkFileMentions(text: string, index: FileMentionIndex): FileMentionSegment[] {
  if (!text || index.candidates.length === 0) return [{ text }];

  const segments: FileMentionSegment[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    let matched: { start: number; end: number; relPath: string } | null = null;

    for (const { pattern, relPath } of index.candidates) {
      const idx = text.indexOf(pattern, cursor);
      if (idx === -1) continue;
      if (matched && idx >= matched.start) continue; // already have an earlier (or equal-and-longer) match
      if (!leftBoundaryOk(text, idx)) continue;
      const end = idx + pattern.length;
      if (!rightBoundaryOk(text, end)) continue;
      if (!matched || idx < matched.start) matched = { start: idx, end, relPath };
    }

    if (!matched) break;

    if (matched.start > cursor) segments.push({ text: text.slice(cursor, matched.start) });
    segments.push({ text: text.slice(matched.start, matched.end), path: matched.relPath });
    cursor = matched.end;
  }

  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments.length > 0 ? segments : [{ text }];
}
