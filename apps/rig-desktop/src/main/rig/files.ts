import { type FSWatcher, watch as fsWatch } from 'node:fs';
import { open, readdir, readFile, stat, writeFile as fsWriteFile } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
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
  type RigFileWriteError,
} from '@shared/rig/files';

/**
 * Real filesystem access for the workspace screen's file tree and the doc
 * editor — scoped to a bound rig workspace's own folder, not the emdash
 * project/workspace registry (see `shared/rig/files.ts`).
 */

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
/** Entries the recursive listing never descends into or shows. */
const IGNORED_NAMES = new Set(['.git', '.rig', 'node_modules']);

function isIgnored(name: string): boolean {
  return IGNORED_NAMES.has(name) || name.startsWith('.');
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
      nodes.push({ name: entry.name, relPath, kind: 'file' });
    }
    // Symlinks and other special entries are skipped rather than followed.
  }
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
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

  /** Idempotent, refcounted: call once per mounted workspace screen / doc tab. */
  watch: (root: string): void => startWatch(root),
  unwatch: (root: string): void => stopWatch(root),
});
