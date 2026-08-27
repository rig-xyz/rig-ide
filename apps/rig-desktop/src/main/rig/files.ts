import { type FSWatcher, watch as fsWatch } from 'node:fs';
import {
  access,
  mkdir,
  open,
  readdir,
  rename as fsRename,
  stat,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { err, ok, type Result } from '@emdash/shared';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import {
  rigFileChangeChannel,
  type RigFileError,
  type RigFileListError,
  type RigFileNode,
  type RigFileReadBinaryResult,
  type RigFileReadResult,
  type RigFileRenameError,
} from '@shared/rig/files';
import { rigFileRootRegistry } from './file-root-registry';
import { getFileTitle } from './file-title-cache';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const ARCHIVE_DIR = '_archive';
const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx']);
const IGNORED_NAMES = new Set(['.git', 'node_modules']);
const DEBOUNCE_MS = 200;

function isIgnored(name: string): boolean {
  return IGNORED_NAMES.has(name);
}
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
    // Directory entries that are symlinks are deliberately omitted. Direct
    // reads may follow a verified in-root link, but recursive listing must
    // never walk a link into another tree or a cycle.
    if (entry.isDirectory()) {
      // Same race rule as the stat below: an entry that vanishes between
      // the parent's readdir and our walk into it (an agent deleting or
      // renaming a folder mid-listing) is skipped, never a reason to fail
      // the WHOLE listing — that surfaced as an intermittent "Couldn't
      // read this rig's files" during agent write bursts.
      try {
        nodes.push({
          name: entry.name,
          relPath,
          kind: 'dir',
          children: await listDir(absPath, root),
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      }
    } else if (entry.isFile()) {
      const node: RigFileNode = { name: entry.name, relPath, kind: 'file' };
      try {
        node.mtimeMs = (await stat(absPath)).mtimeMs;
      } catch {
        /* race */
      }
      if (MARKDOWN_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        const title = await getFileTitle(absPath);
        if (title) node.title = title;
      }
      nodes.push(node);
    }
  }
  nodes.sort((a, b) =>
    a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : sortKey(a).localeCompare(sortKey(b))
  );
  return nodes;
}

type WatchEntry = { watcher: FSWatcher; refs: number; timer: NodeJS.Timeout | null };
// A root ID, rather than an absolute path, is the watcher identity and the
// only value emitted back to the renderer.
const watches = new Map<string, WatchEntry>();

function startWatch(rootId: string, root: string): boolean {
  const existing = watches.get(rootId);
  if (existing) {
    existing.refs += 1;
    return true;
  }
  try {
    const watcher = fsWatch(root, { recursive: true }, (_event, filename) => {
      if (filename && isIgnored(basename(filename.toString()))) return;
      const entry = watches.get(rootId);
      if (!entry) return;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        events.emit(rigFileChangeChannel, { rootId });
      }, DEBOUNCE_MS);
    });
    watches.set(rootId, { watcher, refs: 1, timer: null });
    watcher.on('error', (error) => {
      const entry = watches.get(rootId);
      if (!entry || entry.watcher !== watcher) return;
      if (entry.timer) clearTimeout(entry.timer);
      watches.delete(rootId);
      watcher.close();
      log.warn('Rig files: workspace watch stopped', {
        code: (error as NodeJS.ErrnoException)?.code,
      });
      events.emit(rigFileChangeChannel, { rootId });
    });
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    log.warn('Rig files: could not watch workspace root', { code });
    return false;
  }
}

function stopWatch(rootId: string, force = false): void {
  const entry = watches.get(rootId);
  if (!entry) return;
  if (!force) {
    entry.refs -= 1;
    if (entry.refs > 0) return;
  }
  if (entry.timer) clearTimeout(entry.timer);
  entry.watcher.close();
  watches.delete(rootId);
}

function invalidName(name: string): boolean {
  const value = name.trim();
  return (
    !value ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  );
}

