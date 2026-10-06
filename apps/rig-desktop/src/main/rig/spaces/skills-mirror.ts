import { type FSWatcher, watch as fsWatch } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { log } from '@main/lib/logger';

/**
 * Claude reads a space's skills from `.claude/skills`, Codex from
 * `.agents/skills`, and neither reads the other's. The rig CLI writes its
 * own two skills into both at init; this keeps every other skill in step,
 * so a skill added for one agent reaches the other.
 *
 * Owner only: both folders are owner-only in a space (the relay refuses a
 * member's writes there), so a copy made on a member's Mac would never sync
 * and would only drift from the space. The owner's copy syncs to everyone.
 *
 * Per skill folder: one present on one side only is copied over whole; one
 * on both sides whose files differ takes the side with the newest file
 * (Claude's on a tie) and copies its missing or different files over.
 * Nothing is ever deleted, so a file only one side has stays (and, when
 * that side is newer, reaches the other next time). Symlinks are skipped,
 * and when either skills folder (or `.claude`/`.agents`) is itself a link
 * nothing is touched, since it may point outside the space.
 */

export const SKILL_DIRS = ['.claude/skills', '.agents/skills'] as const;
const SKIPPED_NAMES = new Set(['.DS_Store', '.git', 'node_modules']);
const DEBOUNCE_MS = 1_000;
const OWNER_TTL_MS = 10 * 60_000;

type Kind = 'dir' | 'absent' | 'other';

async function kindOf(path: string): Promise<Kind> {
  try {
    const stats = await lstat(path);
    return stats.isDirectory() ? 'dir' : 'other';
  } catch {
    return 'absent';
  }
}

/** The skill folders under one skills folder, by name, with what each is. */
async function skillFolders(dir: string): Promise<Map<string, Kind>> {
  const out = new Map<string, Kind>();
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIPPED_NAMES.has(entry.name)) continue;
    // A loose file in the skills folder isn't a skill: left alone.
    if (entry.isDirectory()) out.set(entry.name, 'dir');
    else if (entry.isSymbolicLink()) out.set(entry.name, 'other');
  }
  return out;
}

type FileInfo = { mtimeMs: number; size: number };

/** A skill folder's regular files by relative path; links and anything else skipped. */
async function filesIn(dir: string): Promise<Map<string, FileInfo>> {
  const out = new Map<string, FileInfo>();
  const walk = async (rel: string) => {
    let entries;
    try {
      entries = await readdir(join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIPPED_NAMES.has(entry.name)) continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const stats = await lstat(join(dir, path)).catch(() => null);
        if (stats?.isFile()) out.set(path, { mtimeMs: stats.mtimeMs, size: stats.size });
      }
    }
  };
  await walk('');
  return out;
}

async function sameBytes(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([readFile(a), readFile(b)]);
  return x.equals(y);
}

/** Nothing on the way to `rel` under `dir` is a link, and `rel` itself is a regular file or absent: safe to write. */
async function writable(dir: string, rel: string): Promise<boolean> {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    if ((await kindOf(join(dir, ...parts.slice(0, i)))) === 'other') return false;
  }
  const stats = await lstat(join(dir, rel)).catch(() => null);
  return !stats || stats.isFile();
}

/** Copies `from`'s files that `to` lacks or has different. Returns the relative paths copied. */
async function copyInto(
  from: string,
  to: string,
  files: Map<string, FileInfo>,
  existing: Map<string, FileInfo>
) {
  const copied: string[] = [];
  for (const [rel, info] of files) {
    const target = join(to, rel);
    const there = existing.get(rel);
    try {
      if (there && there.size === info.size && (await sameBytes(join(from, rel), target))) continue;
      // Never write through a link, nor over a folder where a file would go.
      if (!(await writable(to, rel))) continue;
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(from, rel), target);
      copied.push(rel);
    } catch (error) {
      log.warn('Rig spaces: could not mirror a skill file', {
        code: (error as NodeJS.ErrnoException)?.code,
      });
    }
  }
  return copied;
}

const newest = (files: Map<string, FileInfo>) =>
  Math.max(0, ...[...files.values()].map((f) => f.mtimeMs));

/**
 * One pass over a space folder. Returns what it copied, as
 * `<skills folder>/<skill>/<file>` paths relative to the space.
 */
