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
 *
 * The actual scan-and-boundary engine (`linkFileMentions` itself, plus the
 * `FileMentionSegment`/`FileMentionIndex` shapes) now lives in the neutral
 * `@renderer/lib/file-mentions` — moved there so the Home pulse narration's
 * OWN file-mention linking (`features/home/pulse-file-mentions.ts`, a
 * different candidate source: resolved main-side rather than from an
 * already-loaded tree) can reuse it instead of forking a second matcher.
 * Re-exported here unchanged so this module's own callers (and its test
 * file) don't need to know that split happened.
 */

import type { RigFileNode } from '@shared/rig/files';
import {
  linkFileMentions,
  type FileMentionCandidate,
  type FileMentionIndex,
  type FileMentionSegment,
} from '@renderer/lib/file-mentions';
import { detectByExtension } from '../artifact/file-type';

export { linkFileMentions, type FileMentionSegment, type FileMentionIndex };

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
  const candidates: FileMentionCandidate[] = [];
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
