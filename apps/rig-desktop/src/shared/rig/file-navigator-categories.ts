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
