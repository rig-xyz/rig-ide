import { open, stat } from 'node:fs/promises';
import { log } from '@main/lib/logger';

/**
 * File-navigator redesign (`docs/file-navigator-design.md` §1): markdown
 * document titles — front-matter `title:` or the first `# H1` — for
 * `main/rig/files.ts`'s `listDir` to attach to `RigFileNode.title`.
 *
 * Investigated first: `main/core/search/workspace-file-index-service.ts`
 * only indexes file PATHS for quick-open search (`FileHit = {path,
 * filename}`) — it never reads content, parses headings, or caches
 * anything content-derived. Nothing to reuse there; this is new, narrow
 * machinery instead.
 *
 * Caching: in-memory `Map<absPath, {mtimeMs, title}>`. `getFileTitle` always
 * `stat`s first — a cheap syscall next to the readdir the caller is already
 * doing — and only re-reads content when the file's `mtimeMs` moved,
 * which doubles as the "invalidation" the design asks for: the tree's
 * existing `rigFileChangeChannel` watcher (`files.ts`) already triggers a
 * fresh `list` → fresh `stat` on every change, so a stale cache entry is
 * never actually served past the next change-driven refetch. No separate
 * per-path eviction hook into the watcher — that would duplicate the
 * "coarse signal, re-read to find out" idiom `files.ts`'s own header
 * comment already documents for this exact channel.
 */

const TITLE_READ_BYTES = 2048;

type CacheEntry = { mtimeMs: number; title: string | null };

const cache = new Map<string, CacheEntry>();

/** Test-only: forces the next `getFileTitle` call for every path to re-read content. */
export function clearFileTitleCache(): void {
  cache.clear();
}

export async function getFileTitle(absPath: string): Promise<string | null> {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(absPath)).mtimeMs;
  } catch {
    return null;
  }

  const cached = cache.get(absPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.title;

  const title = await extractTitle(absPath);
  cache.set(absPath, { mtimeMs, title });
  return title;
}

async function extractTitle(absPath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(absPath, 'r');
    const buffer = Buffer.alloc(TITLE_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, TITLE_READ_BYTES, 0);
    const text = buffer.toString('utf8', 0, bytesRead);
    return parseFrontMatterTitle(text) ?? parseFirstH1(text);
  } catch (error) {
    log.warn('File title cache: could not read file for title extraction', {
      absPath,
      error: String(error),
    });
    return null;
  } finally {
    await handle?.close();
  }
}

/** `---\ntitle: Foo\n---` (or an unterminated block within the read window — still worth a look). */
function parseFrontMatterTitle(text: string): string | null {
  if (!text.startsWith('---')) return null;
  const closeIndex = text.indexOf('\n---', 3);
  const block = closeIndex === -1 ? text.slice(3) : text.slice(3, closeIndex);
  for (const line of block.split('\n')) {
    const match = /^title:\s*(.+)$/.exec(line.trim());
    if (match) {
      const value = stripQuotes(match[1].trim());
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** The first `# Heading` line outside a fenced code block (```/~~~), within the read window. */
function parseFirstH1(text: string): string | null {
  let inFence = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('```') || line.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^#\s+(.+)$/.exec(line);
    if (match) {
      const value = match[1].trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}