function failure<T, E extends { kind: string; message: string }>(error: E): Result<T, E> {
  return err(error);
}
function mapRootError<T>(result: {
  success: false;
  error: { kind: string; message: string };
}): Result<T, RigFileError> {
  const kind: RigFileError['kind'] =
    result.error.kind === 'stale-root'
      ? 'staleRoot'
      : result.error.kind === 'outside-root'
        ? 'outsideRoot'
        : result.error.kind === 'invalid-path'
          ? 'invalidPath'
          : result.error.kind === 'not-found'
            ? 'notFound'
            : 'ioError';
  return failure({ kind, message: result.error.message });
}
async function existing(
  rootId: string,
  path: string,
  allowRoot = false
): Promise<Result<string, RigFileError>> {
  const result = await rigFileRootRegistry.resolveExisting(rootId, path, { allowRoot });
  return result.success ? ok(result.data) : mapRootError(result);
}
async function writable(
  rootId: string,
  path: string,
  allowRoot = false
): Promise<Result<string, RigFileError>> {
  const result = await rigFileRootRegistry.resolveWritable(rootId, path, { allowRoot });
  return result.success ? ok(result.data) : mapRootError(result);
}
async function mutableEntry(rootId: string, path: string): Promise<Result<string, RigFileError>> {
  const result = await rigFileRootRegistry.resolveMutableEntry(rootId, path);
  return result.success ? ok(result.data) : mapRootError(result);
}
function bounded(value: number | undefined): number {
  return value === undefined
    ? DEFAULT_MAX_BYTES
    : !Number.isFinite(value) || value < 0
      ? 0
      : Math.min(Math.floor(value), MAX_REQUEST_BYTES);
}
function errorDetails(error: unknown): { code?: string } {
  const typed = error as NodeJS.ErrnoException;
  return { code: typed?.code };
}

