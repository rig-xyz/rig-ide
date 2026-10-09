import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSyncState } from './usage';

let space: string;

function writeState(notSynced: unknown[]) {
  mkdirSync(join(space, '.rig', 'tap'), { recursive: true });
  writeFileSync(
    join(space, '.rig', 'tap', 'state.local.db'),
    JSON.stringify({ version: 1, meta: { not_synced: JSON.stringify(notSynced) }, paths: {} })
  );
}

beforeEach(() => {
  space = mkdtempSync(join(tmpdir(), 'rig-usage-'));
});
afterEach(() => {
  rmSync(space, { recursive: true, force: true });
});

describe('readSyncState', () => {
  it('keeps owner_only as its own reason instead of reading it as quota_exceeded', async () => {
    writeState([
      { path: 'CLAUDE.md', reason: 'owner_only', hash: 'sha256:c', at: '' },
      { path: 'big.mp4', reason: 'file_too_large', at: '' },
      { path: 'full.pdf', reason: 'quota_exceeded', hash: 'sha256:f', at: '' },
    ]);
    const state = await readSyncState(space);
    expect(state?.notSynced.get('CLAUDE.md')).toEqual({ reason: 'owner_only', hash: 'sha256:c' });
    expect(state?.notSynced.get('big.mp4')).toEqual({ reason: 'file_too_large', hash: null });
    expect(state?.notSynced.get('full.pdf')).toEqual({ reason: 'quota_exceeded', hash: 'sha256:f' });
  });
});
