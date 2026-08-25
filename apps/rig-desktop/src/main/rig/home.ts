import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';

/**
 * The managed rig home directory (`~/Rig` by default) — see
 * `docs/rig-home-design.md` in the rig CLI repo, the contract this
 * mirrors. Both surfaces (CLI and app) read the SAME `home` key from
 * `~/.config/rig/config.json`; this file is the app's one place that
 * resolves it, the same role rig's own `src/home.mjs` plays CLI-side.
 *
 * Unlike `config.ts` (read-only — the relay PAT), this file WRITES the
 * `home` key too (Settings' "Rig folder" → "Change…"), always preserving
 * whatever else is already in the file (hub token, hub user, …) — it
 * never assumes the shape of the rest of the config.
 */

const DEFAULT_HOME_DIR = join(homedir(), 'Rig');

/**
 * The exact file the CLI reads/writes (rig's own `src/config.mjs` has no
 * XDG_CONFIG_HOME support, unlike `config.ts`'s read side above) — the
 * `home` key must live at this precise path or the two surfaces would
 * silently disagree about where rigs land.
 */
function rigConfigFilePath(): string {
  return join(homedir(), '.config', 'rig', 'config.json');
}

async function readRigConfig(): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(rigConfigFilePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('Rig home: could not parse rig config, treating as empty', { error: String(error) });
    }
    return {};
  }
}

/** `home` from `~/.config/rig/config.json`, or the `~/Rig` default. Does not touch the disk. */
export async function readRigHomeDir(): Promise<string> {
  const config = await readRigConfig();
  const home = config.home;
  return typeof home === 'string' && home.trim() ? home : DEFAULT_HOME_DIR;
}

/** `readRigHomeDir()` plus a lazy `mkdir -p` — mirrors rig's own `ensureHomeDir` (`src/home.mjs`). Call this right before landing a rig in home. */
export async function ensureRigHomeDir(): Promise<string> {
  const home = await readRigHomeDir();
  await mkdir(home, { recursive: true });
  return home;
}

/**
 * Pure — `config` with `home` set to `newHome`, every other key untouched.
 * Isolated from the read/write I/O below so "preserves unknown keys" (hub
 * token, hub user, anything a future config version adds) is a tested
 * fact rather than something only exercised by writing to a real file.
 */
export function mergeHomeIntoConfig(
  config: Record<string, unknown>,
  newHome: string
): Record<string, unknown> {
  return { ...config, home: newHome };
}

/** Writes the `home` key, preserving every other key already in the file. */
export async function writeRigHomeDir(newHome: string): Promise<Result<{ home: string }, { message: string }>> {
  try {
    const existing = await readRigConfig();
    const config = mergeHomeIntoConfig(existing, newHome);
    await mkdir(dirname(rigConfigFilePath()), { recursive: true });
    await writeFile(rigConfigFilePath(), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    // Lazily create the folder too — same "whichever surface needs it
    // first creates it" rule `ensureHomeDir()` follows CLI-side, so a
    // rig created right after changing this in Settings has somewhere
    // to land.
    await mkdir(newHome, { recursive: true });
    return ok({ home: newHome });
  } catch (error) {
    return err({ message: error instanceof Error ? error.message : String(error) });
  }
}

/** `<home>` with the user's home directory shortened to `~`, for display only — never used for filesystem calls. */
export function tildify(path: string): string {
  const home = homedir();
  if (path === home) return '~';
  return path.startsWith(home + sep) ? `~${sep}${relative(home, path)}` : path;
}

/**
 * `<baseDir>/<slug>`, or `<slug>-2`, `<slug>-3`, … if that already exists —
 * mirrors rig's own `resolveLandingDir` (`src/home.mjs`) exactly. Never
 * returns a path that currently exists: a new landing never merges into an
 * existing folder (docs/rig-home-design.md, "Slug collisions").
 */
export function resolveHomeLandingDir(baseDir: string, slug: string): string {
  let candidate = join(baseDir, slug);
  for (let n = 2; existsSync(candidate); n += 1) {
    candidate = join(baseDir, `${slug}-${n}`);
  }
  return candidate;
}

/** Whether `path` is home itself or lives somewhere underneath it — the "custom location" test for a local rig row. */
export function isInsideHome(path: string, home: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedHome = resolve(home);
  return resolvedPath === resolvedHome || resolvedPath.startsWith(resolvedHome + sep);
}

export const rigHomeController = createRPCController({
  /** Settings' "Rig folder" row, and the create dialog's live "Will live in …" hint. */
  get: async (): Promise<{ home: string; displayPath: string }> => {
    const home = await readRigHomeDir();
    return { home, displayPath: tildify(home) };
  },
  /** Settings' "Change…" — writes the new home; does not move any existing rig. */
  set: async ({ home }: { home: string }): Promise<Result<{ home: string; displayPath: string }, { message: string }>> => {
    const result = await writeRigHomeDir(home);
    if (!result.success) return result;
    return ok({ home: result.data.home, displayPath: tildify(result.data.home) });
  },
});
