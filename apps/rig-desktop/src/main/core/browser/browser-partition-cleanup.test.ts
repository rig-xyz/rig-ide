import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));

import { cleanupLegacyBrowserPartitions } from './browser-partition-cleanup';

describe('cleanupLegacyBrowserPartitions', () => {
  it("removes old tab partitions but keeps profiles, isolated tasks and Rig's page browsers", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'partitions-'));
    for (const name of [
      'emdash-browser-tab-1',
      'emdash-browser-profile',
      'emdash-browser-isolated-abc',
      'emdash-browser-rig-pages',
      'emdash-browser-rig-files',
      'something-else',
    ]) {
      mkdirSync(join(dir, name));
    }
    await cleanupLegacyBrowserPartitions(dir);
    expect(readdirSync(dir).sort()).toEqual([
      'emdash-browser-isolated-abc',
      'emdash-browser-profile',
      'emdash-browser-rig-files',
      'emdash-browser-rig-pages',
      'something-else',
    ]);
  });
});
