import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, link, lstat, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENTS_DIR,
  SPACE_QUOTA_BYTES,
  type AttachmentCommitted,
  type AttachmentError,
  type AttachmentInput,
  type AttachmentPastedImage,
  type AttachmentPrepareResult,
  type AttachmentSpaceCheck,
} from '@shared/rig/attachments';
import {
  findSameContent,
  hashFile,
  inspectAttachment,
  loadSpaceContext,
  MESSAGES,
  type Inspected,
  type SpaceContext,
} from './inspect';
import { foldName, numberedName, sanitizeAttachmentName } from './names';
import { needsSyncException, withSyncExceptions } from './rules';
import { spaceUsage, type UsageDeps } from './usage';

/**
 * Chat attachments, main side (board 19). `prepare` answers what each chip
 * says before anything is copied; `commit` copies at send time (never on
 * pick, so an abandoned draft leaves nothing behind). Only the exact files
 * passed in are ever read: no folder is walked, a symlink is followed only to
 * copy what it points at.
 */

export type AttachmentsDeps = UsageDeps & {
  /** This computer's folder for the space, or null when it isn't linked here. */
  resolveSpaceRoot: (bindingId: string) => Promise<string | null>;
  /** Your role in the space (`owner`/`editor`/`viewer`), or null when it can't be read right now. */
  role: (bindingId: string) => Promise<string | null>;
  /** Where pasted images are written before they're attached. */
  pasteDir: () => string;
  now?: () => Date;
  limitBytes?: number;
};

/** A commit stopped for a reason the chip should show (not an I/O failure). */
class CommitRefused extends Error {
  constructor(readonly detail: AttachmentError) {
    super(detail.message);
  }
}

const USAGE_TTL_MS = 20_000;
const PASTE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STAGING_DIR = join('.rig', 'attachments-staging');
const PASTE_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/tiff': '.tiff',
};

const NOT_LINKED = 'This space isn’t on this computer yet — Link it to add files.';
const VIEWER = 'Viewers can’t add files. Ask an owner or editor.';
const USAGE_UNKNOWN = 'Couldn’t check how full the space is. Try again when you’re online.';

function mb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function quotaMessage(used: number, limit: number): string {
  return `This would put the space over its ${mb(limit)} (at ${mb(used)} now).`;
}

function copyFailure(error: unknown, source: string): AttachmentError {
  const code = (error as NodeJS.ErrnoException)?.code;
  const message =
    code === 'ENOSPC'
      ? 'The disk is full.'
      : code === 'EACCES' || code === 'EPERM'
        ? 'Rig couldn’t write to the space folder (permission denied).'
        : code === 'ENOENT'
          ? 'This file isn’t there anymore.'
          : 'Rig couldn’t copy this file into the space.';
  return { kind: 'copyFailed', message, source };
}

