/**
 * Vendors @rigxyz/cli (plus its transitive deps, notably @rigxyz/tapd) into
 * `vendor/` so electron-builder can ship it inside Contents/Resources via
 * extraResources. Run with: node --experimental-strip-types scripts/vendor-rig-cli.ts
 *
 * Output layout (all of `vendor/` is a build artifact, gitignored):
 *   vendor/rig-cli/          the @rigxyz/cli package root (package.json, bin/, src/)
 *   vendor/rig-cli/node_modules/   all transitive deps, flattened
 *   vendor/rig-bin/rig       POSIX sh shim (0755) -> runs rig via the app's embedded Node
 *   vendor/rig-bin/tapd      POSIX sh shim (0755) -> runs tapd via the app's embedded Node
 *
 * The CLI has zero native modules and is fully relocatable; the shims use
 * ELECTRON_RUN_AS_NODE against the app binary so end users need no Node install.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** EXACT pins — a floating range must never change what ships in a signed build.
 *  These two must move together: @rigxyz/cli depends on @rigxyz/tapd via the
 *  floating range `^0.6.0`, so left unpinned tapd drifts independently of the
 *  CLI pin below it. Pin both explicitly and bump them in the same change. */
const RIG_CLI_VERSION = '0.12.0';
const TAPD_VERSION = '0.6.3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const vendorDir = path.join(appRoot, 'vendor');
const rigCliDir = path.join(vendorDir, 'rig-cli');
const rigBinDir = path.join(vendorDir, 'rig-bin');

function fail(message: string): never {
  console.error(`vendor-rig-cli: ${message}`);
  process.exit(1);
}

// Fast path: already vendored at both pinned versions. Shims are still rewritten
// so template changes in this script take effect without deleting vendor/.
// Both pins are checked — a fast path keyed on the CLI version alone is exactly
// how a stale tapd survived a re-vendor in production (see the tapd verify below).
const vendoredPkgJson = path.join(rigCliDir, 'package.json');
const vendoredTapdPkgJson = path.join(rigCliDir, 'node_modules', '@rigxyz', 'tapd', 'package.json');
if (existsSync(vendoredPkgJson) && existsSync(vendoredTapdPkgJson)) {
  try {
    const { version } = JSON.parse(readFileSync(vendoredPkgJson, 'utf-8')) as { version?: string };
    const { version: tapdVersion } = JSON.parse(readFileSync(vendoredTapdPkgJson, 'utf-8')) as {
      version?: string;
    };
    if (version === RIG_CLI_VERSION && tapdVersion === TAPD_VERSION) {
      writeShims();
      console.log(
        `vendor-rig-cli: @rigxyz/cli@${RIG_CLI_VERSION} + @rigxyz/tapd@${TAPD_VERSION} already vendored, refreshed shims only`
      );
      process.exit(0);
    }
  } catch {
    // fall through and re-vendor
  }
}

