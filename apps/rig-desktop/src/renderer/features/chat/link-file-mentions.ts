/**
 * linkFileMentions — the real matcher behind chat-ui's
 * `ChatCommands.linkFileMentions` (`packages/chat-ui/src/commands.ts`): scans
 * plain assistant prose (and tool-call header text) for mentions of files
 * that actually exist in the open rig's file tree, splitting the input into
 * segments so chat-ui can promote the matching pieces into clickable file
 * links — same target/click behavior as a real markdown link resolved by
 * `classifyProseLink` (this file's sibling).
 *
 * Founder-dogfooding case this exists to fix: the assistant finishes a "Done
 * — I created ..." message naming a file it just wrote, as either a bare
 * relative path, a quoted/bold filename, or (in a tool-call header) an
 * absolute path under the workspace root — none of which render as a real
 * markdown link, so `classifyProseLink` alone never gets a chance to run.
 *
 * ── Matching rules ───────────────────────────────────────────────────────
 *  - A bare occurrence of a file's full `relPath` is always a candidate.
 *  - A bare occurrence of a file's basename is a candidate ONLY when that
 *    basename is unique across the whole (linkable) tree — an ambiguous
 *    basename (two files sharing a name in different folders) is never
 *    linked from a basename alone, only via its full relPath.
 *  - A leading `./` immediately before either of the above is included in
 *    the match (so `./docs/notes.md` links as a whole), but a `..` escape,
 *    or any other character butted up against the candidate on either side
 *    (letters, digits, `_`, `-`, `.`, `/`) disqualifies it — this is what
 *    keeps `user-guide.md` from matching `guide.md`, and a URL's path
 *    segment from matching a same-named workspace file.
 *  - Wrapping the mention in `"…"`, `'…'`, or markdown bold (`**…**`) needs
 *    no special handling here: quote/asterisk characters are not
 *    "continuation" characters, so the boundary check already treats them as
 *    valid edges, and bold text arrives as its own already-isolated run from
 *    chat-ui — see that package's `apply-file-mentions.ts`.
 *  - An absolute path starting with the open rig's workspace root resolves
 *    to its relPath and is linked the same way.
 *  - Only files whose extension the artifact pane can actually show are
 *    indexed (`detectByExtension`'s `markdown`/`text` categories — reusing
 *    the SAME allowlist as the file tree/artifact pane, not a new one); a
 *    match against a file outside the tree, or a real URL/email, is never
 *    produced because nothing outside the index is ever a candidate string.
 *  - The longest matching candidate wins at a given position (checked via
 *    length-descending candidate order), so a file whose name is a prefix of
 *    another indexed file's name never steals a match meant for the longer one.
 *
 * This module is PURE: no IO, no Electron/IPC imports — `buildFileMentionIndex`
 * takes the SAME `RigFileNode[]` tree `classifyProseLink`/`file-tree.tsx` use.
 */

import type { RigFileNode } from '@shared/rig/files';
import { detectByExtension } from '../artifact/file-type';

export type FileMentionSegment = {
  text: string;
  /** Set when this segment is a clickable file mention; a workspace-relative path. */
  path?: string;
};

type Candidate = {
  /** The literal string to search for. */
  pattern: string;
  /** The workspace-relative path a match resolves to. */
  relPath: string;
};

export type FileMentionIndex = {
  readonly candidates: readonly Candidate[];
};

/** Characters that mean "this position is a continuation of a longer token, not a clean boundary." */
const CONTINUATION = /[A-Za-z0-9_/-]/;

function isLinkableFile(relPath: string): boolean {
  const detected = detectByExtension(relPath);
  return detected?.category === 'markdown' || detected?.category === 'text';
}

function collectFiles(nodes: readonly RigFileNode[], out: RigFileNode[]): void {
  for (const node of nodes) {
    if (node.kind === 'file') {
      if (isLinkableFile(node.relPath)) out.push(node);
    } else if (node.children) {
      collectFiles(node.children, out);
    }
  }
}

/**
 * Builds the candidate index from the SAME `RigFileNode[]` tree the file
 * tree/artifact pane already show. `workspaceRoot` (the open rig's absolute
 * path, no trailing slash) additionally indexes each linkable file's
 * absolute path — pass it when known so an absolute-path mention (a
 * tool-call header, e.g.) resolves too; omit it to skip that.
 */
export function buildFileMentionIndex(
  tree: readonly RigFileNode[],
  workspaceRoot?: string
): FileMentionIndex {
  const files: RigFileNode[] = [];
  collectFiles(tree, files);

  const byBasename = new Map<string, string[]>();
  for (const f of files) {
    const basename = f.name;
    const list = byBasename.get(basename);
    if (list) list.push(f.relPath);
    else byBasename.set(basename, [f.relPath]);
  }

  const root = workspaceRoot?.replace(/\/+$/, '');
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const add = (pattern: string, relPath: string): void => {
    // Same pattern string can legitimately resolve two different ways only
    // if the tree itself is inconsistent; first-wins, and in practice this
    // only ever de-dupes a relPath candidate against itself.
    const key = pattern;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ pattern, relPath });
  };

  for (const f of files) {
    add(f.relPath, f.relPath);
    add(`./${f.relPath}`, f.relPath);
    if (root) add(`${root}/${f.relPath}`, f.relPath);
  }
  for (const [basename, relPaths] of byBasename) {
    if (relPaths.length !== 1) continue; // ambiguous — only the full relPath links
    add(basename, relPaths[0]);
    add(`./${basename}`, relPaths[0]);
  }

  // Longest pattern first so a longer, more specific candidate is tried
  // before a shorter one that happens to be its suffix/prefix.
  candidates.sort((a, b) => b.pattern.length - a.pattern.length);

  return { candidates };
}

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
 * Scans `text` for workspace-file mentions and returns it split into
 * segments — `path` set means "clickable", unset means "plain text".
 * Concatenating every segment's `text` in order always reconstructs `text`
 * exactly. Never called on text inside a fenced code block (chat-ui's own
 * contract — see `packages/chat-ui/src/commands.ts`).
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
