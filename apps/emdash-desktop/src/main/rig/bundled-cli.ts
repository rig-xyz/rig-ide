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

/** All matches for an executable `name` across process.env.PATH, in PATH order. */
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