console.log(`vendor-rig-cli: vendoring @rigxyz/cli@${RIG_CLI_VERSION} + @rigxyz/tapd@${TAPD_VERSION}`);

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'rig-cli-vendor-'));
try {
  // --ignore-scripts: no dep has native builds, and it keeps the CLI's own
  // postinstall (which writes ~/.claude/skills on the *build* machine) from running.
  // tapd is installed alongside the CLI, pinned exactly, rather than left to
  // float on the CLI's `^0.6.0` range — npm hoists a single top-level copy since
  // the pin satisfies that range, and the flatten step below picks it up.
  try {
    execFileSync(
      'npm',
      [
        'install',
        '--prefix',
        tmpDir,
        `@rigxyz/cli@${RIG_CLI_VERSION}`,
        `@rigxyz/tapd@${TAPD_VERSION}`,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--omit=dev',
      ],
      { stdio: 'inherit', env: { ...process.env, RIG_SKIP_SKILL_INSTALL: '1' } }
    );
  } catch (err) {
    fail(
      `npm install failed for @rigxyz/cli@${RIG_CLI_VERSION} + @rigxyz/tapd@${TAPD_VERSION}. ` +
        `If @rigxyz/tapd@${TAPD_VERSION} is not yet published to npm, that pin is the missing package — ` +
        `wait for the publish or update TAPD_VERSION. (${err instanceof Error ? err.message : String(err)})`
    );
  }

  const installedCli = path.join(tmpDir, 'node_modules', '@rigxyz', 'cli');
  if (!existsSync(path.join(installedCli, 'bin', 'rig.mjs'))) {
    fail(`npm install did not produce ${installedCli}/bin/rig.mjs`);
  }
  const installedTapd = path.join(tmpDir, 'node_modules', '@rigxyz', 'tapd');
  if (!existsSync(path.join(installedTapd, 'package.json'))) {
    fail(`npm install did not produce ${installedTapd}/package.json — was @rigxyz/tapd@${TAPD_VERSION} hoisted top-level?`);
  }

  rmSync(rigCliDir, { recursive: true, force: true });
  rmSync(rigBinDir, { recursive: true, force: true });
  mkdirSync(vendorDir, { recursive: true });

  // Flatten: vendor/rig-cli = the package root, with all transitive deps in its
  // own node_modules. Copy the cli package first (keeps any nested node_modules
  // it might carry), then merge every other installed package alongside.
  cpSync(installedCli, rigCliDir, { recursive: true });
  const flatModules = path.join(tmpDir, 'node_modules');
  const targetModules = path.join(rigCliDir, 'node_modules');
  mkdirSync(targetModules, { recursive: true });
  for (const entry of readdirSync(flatModules)) {
    if (entry === '.bin' || entry === '.package-lock.json') continue;
    if (entry.startsWith('@')) {
      const scopeDir = path.join(flatModules, entry);
      for (const scoped of readdirSync(scopeDir)) {
        if (entry === '@rigxyz' && scoped === 'cli') continue; // that IS vendor/rig-cli
        const dest = path.join(targetModules, entry, scoped);
        if (!existsSync(dest)) cpSync(path.join(scopeDir, scoped), dest, { recursive: true });
      }
    } else {
      const dest = path.join(targetModules, entry);
      if (!existsSync(dest)) cpSync(path.join(flatModules, entry), dest, { recursive: true });
    }
  }

  // Strip source maps and type declarations — dead weight at runtime.
  stripFiles(rigCliDir);

  // Sanity: the tapd bin the shim points at must exist.
  const tapdBin = path.join(targetModules, '@rigxyz', 'tapd', 'dist', 'bin.js');
  if (!existsSync(tapdBin)) {
    fail(`expected tapd bin at ${tapdBin} — @rigxyz/tapd layout changed?`);
  }

  // electron-builder's extraResources copy filter drops any node_modules dir
  // that is top-level relative to a matcher's `from` and mangles nested ones
  // (see the extraResources comment in electron-builder.config.ts). The single
  // top-level node_modules is shipped via its own extraResources entry; a
  // NESTED one (npm creates those on version conflicts) would be silently
  // dropped from the .app, so fail loudly here instead.
  const nestedNodeModules = findDirsNamed(targetModules, 'node_modules');
  if (nestedNodeModules.length > 0) {
    fail(
      `vendored tree contains nested node_modules (electron-builder would drop them from the app):\n` +
        `  ${nestedNodeModules.join('\n  ')}\n` +
        `Flatten these deps or rework the extraResources mapping.`
    );
  }

  writeShims();

  // Verify with the build machine's system node (end users don't need one).
  const reportedRig = execFileSync('node', [path.join(rigCliDir, 'bin', 'rig.mjs'), '--version'], {
    encoding: 'utf-8',
  }).trim();
  if (reportedRig !== RIG_CLI_VERSION) {
    fail(`vendored rig --version reported "${reportedRig}", expected exactly "${RIG_CLI_VERSION}"`);
  }
  console.log(`vendor-rig-cli: OK — rig --version -> ${reportedRig}`);

  // Assert the vendored tapd package.json version matches the pin. Cheap, and
  // catches range drift (tapd installed off-pin) separately from a stale
  // compiled dist — see the runtime check below for the latter.
  const tapdPkgJsonPath = path.join(targetModules, '@rigxyz', 'tapd', 'package.json');
  const { version: vendoredTapdManifestVersion } = JSON.parse(
    readFileSync(tapdPkgJsonPath, 'utf-8')
  ) as { version?: string };
  if (vendoredTapdManifestVersion !== TAPD_VERSION) {
    fail(
      `vendored @rigxyz/tapd package.json version is "${vendoredTapdManifestVersion}", expected exactly "${TAPD_VERSION}"`
    );
  }

  // RUNTIME verification, not just a manifest check: a published npm package's
  // package.json version can disagree with its compiled dist/bin.js. This is
  // exactly what shipped in production — @rigxyz/tapd's manifest said 0.6.2 but
  // dist/bin.js was a stale compile stamping (and behaving as) 0.6.1, because
  // the upstream npm publish had shipped a stale dist. Only running the actual
  // binary catches that; a manifest-only check would have passed silently.
  const reportedTapd = execFileSync('node', [tapdBin, '--version'], { encoding: 'utf-8' }).trim();
  if (reportedTapd !== TAPD_VERSION) {
    fail(
      `vendored tapd --version reported "${reportedTapd}", expected exactly "${TAPD_VERSION}" ` +
        `(package.json said "${vendoredTapdManifestVersion}"). The compiled dist/bin.js disagrees with ` +
        `the manifest — a manifest-only check would not have caught this.`
    );
  }
  console.log(`vendor-rig-cli: OK — tapd --version -> ${reportedTapd}`);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

/** Recursively finds directories named `name` under `root`. */
function findDirsNamed(root: string, name: string): string[] {
  const hits: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    if (entry.name === name) hits.push(full);
    hits.push(...findDirsNamed(full, name));
  }
  return hits;
}

