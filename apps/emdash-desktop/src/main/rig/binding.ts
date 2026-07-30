import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

export type RigBindingConfig = {
  bindingId: string;
  relayUrl: string;
  deviceId: string;
  token: string;
};

export type RigBindingLocation = {
  config: RigBindingConfig;
  /** Directory containing the .rig folder — the rig workspace root. */
  workspaceRoot: string;
};

const BINDING_RELATIVE_PATH = join('.rig', 'tap-binding.local.json');

/**
 * Locates the tap relay binding for a session working directory by walking up
 * to the filesystem root looking for `.rig/tap-binding.local.json`.
 *
 * Emdash often runs agent sessions in app-managed git worktrees that live
 * OUTSIDE the project directory, where the walk-up can never find the binding.
 * As a fallback, a `.git` FILE (worktree pointer, `gitdir: <path>`) at or above
 * the start directory is parsed to recover the main repository root, and the
 * walk-up is retried from there.
 */
export function findBindingConfig(startDir: string): RigBindingLocation | null {
  const direct = walkUpForBinding(startDir);
  if (direct) return direct;

  const mainRepoRoot = resolveWorktreeMainRoot(startDir);
  if (mainRepoRoot) return walkUpForBinding(mainRepoRoot);

  return null;
}

function walkUpForBinding(startDir: string): RigBindingLocation | null {
  let dir = resolve(startDir);
  for (;;) {
    const config = readBindingFile(join(dir, BINDING_RELATIVE_PATH));
    if (config) return { config, workspaceRoot: dir };
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readBindingFile(path: string): RigBindingConfig | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { bindingId, relayUrl, deviceId, token } = parsed as Record<string, unknown>;
    if (
      isNonEmptyString(bindingId) &&
      isNonEmptyString(relayUrl) &&
      isNonEmptyString(deviceId) &&
      isNonEmptyString(token)
    ) {
      return { bindingId, relayUrl, deviceId, token };
    }
    return null;
  } catch {
    return null;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Walks up from `startDir` looking for a `.git` FILE (a linked-worktree pointer
 * containing `gitdir: <path>/.git/worktrees/<name>`) and returns the main
 * repository root (the directory containing the real `.git` directory).
 * Pure filesystem parse — no git process is spawned.
 */
function resolveWorktreeMainRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const gitPath = join(dir, '.git');
    let isFile: boolean | null = null;
    try {
      const stat = statSync(gitPath);
      isFile = stat.isFile();
    } catch {
      isFile = null; // no .git entry here; keep walking up
    }
    if (isFile === true) {
      return parseWorktreeGitdirPointer(dir, gitPath);
    }
    if (isFile === false) {
      // Real .git directory — a plain repo the primary walk-up already covered.
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function parseWorktreeGitdirPointer(worktreeDir: string, gitFilePath: string): string | null {
  let contents: string;
  try {
    contents = readFileSync(gitFilePath, 'utf8');
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(contents);
  if (!match) return null;
  const gitdir = resolve(worktreeDir, match[1]);
  // <main-root>/.git/worktrees/<name> → recover <main-root>.
  const marker = `${sep}.git${sep}worktrees${sep}`;
  const markerIndex = gitdir.lastIndexOf(marker);
  if (markerIndex === -1) return null;
  return gitdir.slice(0, markerIndex);
}
