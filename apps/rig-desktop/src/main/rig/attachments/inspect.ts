import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, join, relative, sep, isAbsolute } from 'node:path';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENTS_DIR,
  type AttachmentDisposition,
  type AttachmentInput,
  type AttachmentProblem,
  type AttachmentVerdict,
} from '@shared/rig/attachments';
import { foldName, mimeOf, numberedName, sanitizeAttachmentName } from './names';
import { pdfPageCount, SECRET_SCAN_BYTES, secretReason, syncIgnoreMatcher } from './rules';

/**
 * One picked file → its chip verdict. Reads only the file it was given (its
 * first KB for the secret check, the whole file to hash it when a same-size
 * attachment already exists, PDFs to count pages), plus the listing of the
 * space's `attachments/` folder and its `.tapignore`.
 */

const MAX_NUMBERED = 1000;
const PDF_COUNT_MAX_BYTES = ATTACHMENT_MAX_BYTES;

export const MESSAGES = {
  tooLarge: 'Attachments can be up to 25 MB each. Trim it, or share a link.',
  secret: 'This looks like a secret. Everyone in the space (and their agents) would get it.',
  secretLocal: 'This looks like a secret. It stays on your computer, but your agent would read it.',
  localOnly: 'Only on your computer: sync never shares this kind of file. Your own agent can still read it.',
  folder: 'Folders can’t be attached yet — drop it into Files.',
  missing: 'This file isn’t there anymore.',
  unreadable: 'Rig can’t read this file.',
} as const;

/** The space as `inspect` needs it: its real root, what's in `attachments/`, and the sync rules. */
export type SpaceContext = {
  root: string;
  /** Files directly in `attachments/`: folded name → { name, size }. */
  existing: Map<string, { name: string; size: number }>;
  isSyncIgnored: (relPath: string) => boolean;
};

export async function loadSpaceContext(rootPath: string): Promise<SpaceContext> {
  const root = await realpath(rootPath);
  const existing = new Map<string, { name: string; size: number }>();
  const dir = join(root, ATTACHMENTS_DIR);
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    // no attachments folder yet
  }
  for (const name of names) {
    try {
      const info = await lstat(join(dir, name));
      existing.set(foldName(name), { name, size: info.isFile() ? info.size : -1 });
    } catch {
      // vanished mid-listing
    }
  }
  let tapignore: string | null = null;
  try {
    tapignore = await readFile(join(root, '.tapignore'), 'utf8');
  } catch {
    // none
  }
  return { root, existing, isSyncIgnored: syncIgnoreMatcher(tapignore) };
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return `sha256:${hash.digest('hex')}`;
}

/** An attachment already in `attachments/` with exactly this content, found by size first, then hash. */
export async function findSameContent(
  space: SpaceContext,
  size: number,
  hashOf: () => Promise<string>
): Promise<string | null> {
  const candidates = [...space.existing.values()].filter((entry) => entry.size === size);
  if (candidates.length === 0) return null;
  const wanted = await hashOf();
  for (const candidate of candidates) {
    try {
      if ((await hashFile(join(space.root, ATTACHMENTS_DIR, candidate.name))) === wanted) return candidate.name;
    } catch {
      // unreadable or gone: not a match
    }
  }
  return null;
}

/** The first "name", "name (2)"… not already in `attachments/` (case-insensitively) nor in `claimed`. */
export function freeName(space: SpaceContext, name: string, claimed: ReadonlySet<string> = new Set()): string {
  for (let n = 1; n <= MAX_NUMBERED; n += 1) {
    const candidate = numberedName(name, n);
    const key = foldName(candidate);
    if (!space.existing.has(key) && !claimed.has(key)) return candidate;
  }
  return numberedName(name, Date.now());
}

