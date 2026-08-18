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
  it('returns real entries, ignoring .git/.rig/node_modules/dotfiles', async () => {
    const result = await rigFilesController.list(ROOT);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const names = result.data.map((n) => n.name);
    expect(names).toContain('exercises.md');
    expect(names).toContain('rig.toml');
    expect(names).not.toContain('.git');
    expect(names).not.toContain('.rig');
  });
});
