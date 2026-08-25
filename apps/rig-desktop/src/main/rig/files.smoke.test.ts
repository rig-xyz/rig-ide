import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rigFilesController } from './files';

/**
 * Manual relay/fs smoke check against the developer's real `knee-ability-rig`
 * checkout — the P0 rig-desktop port's "does the file-list rpc return real
 * entries" verification. Skips itself on any machine without that folder
 * (CI, another contributor) rather than failing the suite for everyone.
 */
const ROOT = join(homedir(), 'Code', 'knee-ability-rig');

describe.skipIf(!existsSync(ROOT))('rigFilesController.list against knee-ability-rig', () => {
  it('returns real entries, ignoring .git/node_modules but including dotfiles/.rig for the navigator to categorize', async () => {
    const result = await rigFilesController.list(ROOT);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const names = result.data.map((n) => n.name);
    expect(names).toContain('exercises.md');
    expect(names).toContain('rig.toml');
    expect(names).not.toContain('.git');
    // File-navigator redesign: `.rig`/dotfiles are no longer filtered out
    // at the listing level — they're System-classified and hidden behind
    // the tree's "Show system files" toggle instead
    // (`shared/rig/file-navigator-categories.ts`), so the raw RPC result
    // includes them now. `.git`/`node_modules` are the one deliberate
    // exception — see `files.ts`'s own `IGNORED_NAMES` comment for why.
    expect(names).toContain('.rig');
  });
});
