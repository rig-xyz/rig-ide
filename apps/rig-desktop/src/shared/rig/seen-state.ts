import { defineEvent } from '../lib/ipc/events';
import type { RigFileNode } from './files';

/**
 * File-navigator redesign (`docs/file-navigator-design.md` §4): seen-state —
 * a per-user, per-rig, LOCAL-ONLY "last viewed" map. `main/rig/seen-state.ts`
 * owns the DB reads/writes (`rig_seen_files`, keyed by bindingId+relPath,
 * see `main/db/schema.ts`); everything in THIS file is pure path/timestamp
 * math with no IO, so it can be unit-tested directly against constructed
 * `RigFileNode` fixtures (same convention as `file-navigator-categories.ts`).
 */

/** relPath -> last-viewed epoch ms. One map per rig; the caller already knows which bindingId it's for. */
export type SeenMap = Record<string, number>;

/**
 * A file counts unseen when it changed after the LATER of: the user's own
 * last view of it, or — if never viewed — the rig's first-local-open
 * baseline. Without the baseline fallback, every file that already existed
 * the first time the rig was opened would dot up as "unseen" on day one.
 * `mtimeMs` absent (stat failed, or a node predating this field) never
 * flags unseen — there's nothing honest to compare against.
 */
export function isFileUnseen(
  mtimeMs: number | undefined,
  seenAt: number | undefined,
  baselineAt: number
): boolean {
  if (mtimeMs === undefined) return false;
  const threshold = seenAt ?? baselineAt;
  return mtimeMs > threshold;
}

export type UnseenSummary = {
  /** Every unseen FILE's relPath. */
  unseenFiles: Set<string>;
  /** Every DIR relPath whose subtree has at least one unseen file, mapped to that count. Zero-count dirs are simply absent. */
  unseenCountByDir: Record<string, number>;
};

/**
 * One pass over a listed tree: which files are unseen, and how many unseen
 * descendants each folder rolls up. Pure — the caller supplies the seen map
 * and baseline; this never reaches for the clock or the DB itself.
 */
export function computeUnseenSummary(
  nodes: RigFileNode[],
  seen: SeenMap,
  baselineAt: number
): UnseenSummary {
  const unseenFiles = new Set<string>();
  const unseenCountByDir: Record<string, number> = {};

  function walk(list: RigFileNode[]): number {
    let count = 0;
    for (const node of list) {
      if (node.kind === 'dir') {
        const childCount = walk(node.children ?? []);
        if (childCount > 0) unseenCountByDir[node.relPath] = childCount;
        count += childCount;
      } else if (isFileUnseen(node.mtimeMs, seen[node.relPath], baselineAt)) {
        unseenFiles.add(node.relPath);
        count += 1;
      }
    }
    return count;
  }

  walk(nodes);
  return { unseenFiles, unseenCountByDir };
}

/** Every FILE relPath in a listed tree, any depth, any category — the "mark all as seen" / ghost-row-sweep input. */
export function collectFileRelPaths(nodes: RigFileNode[]): string[] {
  const out: string[] = [];
  const walk = (list: RigFileNode[]) => {
    for (const node of list) {
      if (node.kind === 'dir') {
        walk(node.children ?? []);
      } else {
        out.push(node.relPath);
      }
    }
  };
  walk(nodes);
  return out;
}

/** Broadcast whenever `main/rig/seen-state.ts` writes for a rig — a mark-seen elsewhere (e.g. "Mark all as seen") should update any open tree for the same bindingId. */
export const rigSeenStateChangedChannel = defineEvent<{ bindingId: string }>('rig:seen-state-changed');
