import { classifyEntryCategory } from './file-navigator-categories';
import type { FileTreeFilter, FileTreeSort } from './settings';
import type { RigFileNode } from './files';

/**
 * File-navigator redesign (`docs/file-navigator-design.md` §5, re-specced
 * §3.4 in the v2 round): pure sort + filter math for the tree — no IO, no
 * React, no clock of its own (the caller passes `now`).
 * `renderer/features/workspace/file-tree.tsx` applies these AFTER
 * `filterContentTree`'s system/skills split, so the tree stays a single
 * well-ordered pass: filter what's shown, then order what's left.
 *
 * v2 round: sort modes renamed to match the header's labels exactly —
 * `'smart'` (was `'workingSet'`), `'modified'` (was `'newest'`), `'name'`
 * (was `'alphabetical'`). The old standalone `'unseenFirst'` sort mode is
 * gone — §3.4 folds its effect INTO Smart as an "unseen boost" instead
 * (`UNSEEN_BOOST` below), and unseen-only visibility is the header chip's
 * `filter: 'unseen'` job now, not a sort mode's.
 */

const HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

function decay(ageMs: number): number {
  if (ageMs <= 0) return 1;
  return Math.pow(0.5, ageMs / HALF_LIFE_MS);
}

/**
 * Recency-weighted blend of the user's own opens (seen-state's last-viewed
 * timestamp) and the file's own change time — equal-weighted, since
 * `rig_seen_files` stores one timestamp per path, not an open COUNT, so
 * there's no frequency signal to lean on the way a browser's real
 * "frecency" would. A file touched by either signal recently scores high;
 * one touched by neither decays toward zero.
 */
export function frecencyScore(
  mtimeMs: number | undefined,
  lastViewedAt: number | undefined,
  now: number
): number {
  const changeScore = mtimeMs !== undefined ? decay(now - mtimeMs) : 0;
  const viewScore = lastViewedAt !== undefined ? decay(now - lastViewedAt) : 0;
  return changeScore * 0.5 + viewScore * 0.5;
}

export type TreeViewContext = {
  /** relPath -> last-viewed epoch ms (`rig_seen_files`, slice 3). */
  seen: Readonly<Record<string, number>>;
  /** Every currently-unseen FILE relPath (slice 3's `computeUnseenSummary`). */
  unseenFiles: ReadonlySet<string>;
  now: number;
};

function titleOf(node: RigFileNode): string {
  return node.kind === 'dir' ? node.name : (node.title ?? node.name);
}

/**
 * Added to a file's frecency under Smart when it's currently unseen —
 * larger than `frecencyScore`'s own [0, 1] range, so an unseen file always
 * outranks every seen one while still tie-breaking by frecency WITHIN the
 * unseen group (§3.4: "frecency blend with an unseen boost", replacing the
 * old hard-partitioned `'unseenFirst'` sort mode).
 */
const UNSEEN_BOOST = 1;

function fileScore(node: RigFileNode, sort: FileTreeSort, ctx: TreeViewContext): number {
  if (sort === 'modified') return node.mtimeMs ?? 0;
  // Smart (§3.4): "content only" — a system/skills file (only ever visible
  // here because "Show system files" is on; Skills never reach the main
  // tree at all) never earns a ranking of its own under Smart, so it can't
  // bubble a folder up by its recency. It still DISPLAYS (this only zeroes
  // its score, it doesn't filter it out) — Modified/Name are unaffected.
  if (classifyEntryCategory(node.relPath) !== 'content') return 0;
  const base = frecencyScore(node.mtimeMs, ctx.seen[node.relPath], ctx.now);
  return ctx.unseenFiles.has(node.relPath) ? base + UNSEEN_BOOST : base;
}

/** A folder's own rank: the best (max) score among ALL descendant files, at any depth — "folders sort by their best descendant." */
function bestScore(node: RigFileNode, sort: FileTreeSort, ctx: TreeViewContext): number {
  if (node.kind === 'file') return fileScore(node, sort, ctx);
  let best = -Infinity;
  for (const child of node.children ?? []) {
    best = Math.max(best, bestScore(child, sort, ctx));
  }
  return best === -Infinity ? 0 : best;
}

function sortAlphabetical(nodes: readonly RigFileNode[]): RigFileNode[] {
  return [...nodes]
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return titleOf(a).localeCompare(titleOf(b));
    })
    .map((node) => (node.kind === 'dir' ? { ...node, children: sortAlphabetical(node.children ?? []) } : node));
}

/**
 * Returns a NEW tree with every `children` array re-ordered per `sort`.
 * Folders always sort ahead of files within the same directory (matches
 * the tree's existing convention, unaffected by sort mode) — only the
 * order WITHIN each kind changes. `'name'` is a pure title comparison with
 * no scoring at all; `'smart'`/`'modified'` fall back to it as their tie-break.
 */
export function sortTree(nodes: readonly RigFileNode[], sort: FileTreeSort, ctx: TreeViewContext): RigFileNode[] {
  if (sort === 'name') return sortAlphabetical(nodes);

  return [...nodes]
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      const scoreDiff = bestScore(b, sort, ctx) - bestScore(a, sort, ctx);
      if (scoreDiff !== 0) return scoreDiff;
      return titleOf(a).localeCompare(titleOf(b));
    })
    .map((node) => (node.kind === 'dir' ? { ...node, children: sortTree(node.children ?? [], sort, ctx) } : node));
}

/**
 * Header search field (§3.1): live, case-insensitive substring match on
 * title + filename — files only (a folder survives when it contains a
 * matching descendant, same "a container that exists solely to hold hidden
 * content is itself clutter" rule `filterTree`/`filterContentTree` already
 * apply). An empty/whitespace-only query is a no-op passthrough.
 */
export function searchTree(nodes: readonly RigFileNode[], query: string): RigFileNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...nodes];

  const out: RigFileNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'dir') {
      const children = searchTree(node.children ?? [], query);
      if (children.length > 0) out.push({ ...node, children });
      continue;
    }
    const title = (node.title ?? node.name).toLowerCase();
    const filename = node.name.toLowerCase();
    if (title.includes(q) || filename.includes(q)) out.push(node);
  }
  return out;
}

/**
 * Header's contextual "N new" chip (§3.1): `'unseen'` keeps only unseen
 * files, dropping any folder left with no matching descendant (same "a
 * container that exists solely to hold hidden content is itself clutter"
 * rule `filterContentTree` already applies for System/Skills). `'all'` is a
 * no-op passthrough. The old `'agents'` mode is gone — §3.1: "'Changed by
 * agents' surfaces as reasons in Suggested, not as a filter."
 */
export function filterTree(
  nodes: readonly RigFileNode[],
  filter: FileTreeFilter,
  ctx: TreeViewContext
): RigFileNode[] {
  if (filter === 'all') return [...nodes];

  const out: RigFileNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'dir') {
      const filteredChildren = filterTree(node.children ?? [], filter, ctx);
      if (filteredChildren.length > 0) out.push({ ...node, children: filteredChildren });
      continue;
    }
    if (ctx.unseenFiles.has(node.relPath)) out.push(node);
  }
  return out;
}