function stripFiles(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      stripFiles(full);
    } else if (entry.name.endsWith('.map') || entry.name.endsWith('.d.ts')) {
      unlinkSync(full);
    }
  }
}

function writeShims(): void {
  mkdirSync(rigBinDir, { recursive: true });

  // Shims land at Contents/Resources/rig-bin/{rig,tapd} on macOS (extraResources).
  // The app executable in Contents/MacOS is named after electron-builder's
  // productName ("Rig" / "Rig Canary"); instead of hardcoding that coupling we
  // glob Contents/MacOS, which for an Electron app contains exactly one binary.
  const resolvePrelude = `set -e
DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)   # .../Contents/Resources/rig-bin
RESOURCES=$(dirname -- "$DIR")                          # .../Contents/Resources
MACOS_DIR="$RESOURCES/../MacOS"
APP_EXE=''
COUNT=0
for f in "$MACOS_DIR"/*; do
  [ -f "$f" ] && [ -x "$f" ] || continue
  COUNT=$((COUNT + 1))
  APP_EXE="$f"
done
if [ "$COUNT" -ne 1 ]; then
  echo "rig shim: expected exactly one executable in $MACOS_DIR, found $COUNT" >&2
  exit 1
fi`;

  // RIG_TAPD_BIN is REQUIRED, not an optimization: without it the CLI's
  // tapdCmd() prefixes the resolved tapd bin with process.execPath — which is
  // the Rig GUI binary here — and any child env that drops ELECTRON_RUN_AS_NODE
  // (the agent env allowlist does) would launch a second GUI app instance.
  const rigShim = `#!/bin/sh
# Bundled rig shim — generated by scripts/vendor-rig-cli.ts. Do not edit in place.
# Runs the vendored @rigxyz/cli with the Rig app's embedded Node (no system Node needed).
${resolvePrelude}
ELECTRON_RUN_AS_NODE=1 RIG_TAPD_BIN="$DIR/tapd" exec "$APP_EXE" "$RESOURCES/rig-cli/bin/rig.mjs" "$@"
`;

  const tapdShim = `#!/bin/sh
# Bundled tapd shim — generated by scripts/vendor-rig-cli.ts. Do not edit in place.
# Runs the vendored @rigxyz/tapd with the Rig app's embedded Node (no system Node needed).
${resolvePrelude}
ELECTRON_RUN_AS_NODE=1 exec "$APP_EXE" "$RESOURCES/rig-cli/node_modules/@rigxyz/tapd/dist/bin.js" "$@"
`;

  writeFileSync(path.join(rigBinDir, 'rig'), rigShim);
  writeFileSync(path.join(rigBinDir, 'tapd'), tapdShim);
  chmodSync(path.join(rigBinDir, 'rig'), 0o755);
  chmodSync(path.join(rigBinDir, 'tapd'), 0o755);
  // statSync guards against exotic umask/filesystem behavior silently shipping
  // non-executable shims.
  for (const name of ['rig', 'tapd']) {
    const mode = statSync(path.join(rigBinDir, name)).mode & 0o777;
    if (mode !== 0o755) fail(`shim ${name} has mode ${mode.toString(8)}, expected 755`);
  }
}