export function createAttachmentsService(deps: AttachmentsDeps) {
  const limit = deps.limitBytes ?? SPACE_QUOTA_BYTES;
  const now = deps.now ?? (() => new Date());
  const usageCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof spaceUsage>> }>();

  async function usageFor(bindingId: string, root: string, fresh: boolean) {
    const cached = usageCache.get(bindingId);
    if (!fresh && cached && now().getTime() - cached.at < USAGE_TTL_MS) return cached.value;
    const value = await spaceUsage(deps, bindingId, root);
    usageCache.set(bindingId, { at: now().getTime(), value });
    return value;
  }

  /** Linked here and not a viewer; a role that can't be read right now doesn't block. */
  async function spaceGate(bindingId: string): Promise<{ root: string } | { status: 'viewer' | 'notLinked'; message: string }> {
    const [root, role] = await Promise.all([deps.resolveSpaceRoot(bindingId), deps.role(bindingId).catch(() => null)]);
    if (!root) return { status: 'notLinked', message: NOT_LINKED };
    if (role === 'viewer') return { status: 'viewer', message: VIEWER };
    return { root };
  }

  async function prepare(bindingId: string, files: AttachmentInput[]): Promise<AttachmentPrepareResult> {
    const gate = await spaceGate(bindingId);
    if (!('root' in gate)) {
      const space: AttachmentSpaceCheck = {
        status: gate.status,
        message: gate.message,
        usedBytes: null,
        usageSource: null,
        limitBytes: limit,
        addingBytes: 0,
        overQuota: false,
      };
      return { space, files: [] };
    }
    const ctx = await loadSpaceContext(gate.root);
    const claimed = new Set<string>();
    const verdicts = [];
    for (const file of files) verdicts.push((await inspectAttachment(file, ctx, claimed)).verdict);
    const adding = verdicts
      .filter((v) => v.disposition === 'copy' && v.state !== 'blocked')
      .reduce((sum, v) => sum + (v.size ?? 0), 0);
    const usage = await usageFor(bindingId, gate.root, false);
    const overQuota = adding > 0 && (usage === null || usage.usedBytes + adding > limit);
    return {
      space: {
        status: 'ok',
        usedBytes: usage?.usedBytes ?? null,
        usageSource: usage?.source ?? null,
        limitBytes: limit,
        addingBytes: adding,
        overQuota,
        ...(overQuota ? { quotaMessage: usage ? quotaMessage(usage.usedBytes, limit) : USAGE_UNKNOWN } : {}),
      },
      files: verdicts,
    };
  }

  /** Appends the attachment sync exceptions to the space's `.tapignore` when any are missing. */
  async function ensureSyncExceptions(root: string): Promise<void> {
    const path = join(root, '.tapignore');
    let existing: string | null = null;
    try {
      existing = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
    const next = withSyncExceptions(existing);
    if (next !== null) await writeFile(path, next, 'utf8');
  }

  /**
   * Puts `staged` into `attachments/` under the first free name, never over
   * an existing file: a hard link claims the name atomically (EEXIST on a
   * clash, including a case-only clash on macOS), and the sync daemon never
   * sees a half-written file. Without hard links, an exclusive copy.
   */
  async function place(ctx: SpaceContext, staged: string, name: string): Promise<string> {
    for (let n = 1; n <= 1000; n += 1) {
      const candidate = numberedName(name, n);
      if (ctx.existing.has(foldName(candidate))) continue;
      const target = join(ctx.root, ATTACHMENTS_DIR, candidate);
      try {
        await link(staged, target);
        return candidate;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === 'EEXIST') continue;
        if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV') throw error;
      }
      try {
        await copyFile(staged, target, fsConstants.COPYFILE_EXCL);
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      }
    }
    throw Object.assign(new Error('no free name'), { code: 'EEXIST' });
  }

  async function commit(bindingId: string, files: AttachmentInput[]): Promise<Result<AttachmentCommitted[], AttachmentError>> {
    if (files.length === 0) return ok([]);
    const gate = await spaceGate(bindingId);
    if (!('root' in gate)) return err({ kind: gate.status, message: gate.message });
    const ctx = await loadSpaceContext(gate.root);

    // Check everything before copying anything.
    const claimed = new Set<string>();
    const inspected = [];
    for (const file of files) {
      const item = await inspectAttachment(file, ctx, claimed);
      if (item.verdict.state === 'blocked' || !item.target) {
        return err({ kind: 'blocked', message: item.verdict.problems[0]?.message ?? 'This file can’t be attached.', source: file.source });
      }
      inspected.push(item);
    }
    const adding = inspected
      .filter((i) => i.verdict.disposition === 'copy')
      .reduce((sum, i) => sum + (i.verdict.size ?? 0), 0);
    if (adding > 0) {
      const usage = await usageFor(bindingId, gate.root, true);
      if (!usage) return err({ kind: 'overQuota', message: USAGE_UNKNOWN });
      if (usage.usedBytes + adding > limit) return err({ kind: 'overQuota', message: quotaMessage(usage.usedBytes, limit) });
    }

    // Files this commit created, removed again if a later one fails (a failed send leaves nothing behind).
    const created: string[] = [];
    const staging = join(ctx.root, STAGING_DIR, randomUUID());
    const results: AttachmentCommitted[] = [];
    try {
      if (inspected.some((i) => i.verdict.disposition === 'copy' && needsSyncException(i.verdict.storedName))) {
        await ensureSyncExceptions(ctx.root);
      }
      for (const item of inspected) results.push(await commitOne(ctx, item, staging, created));
      return ok(results);
    } catch (error) {
      for (const path of created) await unlink(path).catch(() => {});
      if (error instanceof CommitRefused) return err(error.detail);
      return err(copyFailure(error, inspected[results.length]?.verdict.source ?? files[0]!.source));
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function commitOne(ctx: SpaceContext, item: Inspected, staging: string, created: string[]): Promise<AttachmentCommitted> {
    const v = item.verdict;
    const size = v.size ?? 0;
    const base = { source: v.source, size, mime: v.mime };
    if (v.disposition === 'link' || v.disposition === 'reuse') {
      return { ...base, path: v.linkPath!, name: v.storedName, hash: await item.hash(), kind: 'linked' };
    }
    if (v.disposition === 'localOnly') {
      return {
        ...base,
        path: v.linkPath ?? item.target!,
        name: v.linkPath ? v.storedName : v.name,
        hash: size <= ATTACHMENT_MAX_BYTES ? await item.hash() : null,
        kind: 'local-only',
      };
    }
    const dir = join(ctx.root, ATTACHMENTS_DIR);
    await mkdir(dir, { recursive: true });
    if (!(await lstat(dir)).isDirectory()) {
      throw new CommitRefused({ kind: 'invalid', message: 'The space has an “attachments” item that isn’t a folder.', source: v.source });
    }
    // Copy what's on disk now (it may have changed since the chip was made), then decide on the copy.
    await mkdir(staging, { recursive: true });
    const staged = join(staging, randomUUID());
    await copyFile(item.target!, staged, fsConstants.COPYFILE_EXCL);
    const copiedSize = (await stat(staged)).size;
    if (copiedSize > ATTACHMENT_MAX_BYTES) {
      throw new CommitRefused({ kind: 'blocked', message: MESSAGES.tooLarge, source: v.source });
    }
    const hash = await hashFile(staged);
    const same = await findSameContent(ctx, copiedSize, async () => hash);
    if (same) return { ...base, size: copiedSize, path: `${ATTACHMENTS_DIR}/${same}`, name: same, hash, kind: 'linked' };
    const stored = await place(ctx, staged, v.name);
    created.push(join(dir, stored));
    ctx.existing.set(foldName(stored), { name: stored, size: copiedSize });
    return { ...base, size: copiedSize, path: `${ATTACHMENTS_DIR}/${stored}`, name: stored, hash, kind: 'copied' };
  }

  /** A pasted image (clipboard bytes) → a temp file named after the time, ready to attach. */
  async function savePastedImage(args: { data: Uint8Array; mime: string; name?: string }): Promise<Result<AttachmentPastedImage, AttachmentError>> {
    const ext = PASTE_EXT[args.mime.toLowerCase()];
    if (!ext) return err({ kind: 'invalid', message: 'Only images can be pasted as attachments.' });
    if (args.data.byteLength > ATTACHMENT_MAX_BYTES) {
      return err({ kind: 'blocked', message: MESSAGES.tooLarge });
    }
    const at = now();
    const hh = String(at.getHours()).padStart(2, '0');
    const mm = String(at.getMinutes()).padStart(2, '0');
    const name = sanitizeAttachmentName(args.name?.trim() || `Screenshot ${hh}.${mm}${ext}`);
    const root = deps.pasteDir();
    await cleanOldPastes(root, at.getTime());
    const dir = join(root, randomUUID());
    try {
      await mkdir(dir, { recursive: true });
      const path = join(dir, name);
      await writeFile(path, args.data, { flag: 'wx' });
      return ok({ path, name, size: args.data.byteLength });
    } catch (error) {
      return err(copyFailure(error, ''));
    }
  }

  return { prepare, commit, savePastedImage };
}

async function cleanOldPastes(root: string, nowMs: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry);
    try {
      if (nowMs - (await stat(path)).mtimeMs > PASTE_MAX_AGE_MS) await rm(path, { recursive: true, force: true });
    } catch {
      // raced
    }
  }
}

export type AttachmentsService = ReturnType<typeof createAttachmentsService>;

