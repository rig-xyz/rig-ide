import { type FSWatcher, watch as fsWatch } from 'node:fs';
import { access, mkdir, open, readdir, readFile, rename as fsRename, stat, writeFile as fsWriteFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { events } from '@main/lib/events';
import {
  rigFileChangeChannel,
  type RigFileListError,
  type RigFileNode,
  type RigFileReadBinaryResult,
  type RigFileReadError,
  type RigFileReadResult,
  type RigFileRenameError,
  type RigFileWriteError,
} from '@shared/rig/files';
import { getFileTitle } from './file-title-cache';

/**
 * Real filesystem access for the workspace screen's file tree and the doc
 * editor — scoped to a bound rig workspace's own folder, not the emdash
 * project/workspace registry (see `shared/rig/files.ts`).
 */

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
/** Where the row menu's "Archive" moves things — one folder at the rig root, visible to everyone the rig is shared with. */
const ARCHIVE_DIR = '_archive';
const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx']);
/**
 * Entries the recursive listing never descends into or shows, regardless
 * of the file navigator's "Show system files" toggle (`shared/rig/
 * file-navigator-categories.ts` classifies both as System, but the toggle
 * only reveals what's actually LISTED here). `node_modules` was already
 * excluded unconditionally before the navigator redesign; `.git` joins it
 * as a deliberate deviation from the redesign's own example list (which
 * names `.git` as a dotfile the toggle should reveal) — this walk is
 * eager (every directory's `children` is recursed and returned in full on
 * every `list` call, not lazily on expand), and `.git`'s object store can
 * be enormous and is never something an agent-produced-document navigator
 * needs to browse. `.rig` no longer gets this special-cased exclusion: it's
 * a normal dotfile now, System-classified and toggle-revealed like any
 * other.
 */
const IGNORED_NAMES = new Set(['.git', 'node_modules']);

function isIgnored(name: string): boolean {
  return IGNORED_NAMES.has(name);
}

/**
 * Sort key: folders first, then files, both by FILENAME A-Z (locale
 * compare). Navigator v3 shows filenames rather than extracted titles, and
 * sort order has to agree with what the row actually says, so this sorts on
 * the same string the row displays (`file-tree.tsx`'s `displayName`).
 */
function sortKey(node: RigFileNode): string {
  return node.name;
}

async function listDir(absDir: string, root: string): Promise<RigFileNode[]> {
  const entries = await readdir(absDir, { withFileTypes: true });
  const nodes: RigFileNode[] = [];
  for (const entry of entries) {
    if (isIgnored(entry.name)) continue;
    const absPath = join(absDir, entry.name);
    const relPath = relative(root, absPath).split(sep).join('/');
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        relPath,
        kind: 'dir',
        children: await listDir(absPath, root),
      });
    } else if (entry.isFile()) {
      const node: RigFileNode = { name: entry.name, relPath, kind: 'file' };
      try {
        node.mtimeMs = (await stat(absPath)).mtimeMs;
      } catch {
        // Best-effort — a file that vanished between readdir and stat just
        // ships without an mtime; it's never flagged unseen without one.
      }
      if (MARKDOWN_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        const title = await getFileTitle(absPath);
        if (title) node.title = title;
      }
      nodes.push(node);
    }
    // Symlinks and other special entries are skipped rather than followed.
  }
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return sortKey(a).localeCompare(sortKey(b));
  });
  return nodes;
}

// ── change watching ─────────────────────────────────────────────────────────

type WatchEntry = { watcher: FSWatcher; refs: number; timer: NodeJS.Timeout | null };
const watches = new Map<string, WatchEntry>();
const DEBOUNCE_MS = 200;

function startWatch(root: string): void {
  const existing = watches.get(root);
  if (existing) {
    existing.refs += 1;
    return;
  }
  try {
    const watcher = fsWatch(root, { recursive: true }, (_event, filename) => {
      // Ignore churn under directories the listing itself never shows — the
      // watcher would otherwise notify on every `.git` index write.
      if (filename && isIgnored(basename(filename.toString()))) return;
      const entry = watches.get(root);
      if (!entry) return;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        events.emit(rigFileChangeChannel, { root });
      }, DEBOUNCE_MS);
    });
    watches.set(root, { watcher, refs: 1, timer: null });
  } catch (error) {
    log.warn('Rig files: could not watch workspace root', { root, error: String(error) });
  }
}

