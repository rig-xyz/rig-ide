/**
 * Bundled @rigxyz/cli support (packaged builds only).
 *
 * scripts/vendor-rig-cli.ts vendors the CLI and two POSIX shims into the app's
 * Contents/Resources (see extraResources in electron-builder.config.ts):
 *   <resources>/rig-cli/   the npm package (bin/rig.mjs, node_modules, ...)
 *   <resources>/rig-bin/   `rig` and `tapd` shims that run it via the app's
 *                          embedded Node (ELECTRON_RUN_AS_NODE) — no system Node.
 *
 * This module prepends rig-bin to process.env.PATH at startup so every agent
 * session, PTY, and child process spawned by the app finds a working `rig`.
 * The bundled CLI deliberately wins over any globally installed one.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';

const VERSION_PROBE_TIMEOUT_MS = 2_000;
const SKILL_INSTALL_TIMEOUT_MS = 5_000;

/**
 * Directory containing the bundled `rig`/`tapd` shims, or null when not
 * packaged (dev builds use the developer's global rig install).
 */
export function bundledRigBinDir(): string | null {
  const dir = path.join(process.resourcesPath ?? '', 'rig-bin');
  try {
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/**
 * THE resolution every CLI driver spawn goes through — `rig login`/`logout`
 * (`auth.ts`), `rig attach` (`join.ts`), `rig init`/`sync` (`create.ts`).
 * Previously each of those files kept its own identical copy; now there is
 * exactly one, so the Settings → About version probe below can call this
 * SAME function to know what a driver would actually run, instead of a
 * separately-maintained PATH walk that could silently drift from it.
 *
 * Packaged builds: the bundled shim's absolute path, bypassing PATH
 * entirely. Dev builds (no bundled dir): the bare name, left for the OS to
 * resolve off `process.env.PATH` — the exact same global every driver spawn
 * passes as `env: process.env`, itself set once at boot by
 * `resolveUserEnv()` (a login-shell `PATH` capture) then
 * `ensureBundledRigBinInPath()`'s bundled-dir prepend.
 */
export function resolveCliBin(name: 'rig' | 'tapd' = 'rig'): string {
  const binDir = bundledRigBinDir();
  if (binDir) {
    const shim = path.join(binDir, name);
    if (fs.existsSync(shim)) return shim;
  }
  return name;
}

/**
 * Prepends the bundled rig-bin dir to process.env.PATH (if not already first)
 * so the bundled CLI shadows any global install. Must run AFTER resolveUserEnv()
 * — that call rebuilds PATH from the login shell on both its success and
 * failure paths, and a prepend done earlier would be lost.
 *
 * Returns the prepended dir, or null when not packaged / already present.
 */
export function ensureBundledRigBinInPath(): string | null {
  const binDir = bundledRigBinDir();
  if (!binDir) return null;

  const entries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (entries[0] === binDir) return null;

  const rest = entries.filter((entry) => entry !== binDir);
  process.env.PATH = [binDir, ...rest].join(path.delimiter);
  log.info('[bundled-cli] Prepended bundled rig bin dir to PATH', { binDir });
  return binDir;
}

/**
 * Log-only skew detection: if a non-bundled `rig` also exists on PATH, probe
 * its --version and warn when it differs from the bundled one. Never throws.
 */
export function logRigVersionSkew(): void {
  const binDir = bundledRigBinDir();
  if (!binDir) return;

  let bundledVersion = 'unknown';
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(process.resourcesPath, 'rig-cli', 'package.json'), 'utf-8')
    ) as { version?: string };
    bundledVersion = pkg.version ?? 'unknown';
  } catch (err) {
    log.warn('[bundled-cli] Failed to read bundled rig-cli version', { error: String(err) });
  }

  const globalRigs = findOnPath('rig').filter((p) => path.dirname(p) !== binDir);
  for (const globalRig of globalRigs) {
    execFile(
      globalRig,
      ['--version'],
      { timeout: VERSION_PROBE_TIMEOUT_MS, encoding: 'utf-8' },
      (err, stdout) => {
        if (err) {
          log.warn('[bundled-cli] Global rig on PATH failed --version probe', {
            path: globalRig,
            error: err.message,
          });
          return;
        }
        const globalVersion = stdout.trim();
        if (globalVersion !== bundledVersion) {
          log.warn('[bundled-cli] Global rig version differs from bundled (bundled wins on PATH)', {
            bundledVersion,
            bundledPath: path.join(binDir, 'rig'),
            globalVersion,
            globalPath: globalRig,
          });
        }
      }
    );
  }
}