export async function mirrorSkills(root: string): Promise<string[]> {
  // Either side behind a link: it may lead anywhere, so leave both alone.
  for (const path of ['.claude', '.agents', ...SKILL_DIRS]) {
    if ((await kindOf(join(root, path))) === 'other') return [];
  }
  const [claudeDir, agentsDir] = SKILL_DIRS.map((d) => join(root, d)) as [string, string];
  const [claude, agents] = await Promise.all([skillFolders(claudeDir), skillFolders(agentsDir)]);
  const copied: string[] = [];
  const names = [...new Set([...claude.keys(), ...agents.keys()])].sort();
  for (const name of names) {
    const a = claude.get(name) ?? 'absent';
    const b = agents.get(name) ?? 'absent';
    if (a === 'other' || b === 'other') continue;
    const [aFiles, bFiles] = await Promise.all([
      a === 'dir' ? filesIn(join(claudeDir, name)) : new Map<string, FileInfo>(),
      b === 'dir' ? filesIn(join(agentsDir, name)) : new Map<string, FileInfo>(),
    ]);
    // Missing on one side copies whole; on both, the side with the newest file wins.
    const claudeWins = b === 'absent' || (a !== 'absent' && newest(aFiles) >= newest(bFiles));
    const [from, to, fromFiles, toFiles, toDir] = claudeWins
      ? [join(claudeDir, name), join(agentsDir, name), aFiles, bFiles, SKILL_DIRS[1]]
      : [join(agentsDir, name), join(claudeDir, name), bFiles, aFiles, SKILL_DIRS[0]];
    for (const rel of await copyInto(from, to, fromFiles, toFiles))
      copied.push(`${toDir}/${name}/${rel}`);
  }
  return copied;
}

/** Whether `rel` (a path relative to the space, `/` or the platform separator) is in either skills folder. */
export function isSkillsPath(rel: string): boolean {
  const path = rel.split('\\').join('/');
  return (
    SKILL_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`)) ||
    path === '.claude' ||
    path === '.agents'
  );
}

export interface SkillsMirror {
  /** A space was opened (or caught up): mirror now if you own it, and keep mirroring as its skills change. */
  open(bindingId: string, root: string): Promise<void>;
  /** Stops every watch. */
  dispose(): void;
}

export function createSkillsMirror(deps: {
  /** Whether the signed-in account owns this space; false when that can't be told. */
  isOwner: (bindingId: string) => Promise<boolean>;
  watch?: (
    root: string,
    onChange: (rel: string) => void,
    onError: () => void
  ) => { close(): void } | null;
  mirror?: (root: string) => Promise<string[]>;
  now?: () => number;
  debounceMs?: number;
}): SkillsMirror {
  const now = deps.now ?? Date.now;
  const mirror = deps.mirror ?? mirrorSkills;
  const debounceMs = deps.debounceMs ?? DEBOUNCE_MS;
  const watchFn = deps.watch ?? watchRoot;
  const owners = new Map<string, { at: number; owner: boolean }>();
  const watched = new Map<
    string,
    { root: string; handle: { close(): void }; timer: NodeJS.Timeout | null }
  >();
  const running = new Map<string, Promise<void>>();
  const again = new Set<string>();

  async function owns(bindingId: string): Promise<boolean> {
    const hit = owners.get(bindingId);
    if (hit && now() - hit.at < OWNER_TTL_MS) return hit.owner;
    const owner = await deps.isOwner(bindingId).catch(() => false);
    owners.set(bindingId, { at: now(), owner });
    return owner;
  }

  /** One pass at a time per space; a change during a pass runs one more after it. */
  function run(root: string): Promise<void> {
    const current = running.get(root);
    if (current) {
      again.add(root);
      return current;
    }
    const pass = mirror(root)
      .then((copied) => {
        if (copied.length > 0)
          log.info('Rig spaces: mirrored skills between .claude and .agents', {
            files: copied.length,
          });
      })
      .catch((error: unknown) =>
        log.warn('Rig spaces: could not mirror skills', { error: String(error) })
      )
      .finally(() => {
        running.delete(root);
        if (again.delete(root)) void run(root);
      });
    running.set(root, pass);
    return pass;
  }

  function stop(bindingId: string) {
    const entry = watched.get(bindingId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.handle.close();
    watched.delete(bindingId);
  }

  return {
    async open(bindingId, root) {
      if (!(await owns(bindingId))) {
        stop(bindingId);
        return;
      }
      if (watched.get(bindingId)?.root !== root) {
        stop(bindingId);
        const entry: { root: string; handle: { close(): void }; timer: NodeJS.Timeout | null } = {
          root,
          handle: { close() {} },
          timer: null,
        };
        const handle = watchFn(
          root,
          (rel) => {
            if (!isSkillsPath(rel)) return;
            if (entry.timer) clearTimeout(entry.timer);
            entry.timer = setTimeout(() => {
              entry.timer = null;
              void run(root);
            }, debounceMs);
          },
          // A watch that died is started again on the next open.
          () => {
            if (watched.get(bindingId) === entry) stop(bindingId);
          }
        );
        if (handle) {
          entry.handle = handle;
          watched.set(bindingId, entry);
        }
      }
      await run(root);
    },
    dispose() {
      for (const bindingId of [...watched.keys()]) stop(bindingId);
    },
  };
}

/** The whole space, recursively (one FSEvents stream on macOS), reporting paths relative to it. */
function watchRoot(
  root: string,
  onChange: (rel: string) => void,
  onError: () => void
): FSWatcher | null {
  try {
    const watcher = fsWatch(root, { recursive: true }, (_event, filename) => {
      if (filename) onChange(filename.toString());
    });
    watcher.on('error', onError);
    return watcher;
  } catch (error) {
    log.warn('Rig spaces: could not watch a space for skill changes', {
      code: (error as NodeJS.ErrnoException)?.code,
    });
    return null;
  }
}