export const rigFilesController = createRPCController({
  list: async ({
    rootId,
  }: {
    rootId: string;
  }): Promise<Result<RigFileNode[], RigFileListError>> => {
    const root = await existing(rootId, '', true);
    if (!root.success) return root;
    try {
      if (!(await stat(root.data)).isDirectory())
        return failure({ kind: 'notADirectory', message: 'Not a directory.' });
      return ok(await listDir(root.data, root.data));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
        return failure({ kind: 'notFound', message: 'Folder not found.' });
      log.warn('Rig files: list failed', errorDetails(error));
      return failure({ kind: 'ioError', message: 'Could not read this folder.' });
    }
  },
  read: async ({
    rootId,
    relativePath,
    maxBytes,
  }: {
    rootId: string;
    relativePath: string;
    maxBytes?: number;
  }): Promise<Result<RigFileReadResult, RigFileError>> => {
    const target = await existing(rootId, relativePath);
    if (!target.success) return target;
    try {
      const info = await stat(target.data);
      if (!info.isFile()) return failure({ kind: 'notFound', message: 'Not a file.' });
      const limit = bounded(maxBytes);
      const length = Math.min(info.size, limit);
      const buffer = Buffer.alloc(length);
      let bytesRead = 0;
      if (length) {
        const handle = await open(target.data, 'r');
        try {
          ({ bytesRead } = await handle.read(buffer, 0, length, 0));
        } finally {
          await handle.close();
        }
      }
      // StringDecoder holds back an incomplete trailing UTF-8 sequence, so
      // the byte cap never produces a replacement character or reads ahead.
      const content = new StringDecoder('utf8').write(buffer.subarray(0, bytesRead));
      return ok({ content, truncated: info.size > bytesRead });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
        return failure({ kind: 'notFound', message: 'File not found.' });
      log.warn('Rig files: read failed', errorDetails(error));
      return failure({ kind: 'ioError', message: 'Could not read this file.' });
    }
  },
  write: async ({
    rootId,
    relativePath,
    content,
  }: {
    rootId: string;
    relativePath: string;
    content: string;
  }): Promise<Result<{ relativePath: string }, RigFileError>> => {
    const target = await writable(rootId, relativePath);
    if (!target.success) return target;
    try {
      await fsWriteFile(target.data, content, 'utf8');
      const normalized = rigFileRootRegistry.normalizeRelative(relativePath);
      return ok({ relativePath: normalized.success ? normalized.data : relativePath });
    } catch (error) {
      log.warn('Rig files: write failed', errorDetails(error));
      return failure({ kind: 'ioError', message: 'Could not save this file.' });
    }
  },
  readBinary: async ({
    rootId,
    relativePath,
    maxBytes,
  }: {
    rootId: string;
    relativePath: string;
    maxBytes: number;
  }): Promise<Result<RigFileReadBinaryResult, RigFileError>> => {
    const target = await existing(rootId, relativePath);
    if (!target.success) return target;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      const info = await stat(target.data);
      if (!info.isFile()) return failure({ kind: 'notFound', message: 'Not a file.' });
      const limit = bounded(maxBytes);
      const length = Math.min(info.size, limit);
      const buffer = Buffer.alloc(length);
      if (length) {
        handle = await open(target.data, 'r');
        const read = await handle.read(buffer, 0, length, 0);
        return ok({
          data: buffer.subarray(0, read.bytesRead).toString('base64'),
          truncated: info.size > read.bytesRead,
          size: info.size,
        });
      }
      return ok({ data: '', truncated: info.size > 0, size: info.size });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
        return failure({ kind: 'notFound', message: 'File not found.' });
      log.warn('Rig files: readBinary failed', errorDetails(error));
      return failure({ kind: 'ioError', message: 'Could not read this file.' });
    } finally {
      await handle?.close();
    }
  },
  rename: async ({
    rootId,
    relativePath,
    newName,
  }: {
    rootId: string;
    relativePath: string;
    newName: string;
  }): Promise<Result<{ relativePath: string }, RigFileRenameError>> => {
    if (invalidName(newName))
      return failure({ kind: 'invalidName', message: 'That name is not valid.' });
    const source = await mutableEntry(rootId, relativePath);
    if (!source.success) return source;
    const parent = relativePath.split(/[\\/]/).slice(0, -1).join('/');
    const targetRelative = parent ? `${parent}/${newName.trim()}` : newName.trim();
    const target = await writable(rootId, targetRelative);
    if (!target.success) return target;
    if (
      target.data !== source.data &&
      (await access(target.data)
        .then(() => true)
        .catch(() => false))
    )
      return failure({
        kind: 'alreadyExists',
        message: 'Something with that name already exists.',
      });
    try {
      await fsRename(source.data, target.data);
      return ok({ relativePath: targetRelative });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
        return failure({ kind: 'notFound', message: 'Not found.' });
      log.warn('Rig files: rename failed', errorDetails(error));
      return failure({ kind: 'ioError', message: 'Could not rename this.' });
    }
  },
  archive: async ({
    rootId,
    relativePath,
  }: {
    rootId: string;
    relativePath: string;
  }): Promise<Result<{ relativePath: string }, RigFileRenameError>> => {
    const source = await mutableEntry(rootId, relativePath);
    if (!source.success) return source;
    if (!relativePath || relativePath === ARCHIVE_DIR || relativePath.startsWith(`${ARCHIVE_DIR}/`))
      return failure({ kind: 'invalidName', message: 'That item cannot be archived.' });
    const archive = await writable(rootId, ARCHIVE_DIR, true);
    if (!archive.success) return archive;
    try {
      await mkdir(archive.data, { recursive: true });
      const name = basename(relativePath);
      const ext = extname(name);
      const stem = ext ? name.slice(0, -ext.length) : name;
      let targetRelative = `${ARCHIVE_DIR}/${name}`;
      let target = join(archive.data, name);
      for (
        let n = 2;
        await access(target)
          .then(() => true)
          .catch(() => false);
        n += 1
      ) {
        targetRelative = `${ARCHIVE_DIR}/${stem}-${n}${ext}`;
        target = join(archive.data, `${stem}-${n}${ext}`);
      }
      const safeTarget = await writable(rootId, targetRelative);
      if (!safeTarget.success) return safeTarget;
      await fsRename(source.data, safeTarget.data);
      return ok({ relativePath: targetRelative });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
        return failure({ kind: 'notFound', message: 'Not found.' });
      log.warn('Rig files: archive failed', errorDetails(error));
      return failure({ kind: 'ioError', message: 'Could not archive this.' });
    }
  },
  makeDirectory: async ({
    rootId,
    name,
  }: {
    rootId: string;
    name: string;
  }): Promise<Result<{ relativePath: string }, RigFileRenameError>> => {
    if (invalidName(name))
      return failure({ kind: 'invalidName', message: 'That name is not valid.' });
    const relativePath = name.trim();
    const target = await writable(rootId, relativePath);
    if (!target.success) return target;
    if (
      await access(target.data)
        .then(() => true)
        .catch(() => false)
    )
      return failure({
        kind: 'alreadyExists',
        message: 'Something with that name already exists.',
      });
    try {
      await mkdir(target.data);
      return ok({ relativePath });
    } catch (error) {
      log.warn('Rig files: mkdir failed', errorDetails(error));
      return failure({ kind: 'ioError', message: 'Could not create that folder.' });
    }
  },
  watch: async ({ rootId }: { rootId: string }): Promise<Result<void, RigFileError>> => {
    const root = await rigFileRootRegistry.getVerified(rootId);
    if (!root.success) return mapRootError(root);
    if (!startWatch(rootId, root.data))
      return failure({ kind: 'ioError', message: 'Could not watch this folder.' });
    return ok<void>();
  },
  unwatch: ({ rootId }: { rootId: string }): Result<void, RigFileError> => {
    stopWatch(rootId);
    return ok<void>();
  },
  releaseRoot: ({ rootId }: { rootId: string }): Result<void, RigFileError> => {
    stopWatch(rootId, true);
    rigFileRootRegistry.release(rootId);
    return ok<void>();
  },
});
