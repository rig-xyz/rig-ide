import type { FileTreeFilter, FileTreeSort } from './settings';
import type { RigFileNode } from './files';

/**
 * File-navigator redesign (`docs/file-navigator-design.md` §5): pure sort +
 * filter math for the tree — no IO, no React, no clock of its own (the
 * caller passes `now`). `renderer/features/workspace/file-tree.tsx` applies
 * these AFTER `filterContentTree`'s system/skills split, so the tree stays
 * a single well-ordered pass: filter what's shown, then order what's left.
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
  /** Every relPath this app has observed an agent session write, live, this launch (`write-activity.ts`). */
  agentWrittenFiles: ReadonlySet<string>;
  now: number;
};

function titleOf(node: RigFileNode): string {
  return node.kind === 'dir' ? node.name : (node.title ?? node.name);
}

function isUnseen(node: RigFileNode, ctx: TreeViewContext): boolean {
  if (node.kind === 'file') return ctx.unseenFiles.has(node.relPath);
  for (const child of node.children ?? []) {
    if (isUnseen(child, ctx)) return true;
  }
  return false;
}

function fileScore(node: RigFileNode, sort: FileTreeSort, ctx: TreeViewContext): number {
  if (sort === 'newest') return node.mtimeMs ?? 0;
  return frecencyScore(node.mtimeMs, ctx.seen[node.relPath], ctx.now);
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
 * order WITHIN each kind changes. `'alphabetical'` is a pure title
 * comparison with no scoring at all; every other mode falls back to
 * alphabetical as its tie-break.
 */
export function sortTree(nodes: readonly RigFileNode[], sort: FileTreeSort, ctx: TreeViewContext): RigFileNode[] {
  if (sort === 'alphabetical') return sortAlphabetical(nodes);

  return [...nodes]
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      if (sort === 'unseenFirst') {
        const aUnseen = isUnseen(a, ctx) ? 1 : 0;
        const bUnseen = isUnseen(b, ctx) ? 1 : 0;
        if (aUnseen !== bUnseen) return bUnseen - aUnseen;
      }
      const scoreDiff = bestScore(b, sort, ctx) - bestScore(a, sort, ctx);
      if (scoreDiff !== 0) return scoreDiff;
      return titleOf(a).localeCompare(titleOf(b));
    })
    .map((node) => (node.kind === 'dir' ? { ...node, children: sortTree(node.children ?? [], sort, ctx) } : node));
}

/**
 * Removes files that don't match `filter`, dropping any folder left with no
 * matching descendant (same "a container that exists solely to hold hidden
 * content is itself clutter" rule `filterContentTree` already applies for
 * System/Skills). `'all'` is a no-op passthrough.
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
    const matches =
      filter === 'unseen' ? ctx.unseenFiles.has(node.relPath) : ctx.agentWrittenFiles.has(node.relPath);
    if (matches) out.push(node);
  }
  return out;
}
