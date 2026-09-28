import { safeMessagePath } from './attachments';

/**
 * `+path` file tags in chat messages: the composer writes them, the
 * transcript shows them as file chips, the agent dispatcher lists them as
 * "Mentioned" files. One syntax everywhere:
 *
 *   +notes/plan.md          a plain path: only `[\w./-]`, with a `.` or `/`
 *                           in it, not ending in `.` or `/` (so "+1" and a
 *                           sentence's full stop never read as a tag)
 *   +"Q3 board deck.pdf"    anything else, in double quotes (a path with a
 *                           `"` or a line break can't be tagged)
 *
 * A tag starts at the text's start or after something that isn't a word
 * character or `+` ("C++", "a+b" stay text). Paths are space-relative and
 * pass the same guard as attachments (no `..`, nothing absolute).
 */

/** A plain (unquoted) tag's path: word segments joined by `.` or `/`. */
const PLAIN_PATH = String.raw`(?:[\w-]+[./])+[\w-]+|[\w-]*\.[\w-]+`;
const PLAIN_WHOLE = new RegExp(`^(?:${PLAIN_PATH})$`);

/** Whether `path` can be written without quotes (and reads back as the same tag): plain shape, and a letter in it ("+1.5" is a number). */
function plainTaggable(path: string): boolean {
  return PLAIN_WHOLE.test(path) && /[A-Za-z]/.test(path);
}

/** The tag for a space-relative path, or null when it can't be tagged. */
export function formatFileTag(path: string): string | null {
  if (!safeMessagePath(path) || /["\n\r]/.test(path)) return null;
  return plainTaggable(path) ? `+${path}` : `+"${path}"`;
}

/**
 * The regex source for one tag: group 1 is a quoted path, group 2 a plain
 * one. Plain paths stop before trailing `.`/`/` (sentence punctuation).
 */
export const FILE_TAG_SOURCE = String.raw`(?<![\w+])\+(?:"([^"\n\r]+)"|(${PLAIN_PATH}))`;

export type FileTagMatch = { path: string; index: number; length: number };

/** The tagged path from a regex match of `FILE_TAG_SOURCE`, or null when it isn't a safe space path. */
export function tagPathOf(match: RegExpExecArray, quotedGroup: number, plainGroup: number): string | null {
  const quoted = match[quotedGroup];
  const plain = match[plainGroup];
  if (plain && !/[A-Za-z]/.test(plain)) return null;
  const raw = quoted ?? plain;
  return raw ? (safeMessagePath(raw) ?? null) : null;
}

/** Every file tag in `text`, in order; unsafe ones (`..`, absolute) are skipped. */
export function parseFileTags(text: string): FileTagMatch[] {
  const pattern = new RegExp(FILE_TAG_SOURCE, 'g');
  const out: FileTagMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const path = tagPathOf(match, 1, 2);
    if (path) out.push({ path, index: match.index, length: match[0].length });
  }
  return out;
}

export type TaggableFile = { relPath: string; name: string; mtimeMs?: number };

function subsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i += 1;
  return i === needle.length;
}

/**
 * The composer's file suggestions for what's typed after `+`: by name first
 * (starts with, then contains, then fuzzy), then by path; with nothing typed,
 * the most recently changed first. At most `limit`.
 */
export function rankTaggableFiles(files: readonly TaggableFile[], query: string, limit = 200): TaggableFile[] {
  const q = query.toLowerCase();
  if (!q) return [...files].sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0)).slice(0, limit);
  const scored: Array<{ file: TaggableFile; score: number }> = [];
  for (const file of files) {
    const name = file.name.toLowerCase();
    const path = file.relPath.toLowerCase();
    const score = name.startsWith(q)
      ? 5
      : name.includes(q)
        ? 4
        : subsequence(q, name)
          ? 3
          : path.includes(q)
            ? 2
            : subsequence(q, path)
              ? 1
              : 0;
    if (score > 0) scored.push({ file, score });
  }
  scored.sort((a, b) => b.score - a.score || (b.file.mtimeMs ?? 0) - (a.file.mtimeMs ?? 0) || a.file.relPath.localeCompare(b.file.relPath));
  return scored.slice(0, limit).map((s) => s.file);
}
