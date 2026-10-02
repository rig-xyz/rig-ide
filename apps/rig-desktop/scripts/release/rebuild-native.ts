import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';
import { parseArgs } from 'node:util';
import { rebuild } from '@electron/rebuild';
import { NATIVE_MODULES } from './lib/config.ts';
import { exec } from './lib/exec.ts';
import { fail, info, step } from './lib/log.ts';

const { values } = parseArgs({
  options: {
    arch: { type: 'string' },
    'deploy-dir': { type: 'string' },
  },
  strict: true,
});

const arch = values.arch;
if (!arch || !['arm64', 'x64'].includes(arch)) {
  fail('Usage: rebuild-native.ts --arch arm64|x64 [--deploy-dir <path>]');
}

const deployDir = values['deploy-dir'];
const buildPath = deployDir ?? cwd();

const electronVersion = exec('node -p "require(\'electron/package.json\').version"');
step(`Rebuilding native modules for ${arch} (Electron ${electronVersion})`);

await rebuild({
  buildPath,
  electronVersion,
  arch,
  onlyModules: NATIVE_MODULES,
  force: true,
  buildFromSource: true,
});

// A module listed here but left without a compiled .node would ship and fail
// (or fall back) at runtime; stop the release instead.
function hasCompiledAddon(dir: string): boolean {
  try {
    return readdirSync(dir, { recursive: true }).some((entry) => String(entry).endsWith('.node'));
  } catch {
    return false;
  }
}
const missing = NATIVE_MODULES.filter((name) => !hasCompiledAddon(join(buildPath, 'node_modules', name)));
if (missing.length > 0) fail(`No compiled .node after the rebuild for: ${missing.join(', ')}`);

info(`Native modules rebuilt for ${arch}`);
