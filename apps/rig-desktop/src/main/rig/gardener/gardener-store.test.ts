import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFileGardenerStore } from './gardener-store';
import type { GardenerRecord } from './gardener';

vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

const record: GardenerRecord = {
  starts: [1, 2],
  lastStartedMs: 2,
  lastFinishedMs: 3,
  lastStatus: 'done',
  fingerprint: '4:5',
  lastNote: 'one line',
  nameAtStart: 'bright-harbor',
  renameDone: false,
};

let dir: string | null = null;
const tmp = () => (dir = mkdtempSync(join(tmpdir(), 'gardener-')));
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('createFileGardenerStore', () => {
  it('keeps a record across a restart', () => {
    const file = join(tmp(), 'nested', 'rig-gardener.json');
    createFileGardenerStore(file).set('bnd_1', record);
    expect(createFileGardenerStore(file).get('bnd_1')).toEqual(record);
    expect(createFileGardenerStore(file).get('bnd_2')).toBeNull();
  });
  it('treats an unreadable file as empty', () => {
    const file = join(tmp(), 'rig-gardener.json');
    writeFileSync(file, '{not json');
    const store = createFileGardenerStore(file);
    expect(store.get('bnd_1')).toBeNull();
    store.set('bnd_1', record);
    expect(store.get('bnd_1')).toEqual(record);
  });
});
