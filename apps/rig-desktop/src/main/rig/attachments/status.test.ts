import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachmentStatus, safeRelativePath } from './status';

let space: string;
let outside: string;

function state(paths: Record<string, { lastSeenHash: string; localDirty: boolean }>, notSynced?: unknown[]) {
  mkdirSync(join(space, '.rig', 'tap'), { recursive: true });
  const meta = notSynced ? { not_synced: JSON.stringify(notSynced) } : {};
  writeFileSync(join(space, '.rig', 'tap', 'state.local.db'), JSON.stringify({ version: 1, meta, paths }));
}

const deps = (manifest: Array<{ path: string; size: number }> | null = []) => ({
  resolveSpaceRoot: async (id: string) => (id === 'bnd' ? space : null),
  fetchManifest: async () => manifest,
});

beforeEach(() => {
  space = mkdtempSync(join(tmpdir(), 'rig-att-status-'));
  outside = mkdtempSync(join(tmpdir(), 'rig-att-out-'));
  mkdirSync(join(space, 'attachments'));
});
afterEach(() => {
  rmSync(space, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('safeRelativePath', () => {
  it('accepts plain relative paths only', () => {
    expect(safeRelativePath('attachments/a b.png')).toBe('attachments/a b.png');
    for (const bad of ['/etc/passwd', '../x', 'a/../b', 'a//b', 'a\\b', 'C:/x', '.rig/tap/state.local.db', '', './a']) {
      expect(safeRelativePath(bad)).toBeNull();
    }
  });
});

describe('attachmentStatus', () => {
  it('is null for a space not linked here', async () => {
    expect(await attachmentStatus(deps(), 'other', [{ path: 'a' }], { withRelay: false })).toBeNull();
  });

  it('says synced only when the daemon recorded this exact content with no local change', async () => {
    writeFileSync(join(space, 'attachments', 'a.png'), 'a');
    writeFileSync(join(space, 'attachments', 'b.png'), 'b');
    writeFileSync(join(space, 'attachments', 'c.png'), 'c');
    state({
      'attachments/a.png': { lastSeenHash: 'sha256:a', localDirty: false },
      'attachments/b.png': { lastSeenHash: 'sha256:old', localDirty: false },
      'attachments/c.png': { lastSeenHash: 'sha256:c', localDirty: true },
    });
    const result = await attachmentStatus(
      deps(),
      'bnd',
      [
        { path: 'attachments/a.png', hash: 'sha256:a' },
        { path: 'attachments/b.png', hash: 'sha256:b' },
        { path: 'attachments/c.png', hash: 'sha256:c' },
        { path: 'attachments/d.png', hash: 'sha256:d' },
      ],
      { withRelay: false }
    );
    expect(result!.map((s) => [s.exists, s.synced])).toEqual([
      [true, true],
      [true, false],
      [true, false],
      [false, false],
    ]);
  });

  it('reports files the daemon held back over the quota', async () => {
    writeFileSync(join(space, 'attachments', 'big.mp4'), 'v');
    state({}, [{ path: 'attachments/big.mp4', reason: 'quota_exceeded', hash: 'sha256:v', at: '' }]);
    const [s] = (await attachmentStatus(deps(), 'bnd', [{ path: 'attachments/big.mp4', hash: 'sha256:v' }], { withRelay: false }))!;
    expect(s).toMatchObject({ exists: true, synced: false, notSynced: 'overQuota' });
  });

  it('says whether a missing file is on the relay list, when asked', async () => {
    const result = await attachmentStatus(
      deps([{ path: 'attachments/coming.pdf', size: 1 }]),
      'bnd',
      [{ path: 'attachments/coming.pdf' }, { path: 'attachments/gone.pdf' }],
      { withRelay: true }
    );
    expect(result!.map((s) => [s.exists, s.onRelay, s.synced])).toEqual([
      [false, true, null],
      [false, false, null],
    ]);
  });

  it('never looks outside the space, even through a symlink', async () => {
    writeFileSync(join(outside, 'secret.txt'), 's');
    symlinkSync(join(outside, 'secret.txt'), join(space, 'attachments', 'link.txt'));
    const result = await attachmentStatus(
      deps(),
      'bnd',
      [{ path: 'attachments/link.txt' }, { path: '../secret.txt' }, { path: join(outside, 'secret.txt') }],
      { withRelay: false }
    );
    expect(result!.map((s) => s.exists)).toEqual([false, false, false]);
  });
});
