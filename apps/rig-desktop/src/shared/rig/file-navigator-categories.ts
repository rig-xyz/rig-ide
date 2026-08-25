/**
 * File-navigator redesign (`docs/file-navigator-design.md` §1): pure
 * path-based classification into the tree's three entry categories.
 * Shared (not renderer-only) because `relPathFromRoot` is plain string
 * math with no browser/node dependency, and both the tree
 * (`renderer/features/workspace/file-tree.tsx`) and the artifact view's
 * skill banner (`renderer/features/artifact/artifact-view.tsx`) need the
 * same classification of the same `relPath`.
 *
 * Order matters: Skills is checked BEFORE the generic dotfile/dot-dir
 * System catch-all, since `.claude/skills/**` and `.claude/commands/**`
 * live inside a dotfile-prefixed path that would otherwise read as System
 * — the design doc's explicit carve-out ("NOT .claude/.agents skills,
 * which are Skills above").
 */

import type { RigFileNode } from './files';

export type FileNavigatorCategory = 'content' | 'skills' | 'system';

const SKILL_BASENAMES = new Set(['AGENTS.md', 'CLAUDE.md']);

/** `.claude/skills/…`, `.agents/skills/…`, `.claude/commands/…` — at any depth, not just the root. */
function isUnderSkillDir(segments: string[]): boolean {
  for (let i = 0; i < segments.length - 1; i++) {
    const dir = segments[i];
    const next = segments[i + 1];
    if ((dir === '.claude' || dir === '.agents') && next === 'skills') return true;
    if (dir === '.claude' && next === 'commands') return true;
  }
  return false;
}

export function classifyEntryCategory(relPath: string): FileNavigatorCategory {
  const segments = relPath.split('/').filter((part) => part.length > 0);
  if (segments.length === 0) return 'content';
  const base = segments[segments.length - 1];

  if (SKILL_BASENAMES.has(base) || isUnderSkillDir(segments)) return 'skills';

  if (base === 'rig.toml') return 'system';
  if (segments[0] === '.rig') return 'system';
  if (segments.some((part) => part.startsWith('.'))) return 'system';

  return 'content';
}

/** Same relPath derivation `breadcrumb.ts` uses — a plain prefix strip, no `node:path` (renderer-safe). */
export function relPathFromRoot(root: string, absPath: string): string {
  const rel = absPath.startsWith(root) ? absPath.slice(root.length).replace(/^\/+/, '') : absPath;
  return rel;
}

/**
 * Navigator v2 (`docs/file-navigator-design.md` §3.2): the strict content
 * filter for anything that must be structurally immune to the "Show system
 * files" toggle — Suggested candidates, the header's unseen chip count, and
 * Smart sort's scoring inputs. Unlike the tree's own DISPLAY filter
 * (`file-tree.tsx`'s `filterContentTree`, which reveals system files behind
 * the toggle), this always drops both `skills` and `system` entries — the
 * round-1 bug (`daemon.log`/`state.local.db` surfacing as a suggestion) must
 * be structurally impossible at this boundary, not a render-time guard.
 */
export function filterToContentOnly(nodes: readonly RigFileNode[]): RigFileNode[] {
  const out: RigFileNode[] = [];
  for (const node of nodes) {
    if (classifyEntryCategory(node.relPath) !== 'content') continue;
    if (node.kind === 'dir') {
      out.push({ ...node, children: filterToContentOnly(node.children ?? []) });
    } else {
      out.push(node);
    }
  }
  return out;
}
