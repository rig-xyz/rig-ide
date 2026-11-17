import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import type { AcpPermissionRequest } from '@emdash/core/acp';
import { isViewName, viewDataPath, VIEWS_DIR } from '@shared/rig/views';

/**
 * The one write a turn started by a Rig view may make without asking its owner (spike, Rig Alpha):
 * that view's own `data.json`. A view's turn is told to end by rewriting it, and a refresh nobody
 * is watching would otherwise sit on an approval card until someone came back.
 *
 * Deliberately narrow. It covers creating or changing exactly `views/<name>/data.json` in the
 * space's folder with the agent's file tool, answered with "allow once" (never an "always").
 * Everything else still waits for the owner: any other file (the view's own page included), a
 * delete, a shell command that happens to write there, a tool, anything outside the space.
 *
 * A third case is a read, not a write: the agent's own file-read tool on a file inside the space's
 * folder (`spaceReadOption`, checked against real paths by `isRealSpaceFile`), answered with
 * "allow once". Hidden files and folders of the space (`.env`, `.rig`, `.git`, `.claude`) still
 * ask, and so does every read outside the space, a link that leads out, and every write, delete,
 * shell command, search and web fetch.
 */
export function viewDataWriteOption(
  request: AcpPermissionRequest,
  cwd: string,
  view: string
): string | null {
  if (!isViewName(view)) return null;
  const call = request.toolCall;
  if (call.kind !== 'create-file-tool-call' && call.kind !== 'modify-file-tool-call') return null;
  const target = normalize(isAbsolute(call.path) ? call.path : resolve(cwd, call.path));
  if (target !== join(cwd, viewDataPath(view))) return null;
  return request.options.find((option) => option.kind === 'allow_once')?.optionId ?? null;
}

/**
 * The file is really inside the space: neither `views`, the view's folder nor `data.json` is a
 * link, so the write cannot land somewhere else under an allowed name. A file that does not
 * exist yet is fine.
 */
export async function isPlainViewDataPath(cwd: string, view: string): Promise<boolean> {
  for (const path of [
    join(cwd, VIEWS_DIR),
    join(cwd, VIEWS_DIR, view),
    join(cwd, viewDataPath(view)),
  ]) {
    try {
      if ((await lstat(path)).isSymbolicLink()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') return false;
    }
  }
  return true;
}

/**
 * For a permission request the tool call's `path` is parsed from its title, and the parse stops at
 * the first " (", so `Read /space/a (x)/../../b` parses to `/space/a`. A path is trusted only when
 * the title is exactly "Read <path>", with at most the range note the agent's file tool adds, and
 * holds no `..` anywhere (the tool resolves those on its own, differently from the parse).
 */
export function titleIsExactRead(title: unknown, path: string): boolean {
  if (typeof title !== 'string') return false;
  const match = /^Read (.+?)( \(\d+ - \d+\)| \(from line \d+\))?$/.exec(title);
  if (!match || match[1] !== path) return false;
  return !title.split(/[\\/]/).includes('..');
}

const SKILL_DIRS = ['rig-views', 'rig-factory', 'rig-gardener'].flatMap((name) =>
  ['.claude/skills', '.agents/skills'].map((root) => join(root, name))
);

/**
 * Reading one of the skills the app itself installed (`install-skills.ts`) needs no approval. The
 * space's rules send the agent to those files, and they sit in the member's home, outside the
 * space, where a read would otherwise stop on a card before the agent has done anything. Only
 * files in those skills' own folders, only a read, answered with "allow once".
 */
export function bundledSkillReadOption(
  request: AcpPermissionRequest,
  home = homedir()
): string | null {
  const call = request.toolCall;
  if (call.kind !== 'read-tool-call' || !call.path || !isAbsolute(call.path)) return null;
  const target = normalize(call.path);
  if (!titleIsExactRead(call.title, call.path)) return null;
  if (!SKILL_DIRS.some((dir) => target.startsWith(join(home, dir) + sep))) return null;
  return request.options.find((option) => option.kind === 'allow_once')?.optionId ?? null;
}

/** A read, with the agent's file tool, of a file inside the space's own folder: the option that allows it once, and the file. Null for anything else. */
export function spaceReadOption(
  request: AcpPermissionRequest,
  cwd: string
): { optionId: string; target: string } | null {
  const call = request.toolCall;
  if (call.kind !== 'read-tool-call') return null;
  if (typeof call.path !== 'string' || !call.path || call.resource) return null;
  if (!titleIsExactRead(call.title, call.path)) return null;
  const root = normalize(cwd);
  const target = normalize(isAbsolute(call.path) ? call.path : resolve(cwd, call.path));
  if (!target.startsWith(root + sep)) return null;
  if (target.slice(root.length + 1).split(sep).some((segment) => segment.startsWith('.'))) return null;
  const optionId = request.options.find((option) => option.kind === 'allow_once')?.optionId;
  return optionId ? { optionId, target } : null;
}

/** The file really is inside the space: its real path (links followed) sits under the space's real path. A file that does not exist is not allowed here. */
export async function isRealSpaceFile(cwd: string, target: string): Promise<boolean> {
  try {
    const [root, real] = await Promise.all([realpath(cwd), realpath(target)]);
    return real.startsWith(root + sep);
  } catch {
    return false;
  }
}

/** The skill file really is inside one of the app's skill folders: its real path (links followed) sits under that folder's real path. */
export async function isRealSkillFile(target: string, home = homedir()): Promise<boolean> {
  try {
    const real = await realpath(target);
    for (const dir of SKILL_DIRS) {
      const root = await realpath(join(home, dir)).catch(() => null);
      if (root && real.startsWith(root + sep)) return true;
    }
  } catch {
    return false;
  }
  return false;
}