function inside(root: string, target: string): string | null {
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

async function readHead(path: string, bytes: number): Promise<Uint8Array | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** Everything `commit` needs beyond the verdict. */
export type Inspected = {
  verdict: AttachmentVerdict;
  /** The real file to read (a symlink's target). */
  target: string | null;
  /** Memoised hash of `target`. */
  hash: () => Promise<string>;
};

function blockedVerdict(input: AttachmentInput, name: string, problem: AttachmentProblem): AttachmentVerdict {
  const { mime, category } = mimeOf(name);
  return {
    source: input.source,
    name,
    storedName: name,
    size: null,
    mime,
    category,
    disposition: 'copy',
    state: 'blocked',
    problems: [problem],
  };
}

export async function inspectAttachment(
  input: AttachmentInput,
  space: SpaceContext,
  claimed: Set<string> = new Set()
): Promise<Inspected> {
  const rawName = input.name?.trim() || basename(input.source);
  const name = sanitizeAttachmentName(rawName);
  const fail = (kind: 'missing' | 'unreadable' | 'folder'): Inspected => ({
    verdict: blockedVerdict(input, name, { kind, message: MESSAGES[kind] }),
    target: null,
    hash: () => Promise.reject(new Error(kind)),
  });

  if (!isAbsolute(input.source)) return fail('missing');
  let target: string;
  let size: number;
  try {
    await lstat(input.source);
    // A symlink is followed to what it points at: that file is copied, never the link.
    target = await realpath(input.source);
    const info = await stat(target);
    if (info.isDirectory()) return fail('folder');
    if (!info.isFile()) return fail('unreadable');
    size = info.size;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return fail(code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable');
  }

  let memo: Promise<string> | null = null;
  const hash = () => (memo ??= hashFile(target));
  const { mime, category } = mimeOf(name);
  const problems: AttachmentProblem[] = [];
  let disposition: AttachmentDisposition;
  let linkPath: string | undefined;
  let storedName = name;

  const inSpace = inside(space.root, target);
  if (inSpace !== null) {
    storedName = basename(target);
    linkPath = inSpace;
    disposition = space.isSyncIgnored(inSpace) ? 'localOnly' : 'link';
  } else if (space.isSyncIgnored(`${ATTACHMENTS_DIR}/${name}`)) {
    disposition = 'localOnly';
  } else {
    const same = await findSameContent(space, size, hash).catch(() => null);
    if (same) {
      disposition = 'reuse';
      storedName = same;
      linkPath = `${ATTACHMENTS_DIR}/${same}`;
    } else {
      disposition = 'copy';
      storedName = freeName(space, name, claimed);
      claimed.add(foldName(storedName));
    }
  }

  if (disposition === 'copy' && size > ATTACHMENT_MAX_BYTES) {
    problems.push({ kind: 'tooLarge', message: MESSAGES.tooLarge });
  }
  if (disposition !== 'link') {
    const head = await readHead(target, SECRET_SCAN_BYTES);
    if (secretReason(name, head) || secretReason(basename(target), head)) {
      problems.push({ kind: 'secret', message: disposition === 'localOnly' ? MESSAGES.secretLocal : MESSAGES.secret });
    }
  }
  if (disposition === 'localOnly') problems.push({ kind: 'localOnly', message: MESSAGES.localOnly });

  let pageCount: number | undefined;
  if (category === 'pdf' && size <= PDF_COUNT_MAX_BYTES) {
    try {
      pageCount = pdfPageCount(await readFile(target)) ?? undefined;
    } catch {
      // best effort
    }
  }

  const blocked = problems.some(
    (p) => p.kind === 'tooLarge' || (p.kind === 'secret' && !input.shareAnyway)
  );
  const state = blocked ? 'blocked' : problems.length > 0 ? 'warn' : 'ok';
  return {
    verdict: {
      source: input.source,
      name,
      storedName,
      size,
      mime,
      category,
      ...(pageCount !== undefined ? { pageCount } : {}),
      disposition,
      ...(linkPath ? { linkPath } : {}),
      state,
      problems,
    },
    target,
    hash,
  };
}
