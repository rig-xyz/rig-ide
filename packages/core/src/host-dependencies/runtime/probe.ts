import os from 'node:os';
import type { IExecutionContext } from '../../exec/execution-context';
import type { Platform } from '../capability';
import { toPlatform } from './install-options';
import type { ProbeResult } from './types';
import { compareVersionStrings } from './version-order';

const WHICH_TIMEOUT_MS = 5_000;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const REALPATH_TIMEOUT_MS = 5_000;
const EXTRA_LOCATION_PROBE_TIMEOUT_MS = 5_000;

function targetPlatform(platform?: Platform): Platform {
  return platform ?? toPlatform(process.platform);
}

/** Expands a leading `~` (or bare `~`) to the current user's home directory. */
function expandHome(location: string): string {
  if (location === '~') return os.homedir();
  if (location.startsWith('~/')) return `${os.homedir()}${location.slice(1)}`;
  return location;
}

/**
 * Checks whether a well-known off-PATH location (e.g. a binary bundled inside
 * another app's install directory) exists and is executable. Unlike
 * `resolveCommandPath`, this doesn't search PATH — it tests the given absolute
 * path directly via `test -x`, so it works for locations `which`/`where` would
 * never find. Returns the expanded path when runnable, `null` otherwise
 * (including when the host has no POSIX `test` binary, e.g. Windows — no
 * current descriptor declares extraLocations there).
 */
export async function resolveExtraLocationPath(
  location: string,
  ctx: IExecutionContext
): Promise<string | null> {
  const expanded = expandHome(location);
  if (expanded.includes('*')) return resolveExtraLocationGlob(expanded, ctx);
  try {
    await ctx.exec('test', ['-x', expanded], { timeout: EXTRA_LOCATION_PROBE_TIMEOUT_MS });
    return expanded;
  } catch {
    return null;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A location where a `*` stands for one path segment, for an app that keeps
 * several versions side by side (the Claude desktop app's own Claude Code
 * lives at `claude-code/<version>/<hash>/claude.app/...`). Of the executable
 * matches, the one whose first `*` segment is the highest version wins, so
 * only the newest copy becomes a candidate. Null when nothing matches.
 */
export async function resolveExtraLocationGlob(
  pattern: string,
  ctx: IExecutionContext
): Promise<string | null> {
  // Quote every literal segment (paths like "Application Support" have
  // spaces) and leave the `*` ones bare for the shell to expand.
  const shellPattern = pattern
    .split('/')
    .map((segment) => (segment.includes('*') ? segment.replace(/[^*A-Za-z0-9._-]/g, '') : segment ? shellQuote(segment) : ''))
    .join('/');
  let stdout: string;
  try {
    ({ stdout } = await ctx.exec(
      'sh',
      ['-c', `for p in ${shellPattern}; do [ -x "$p" ] && printf '%s\\n' "$p"; done; true`],
      { timeout: EXTRA_LOCATION_PROBE_TIMEOUT_MS }
    ));
  } catch {
    return null;
  }
  const firstStar = pattern.split('/').findIndex((segment) => segment.includes('*'));
  const matches = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const versionOf = (path: string) => path.split('/')[firstStar] ?? null;
  matches.sort((a, b) => compareVersionStrings(versionOf(b), versionOf(a)));
  return matches[0] ?? null;
}

/** Resolves a list of extra-location hints, dropping any that don't exist/aren't executable. */
export async function resolveExtraLocationPaths(
  locations: string[],
  ctx: IExecutionContext
): Promise<string[]> {
  const resolved = await Promise.all(
    locations.map((location) => resolveExtraLocationPath(location, ctx))
  );
  return resolved.filter((path): path is string => path !== null);
}

/**
 * Resolves all absolute paths for a command binary in PATH order.
 * Uses `where` on Windows (which already lists all matches) and `which -a` on
 * macOS/Linux. Returns an empty array when the command is not found.
 *
 * The first entry is the PATH winner (same result as resolveCommandPath).
 */
export async function resolveAllCommandPaths(
  command: string,
  ctx: IExecutionContext,
  platform?: Platform
): Promise<string[]> {
  const plat = targetPlatform(platform);
  try {
    if (plat === 'windows') {
      const { stdout } = await ctx.exec('where', [command], { timeout: WHICH_TIMEOUT_MS });
      return stdout
        .trim()
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    const { stdout } = await ctx.exec('which', ['-a', command], { timeout: WHICH_TIMEOUT_MS });
    return stdout
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Resolves the absolute path of a command binary.
 * Uses `where` on Windows and `which` on macOS/Linux.
 * Returns `null` if the command is not found or the resolution fails.
 */
export async function resolveCommandPath(
  command: string,
  ctx: IExecutionContext,
  platform?: Platform
): Promise<string | null> {
  const resolveCmd = targetPlatform(platform) === 'windows' ? 'where' : 'which';
  try {
    const { stdout } = await ctx.exec(resolveCmd, [command], { timeout: WHICH_TIMEOUT_MS });
    const firstLine = stdout.trim().split('\n')[0]?.trim();
    return firstLine ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolves the canonical realpath of a binary by following symlinks.
 * Runs `realpath` on Unix or falls back to the given path on failure/Windows.
 * Used to determine the true install location for method inference.
 */
export async function resolveRealpath(
  resolvedPath: string,
  ctx: IExecutionContext,
  platform?: Platform
): Promise<string> {
  if (targetPlatform(platform) === 'windows') return resolvedPath;
  try {
    const { stdout } = await ctx.exec('realpath', [resolvedPath], {
      timeout: REALPATH_TIMEOUT_MS,
    });
    const real = stdout.trim();
    return real || resolvedPath;
  } catch {
    return resolvedPath;
  }
}

/**
 * Runs `command args` and collects stdout/stderr up to a timeout.
 * Never throws — all failures are captured in the returned `ProbeResult`.
 */
export async function runVersionProbe(
  command: string,
  resolvedPath: string | null,
  args: string[],
  ctx: IExecutionContext,
  timeoutMs: number = VERSION_PROBE_TIMEOUT_MS
): Promise<ProbeResult> {
  const bin = resolvedPath ?? command;
  try {
    const { stdout, stderr } = await ctx.exec(bin, args, { timeout: timeoutMs });
    return { command, path: resolvedPath, stdout, stderr, exitCode: 0, timedOut: false };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
    return {
      command,
      path: resolvedPath,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: e.code ?? null,
      timedOut: !!e.killed,
    };
  }
}
