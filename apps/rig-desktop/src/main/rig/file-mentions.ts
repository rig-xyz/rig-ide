import { readdir } from 'node:fs/promises';
import { basename as pathBasename, join, relative, sep } from 'node:path';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { resolveLocalPathsImpl } from './recent-rigs';

/**
 * Resolves Home pulse's file mentions (`renderer/features/home/pulse-file-
 * mentions.ts`'s `extractFileMentionCandidates`) for a rig this device may
 * not even have open — WHAT'S NEW/ACROSS YOUR RIGS narrates activity across
 * every rig on the fabric, not just the currently-bound one, so there is no
 * already-acquired root (`rig.files.list`'s own `rootId`) to list through
 * for most of them.
 *
 * `bindingId`'s local folder comes from `resolveLocalPathsImpl`
 * (`recent-rigs.ts`'s own existence-verified `rig_rigs` lookup — imported,
 * not reimplemented) rather than a scan of the filesystem for candidate
 * folders; a binding with no known local path (relay-only) simply resolves
 * every candidate to `null` — pulse narration for THAT rig stays plain
 * text, same as the renderer side already expects.
 *
 * The walk itself mirrors `files.ts`'s own ignore rule (`.git`/
 * `node_modules`) plus `.rig` (the sync/binding folder — never a place a
 * real mention would point into), capped at `MAX_FILES` so a huge rig can't
 * make one pulse render do an unbounded scan. Each bindingId's walk result
 * is cached for `CACHE_TTL_MS` — cheap enough that a burst of pulse rows
 * for the SAME rig (several intents on it) never re-walks the folder once
 * per row.
 */

const MAX_FILES = 5000;
const CACHE_TTL_MS = 30_000;
const IGNORED_NAMES = new Set(['.git', 'node_modules', '.rig']);

type WalkedFile = { relPath: string; basename: string };

const cache = new Map<string, { expiresAt: number; files: WalkedFile[] }>();

/** Breadth-first, ignoring `IGNORED_NAMES`, stopping once `MAX_FILES` files have been found — a directory that vanishes or can't be read mid-walk (a race, or a permissions quirk) is skipped, never fatal to the rest. */
async function walk(root: string): Promise<WalkedFile[]> {
  const files: WalkedFile[] = [];
  const dirs: string[] = [root];
  while (dirs.length > 0 && files.length < MAX_FILES) {
    const dir = dirs.shift() as string;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name)) continue;
      const absPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        dirs.push(absPath);
      } else if (entry.isFile()) {
        files.push({
          relPath: relative(root, absPath).split(sep).join('/'),
          basename: entry.name,
        });
        if (files.length >= MAX_FILES) break;
      }
    }
  }
  return files;
}

/** `bindingId`'s walked file list — from cache when fresh, `null` when there's no known local path for it at all. */
async function filesForBinding(bindingId: string): Promise<WalkedFile[] | null> {
  const now = Date.now();
  const cached = cache.get(bindingId);
  if (cached && cached.expiresAt > now) return cached.files;

  const localPaths = await resolveLocalPathsImpl([bindingId]);
  const root = localPaths[bindingId];
  if (!root) return null;

  const files = await walk(root);
  cache.set(bindingId, { expiresAt: now + CACHE_TTL_MS, files });
  return files;
}

/** A candidate may be written with a leading `./` (pulse's tokenizer allows it, same as chat's matcher) — stripped before matching against a real relPath. */
function stripLeadingDotSlash(candidate: string): string {
  return candidate.startsWith('./') ? candidate.slice(2) : candidate;
}

/**
 * Resolves each of `candidates` against `bindingId`'s rig — an exact
 * relPath match first, else a basename match ONLY when that basename is
 * unique across the whole rig (an ambiguous basename resolves to `null`,
 * same "don't guess" rule chat's own `buildFileMentionIndex` uses).
 */
export async function resolveFileMentionsImpl(
  bindingId: string,
  candidates: readonly string[]
): Promise<Record<string, string | null>> {
  const files = await filesForBinding(bindingId);
  const result: Record<string, string | null> = {};
  if (!files) {
    for (const candidate of candidates) result[candidate] = null;
    return result;
  }

  const byRelPath = new Set(files.map((f) => f.relPath));
  const byBasename = new Map<string, string[]>();
  for (const f of files) {
    const list = byBasename.get(f.basename);
    if (list) list.push(f.relPath);
    else byBasename.set(f.basename, [f.relPath]);
  }

  for (const raw of candidates) {
    const candidate = stripLeadingDotSlash(raw);
    if (byRelPath.has(candidate)) {
      result[raw] = candidate;
      continue;
    }
    const basenameMatches = byBasename.get(pathBasename(candidate));
    result[raw] = basenameMatches?.length === 1 ? basenameMatches[0] : null;
  }
  return result;
}

/** Test-only: clears the per-bindingId walk cache — without this, two tests reusing the same bindingId against different temp directories would see the first test's stale file list. */
export function resetFileMentionsCacheForTests(): void {
  cache.clear();
}

export const rigFileMentionsController = createRPCController({
  resolve: ({
    bindingId,
    candidates,
  }: {
    bindingId: string;
    candidates: string[];
  }): Promise<Record<string, string | null>> => resolveFileMentionsImpl(bindingId, candidates),
});
