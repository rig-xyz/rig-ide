/**
 * Owner-only files: a space's agent instructions (CLAUDE.md, AGENTS.md,
 * skills, slash commands, subagents). They sync to everyone, but the relay
 * refuses a change to them from anyone but the space's owner (tap
 * `core/src/sync/path.ts` `isOwnerOnlyPath`, enforced in relay
 * `repos/changes.ts`), and tapd keeps the refused edit on that computer as
 * `not_synced` with reason `owner_only`. This mirrors the core matcher so the
 * editor can say so before anyone types: keep the two lists in step.
 *
 * Matched case-insensitively and at any depth, like core.
 */

/** File names only the owner may change, wherever they appear. */
const OWNER_ONLY_FILES = new Set(['claude.md', 'agents.md']);
/** Directories only the owner may change, and everything below them. */
const OWNER_ONLY_DIRS: ReadonlyArray<readonly [string, string]> = [
  ['.claude', 'skills'],
  ['.claude', 'commands'],
  ['.claude', 'agents'],
  ['.agents', 'skills'],
];

/** What a non-owner reads on an owner-only file. */
export const OWNER_ONLY_LINE = 'Only the space’s owner can change this file.';

/** True if only the space's owner may change `relPath` (space-relative, forward slashes). */
export function isOwnerOnlyPath(relPath: string): boolean {
  const segs = relPath.normalize('NFC').toLowerCase().split('/');
  if (OWNER_ONLY_FILES.has(segs[segs.length - 1]!)) return true;
  for (let i = 0; i + 1 < segs.length; i++) {
    if (OWNER_ONLY_DIRS.some(([a, b]) => segs[i] === a && segs[i + 1] === b)) return true;
  }
  return false;
}

/**
 * Whether this person can't change `relPath`: it's owner-only and their role
 * on the space is known and isn't owner. An unknown role (a local rig, the
 * relay unreachable) leaves the file editable, as before.
 */
export function isLockedForRole(role: string | null | undefined, relPath: string): boolean {
  return !!role && role !== 'owner' && isOwnerOnlyPath(relPath);
}