function stopWatch(root: string): void {
  const entry = watches.get(root);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.watcher.close();
  watches.delete(root);
}

// ── controller ───────────────────────────────────────────────────────────────

export const rigFilesController = createRPCController({
  /** Recursive listing of a rig workspace root, ignoring `.git`/`.rig`/`node_modules`/dotfiles. */
  list: async (root: string): Promise<Result<RigFileNode[], RigFileListError>> => {
    try {
      const info = await stat(root);
      if (!info.isDirectory()) {
        return err<RigFileListError>({ kind: 'notADirectory', message: 'Not a directory.' });
      }
      return ok(await listDir(root, root));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        return err<RigFileListError>({ kind: 'notFound', message: 'Folder not found.' });
      }
      log.warn('Rig files: list failed', { root, error: String(error) });
      return err<RigFileListError>({ kind: 'ioError', message: 'Could not read this folder.' });
    }
  },

  read: async (
    absPath: string,
    maxBytes = DEFAULT_MAX_BYTES
  ): Promise<Result<RigFileReadResult, RigFileReadError>> => {
    try {
      const info = await stat(absPath);
      if (info.size > maxBytes) {
        const buffer = await readFile(absPath, { encoding: 'utf8', flag: 'r' });
        return ok({ content: buffer.slice(0, maxBytes), truncated: true });
      }
      const content = await readFile(absPath, 'utf8');
      return ok({ content, truncated: false });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        return err<RigFileReadError>({ kind: 'notFound', message: 'File not found.' });
      }
      log.warn('Rig files: read failed', { absPath, error: String(error) });
      return err<RigFileReadError>({ kind: 'ioError', message: 'Could not read this file.' });
    }
  },

  write: async (absPath: string, content: string): Promise<Result<void, RigFileWriteError>> => {
    try {
      await fsWriteFile(absPath, content, 'utf8');
      return ok<void>();
    } catch (error) {
      log.warn('Rig files: write failed', { absPath, error: String(error) });
      return err<RigFileWriteError>({ kind: 'ioError', message: 'Could not save this file.' });
    }
  },

  /**
   * Round (beyond-markdown): a raw-bytes read, base64-encoded, for the
   * artifact view's image loader and its binary sniff on an unrecognized
   * extension (`file-type.ts`). A TRUE partial read via `fs.open`/`.read`
   * with an explicit length — not `readFile` sliced afterward (`read`,
   * above, does that, which is fine for a small text file but would pull
   * an entire multi-hundred-MB unknown blob into memory just to sniff its
   * first 4KB). `size` is the file's real total size regardless of
   * `maxBytes`, so a caller can tell "truncated because huge" apart from
   * "this genuinely is the whole file."
   */
  readBinary: async (
    absPath: string,
    maxBytes: number
  ): Promise<Result<RigFileReadBinaryResult, RigFileReadError>> => {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      const info = await stat(absPath);
      if (!info.isFile()) {
        return err<RigFileReadError>({ kind: 'notFound', message: 'Not a file.' });
      }
      const readLength = Math.min(info.size, maxBytes);
      const buffer = Buffer.alloc(readLength);
      if (readLength > 0) {
        handle = await open(absPath, 'r');
        await handle.read(buffer, 0, readLength, 0);
      }
      return ok({ data: buffer.toString('base64'), truncated: info.size > maxBytes, size: info.size });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        return err<RigFileReadError>({ kind: 'notFound', message: 'File not found.' });
      }
      log.warn('Rig files: readBinary failed', { absPath, error: String(error) });
      return err<RigFileReadError>({ kind: 'ioError', message: 'Could not read this file.' });
    } finally {
      await handle?.close();
    }
  },

  /**
   * Navigator v2 (§3.3, row context menu "Rename"): renames an entry (file
   * or folder) in place within its own parent directory — `newName` is a
   * bare name, never a path, so the target can only ever land back in the
   * SAME directory `absPath` is already in (no traversal to worry about
   * beyond rejecting a name that tries to carry one). No overwrite: a
   * pre-existing target is a hard error, never silently replaced. The
   * tree's own live `fs.watch` already picks up the rename and refetches —
   * nothing further to broadcast here.
   */
  rename: async (absPath: string, newName: string): Promise<Result<{ path: string }, RigFileRenameError>> => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.includes('/') || trimmed.includes('\\')) {
      return err<RigFileRenameError>({ kind: 'invalidName', message: 'That name is not valid.' });
    }
    const targetPath = join(dirname(absPath), trimmed);
    if (targetPath !== absPath) {
      const exists = await access(targetPath)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        return err<RigFileRenameError>({ kind: 'alreadyExists', message: 'Something with that name already exists.' });
      }
    }
    try {
      await fsRename(absPath, targetPath);
      return ok({ path: targetPath });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        return err<RigFileRenameError>({ kind: 'notFound', message: 'Not found.' });
      }
      log.warn('Rig files: rename failed', { absPath, targetPath, error: String(error) });
      return err<RigFileRenameError>({ kind: 'ioError', message: 'Could not rename this.' });
    }
  },

  /**
   * Navigator v3 (row menu "Archive"): moves an entry into `_archive/` at
   * the rig root, creating that folder on first use. Archiving is a real
   * move on disk, not a hidden flag — the file stays in the rig, stays
   * synced, and a collaborator sees it move rather than vanish, which is
   * the honest behaviour for a folder everyone shares. Getting something
   * back is a plain drag or a Rename away.
   *
   * `root` is passed explicitly rather than derived by walking up for a
   * `rig.toml`, so the destination can never escape the workspace the
   * caller is actually looking at. A name collision inside `_archive/`
   * gets a numeric suffix instead of overwriting whatever is already
   * archived under that name.
   */
  archive: async (root: string, absPath: string): Promise<Result<{ path: string }, RigFileRenameError>> => {
    const relToRoot = relative(root, absPath);
    if (!relToRoot || relToRoot.startsWith('..') || relToRoot.split(sep)[0] === ARCHIVE_DIR) {
      return err<RigFileRenameError>({ kind: 'invalidName', message: 'That item cannot be archived.' });
    }
    const archiveDir = join(root, ARCHIVE_DIR);
    try {
      await mkdir(archiveDir, { recursive: true });
    } catch (error) {
      log.warn('Rig files: could not create archive folder', { archiveDir, error: String(error) });
      return err<RigFileRenameError>({ kind: 'ioError', message: 'Could not create the archive folder.' });
    }

    const name = basename(absPath);
    const ext = extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    let targetPath = join(archiveDir, name);
    for (let n = 2; ; n += 1) {
      const exists = await access(targetPath)
        .then(() => true)
        .catch(() => false);
      if (!exists) break;
      targetPath = join(archiveDir, `${stem}-${n}${ext}`);
    }

    try {
      await fsRename(absPath, targetPath);
      return ok({ path: targetPath });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') return err<RigFileRenameError>({ kind: 'notFound', message: 'Not found.' });
      log.warn('Rig files: archive failed', { absPath, targetPath, error: String(error) });
      return err<RigFileRenameError>({ kind: 'ioError', message: 'Could not archive this.' });
    }
  },

  /**
   * Navigator v3 (the New menu's "New folder"): creates one folder directly
   * under `root`. `name` is a bare name, never a path, so a new folder can
   * only ever land at the top level of the rig the user is looking at. An
   * existing folder of that name is an error rather than a silent no-op:
   * "New folder" that quietly selects someone else's folder is worse than
   * one that says the name is taken.
   */
  makeDirectory: async (root: string, name: string): Promise<Result<{ path: string }, RigFileRenameError>> => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.includes('/') || trimmed.includes('\\')) {
      return err<RigFileRenameError>({ kind: 'invalidName', message: 'That name is not valid.' });
    }
    const targetPath = join(root, trimmed);
    const exists = await access(targetPath)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      return err<RigFileRenameError>({ kind: 'alreadyExists', message: 'Something with that name already exists.' });
    }
    try {
      await mkdir(targetPath);
      return ok({ path: targetPath });
    } catch (error) {
      log.warn('Rig files: mkdir failed', { targetPath, error: String(error) });
      return err<RigFileRenameError>({ kind: 'ioError', message: 'Could not create that folder.' });
    }
  },

  /** Idempotent, refcounted: call once per mounted workspace screen / doc tab. */
  watch: (root: string): void => startWatch(root),
  unwatch: (root: string): void => stopWatch(root),
});