/**
 * Runs the vendored CLI's postinstall script once per launch (fire-and-forget).
 * A DMG install never runs npm, so without this agents never get the
 * ~/.claude/skills/rig skill. The script is internally idempotent (skill-version
 * marker) and a silent no-op when ~/.claude does not exist.
 */
export function installBundledRigSkill(): void {
  if (!bundledRigBinDir()) return;

  const postinstall = path.join(process.resourcesPath, 'rig-cli', 'bin', 'postinstall.mjs');
  if (!fs.existsSync(postinstall)) {
    log.warn('[bundled-cli] Bundled rig postinstall.mjs not found, skipping skill install', {
      postinstall,
    });
    return;
  }

  execFile(
    process.execPath,
    [postinstall],
    {
      timeout: SKILL_INSTALL_TIMEOUT_MS,
      encoding: 'utf-8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    },
    (err) => {
      if (err) {
        log.warn('[bundled-cli] rig skill install failed', { error: err.message });
      } else {
        log.info('[bundled-cli] rig skill install completed');
      }
    }
  );
}

/** All matches for an executable `name` across process.env.PATH, in PATH order — the same order the OS's own PATH resolution would try them in. */
function findOnPath(name: string): string[] {
  const matches: string[] = [];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) matches.push(candidate);
    } catch {
      // not here
    }
  }
  return matches;
}

/** `fs.realpathSync`, tolerant of a broken symlink or a permissions error — the original path stands in rather than throwing. Indirected as a parameter default so `dedupeByRealPath` stays pure and testable without touching the filesystem. */
function defaultRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The "which -a, but deduped" half of multi-install awareness (item 3):
 * `nvm`'s `default` alias and its own versioned directory often both land
 * on PATH pointing at the identical binary, which would otherwise double-
 * count as two installs. Keeps each PATH entry's first occurrence (by real,
 * symlink-resolved target) in its original PATH order — so "using <path>"
 * still names the exact path OS resolution would pick, not its resolved
 * target.
 */
export function dedupeByRealPath(
  paths: readonly string[],
  realpath: (p: string) => string = defaultRealpath
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of paths) {
    const real = realpath(p);
    if (seen.has(real)) continue;
    seen.add(real);
    result.push(p);
  }
  return result;
}

export type BundledCliVersions = {
  rig: string | null;
  tapd: string | null;
};

/** One resolved, deduped PATH candidate plus whatever `--version` reported for it (null on probe failure). */
export type ProbedInstall = { path: string; version: string | null };

/** Multi-install awareness (item 3): only set when the PATH candidates disagree on version — never for a single install or several installs that happen to agree. */
export type MultipleInstalls = { count: number; usingPath: string };

/**
 * Pure: shapes the "local" half of one tool's version row from its ordered,
 * deduped PATH candidates. `candidates[0]` is the one PATH resolution (and
 * so `resolveCliBin`, in a dev build with nothing bundled) would actually
 * pick — its own path is what item 2 shows as the row's second mono line.
 * `multipleInstalls` fires only when more than one DISTINCT version shows
 * up among the candidates, so an installer with three symlinks to the same
 * binary never gets flagged as a conflict.
 */
export function shapeLocalInstalls(candidates: readonly ProbedInstall[]): {
  local: string | null;
  localPath: string | null;
  multipleInstalls: MultipleInstalls | null;
} {
  if (candidates.length === 0) return { local: null, localPath: null, multipleInstalls: null };
  const [using] = candidates;
  const distinctVersions = new Set(
    candidates.map((c) => c.version).filter((v): v is string => v !== null)
  );
  return {
    local: using.version,
    localPath: using.path,
    multipleInstalls:
      distinctVersions.size > 1 ? { count: candidates.length, usingPath: using.path } : null,
  };
}

