import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { AttachmentFileStatus, AttachmentStatusQuery } from '@shared/rig/attachments';
import { readSyncState } from './usage';
import type { ManifestSize } from './usage';

/**
 * Where each attached file is, for the message cards: here on this computer
 * or not, synced by the sync daemon or not (its state file's hash for the
 * path equals the attachment's, with no local change pending), held back by
 * the daemon (over the space's quota), and on the relay's file list, deleted
 * from it, or never on it (to tell "arriving", "removed" and "not shared
 * yet" apart when it isn't here).
 *
 * Paths come from messages other people wrote, so each must be a plain
 * relative path inside the space; anything else is answered as missing.
 */

export type StatusDeps = {
  resolveSpaceRoot: (bindingId: string) => Promise<string | null>;
  /** The relay's current file list (cached by the caller), or null when unreachable. */
  fetchManifest: (bindingId: string) => Promise<ManifestSize[] | null>;
};

/** A safe space-relative path (forward slashes), or null. */
export function safeRelativePath(input: string): string | null {
  if (!input || input.includes('\0') || input.includes('\\') || isAbsolute(input) || /^[a-z]:/i.test(input)) return null;
  const parts = input.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  if (parts[0] === '.rig') return null;
  return parts.join('/');
}

/** The file's absolute path, only when it resolves inside the space's real folder. */
export async function resolveInSpace(root: string, relPath: string): Promise<string | null> {
  const safe = safeRelativePath(relPath);
  if (!safe) return null;
  try {
    const realRoot = await realpath(root);
    const target = await realpath(join(realRoot, ...safe.split('/')));
    const rel = relative(realRoot, target);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    return target;
  } catch {
    return null;
  }
}

export async function attachmentStatus(
  deps: StatusDeps,
  bindingId: string,
  files: AttachmentStatusQuery[],
  opts: { withRelay: boolean }
): Promise<AttachmentFileStatus[] | null> {
  const root = await deps.resolveSpaceRoot(bindingId);
  if (!root) return null;
  const state = await readSyncState(root);
  const manifest = opts.withRelay ? await deps.fetchManifest(bindingId).catch(() => null) : null;
  const onRelay = manifest ? new Set(manifest.filter((entry) => !entry.deleted).map((entry) => entry.path)) : null;
  const deletedOnRelay = new Set(manifest?.filter((entry) => entry.deleted).map((entry) => entry.path) ?? []);
  const out: AttachmentFileStatus[] = [];
  for (const query of files) {
    const safe = safeRelativePath(query.path);
    if (!safe) {
      out.push({ path: query.path, exists: false, synced: null, onRelay: null });
      continue;
    }
    const abs = await resolveInSpace(root, safe);
    let exists = false;
    if (abs) {
      try {
        exists = (await stat(abs)).isFile();
      } catch {
        exists = false;
      }
    }
    const record = state?.paths.get(safe);
    const synced = state
      ? !!record && !record.dirty && (!query.hash || record.hash === query.hash)
      : null;
    const held = state?.notSynced.get(safe);
    const status: AttachmentFileStatus = { path: query.path, exists, synced, onRelay: onRelay ? onRelay.has(safe) : null };
    if (deletedOnRelay.has(safe)) status.deletedOnRelay = true;
    if (held && (!query.hash || !held.hash || held.hash === query.hash)) {
      status.notSynced = held.reason === 'file_too_large' ? 'tooLarge' : 'overQuota';
    }
    out.push(status);
  }
  return out;
}