/** One tool's installations, side by side — bundled plus the driver-truth PATH's own local resolution. */
export type CliVersionSources = {
  /** The version vendored inside this build (manifest read), null when not packaged. */
  bundled: string | null;
  /** What the first driver-truth PATH candidate reports, null when none answers. */
  local: string | null;
  /** That candidate's own resolved path — shown so a name collision or stale install is self-diagnosing (never set without `local`). */
  localPath: string | null;
  /** Set only when the PATH carries more than one distinct version of this tool. */
  multipleInstalls: MultipleInstalls | null;
};

export type CliVersionReport = {
  rig: CliVersionSources;
  tapd: CliVersionSources;
};

function readPackageVersion(pkgJsonPath: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/**
 * The bundled half of Settings → About's version rows: package.json manifest
 * reads only (same cheap check `logRigVersionSkew` does for the CLI,
 * extended to the vendored `@rigxyz/tapd` — see `scripts/vendor-rig-cli.ts`'s
 * output layout). Both null when not packaged (dev builds have nothing
 * bundled).
 */
export function readBundledCliVersions(): BundledCliVersions {
  const binDir = bundledRigBinDir();
  if (!binDir) return { rig: null, tapd: null };

  return {
    rig: readPackageVersion(path.join(process.resourcesPath, 'rig-cli', 'package.json')),
    tapd: readPackageVersion(
      path.join(process.resourcesPath, 'rig-cli', 'node_modules', '@rigxyz', 'tapd', 'package.json')
    ),
  };
}

/** `--version` on one resolved binary — bare semver on stdout for both `rig` and `tapd`. Null on any failure. */
function probeVersion(binPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      binPath,
      ['--version'],
      { timeout: VERSION_PROBE_TIMEOUT_MS, encoding: 'utf-8' },
      (probeError, stdout) => {
        if (probeError) {
          log.warn('[bundled-cli] Local version probe failed', {
            path: binPath,
            error: probeError.message,
          });
          resolve(null);
          return;
        }
        resolve(stdout.trim() || null);
      }
    );
  });
}

/**
 * The user's OWN installations of `name` — every PATH match that is NOT the
 * bundled shim dir (which `ensureBundledRigBinInPath` puts first, so a
 * plain PATH resolution would always answer "bundled"; this probe exists
 * precisely to see past it), deduped by real target and each probed for its
 * own version. `candidates[0]` is the one a dev build's `resolveCliBin`
 * would actually resolve to — the same `process.env.PATH` walk, not a
 * separate notion of "local."
 */
async function probeLocalInstalls(name: 'rig' | 'tapd'): Promise<{
  local: string | null;
  localPath: string | null;
  multipleInstalls: MultipleInstalls | null;
}> {
  const binDir = bundledRigBinDir();
  const paths = dedupeByRealPath(findOnPath(name).filter((entry) => path.dirname(entry) !== binDir));
  const candidates: ProbedInstall[] = await Promise.all(
    paths.map(async (p) => ({ path: p, version: await probeVersion(p) }))
  );
  return shapeLocalInstalls(candidates);
}

/** Successful probes cached for the app run — versions don't change under a running app. */
let localVersionsPromise: Promise<{
  rig: Awaited<ReturnType<typeof probeLocalInstalls>>;
  tapd: Awaited<ReturnType<typeof probeLocalInstalls>>;
}> | null = null;

function readLocalCliVersions() {
  localVersionsPromise ??= (async () => {
    const [rig, tapd] = await Promise.all([probeLocalInstalls('rig'), probeLocalInstalls('tapd')]);
    return { rig, tapd };
  })();
  return localVersionsPromise;
}

export const rigBundledCliController = createRPCController({
  /**
   * Settings → About's rig/tapd rows: BOTH sources per tool, so the row can
   * answer Dylan's actual question — "do my bundled and local installations
   * conflict?" — not just what's vendored. Bundled = manifest read; local =
   * `--version` spawns across every driver-truth PATH candidate (deliberately
   * skipping the bundled shim dir), cached per app run. The renderer's
   * `deriveCliVersionRow` turns the pair into the comparison label, the
   * resolved path, and the multi-install note.
   */
  getVersionReport: async (): Promise<CliVersionReport> => {
    const bundled = readBundledCliVersions();
    const local = await readLocalCliVersions();
    return {
      rig: { bundled: bundled.rig, ...local.rig },
      tapd: { bundled: bundled.tapd, ...local.tapd },
    };
  },
});
