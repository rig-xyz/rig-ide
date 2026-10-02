import { describe, expect, it } from 'vitest';
import { describeSyncHealth } from './sync-health';

describe('describeSyncHealth', () => {
  it('says nothing while syncing, or for a folder that never syncs', () => {
    expect(describeSyncHealth({ state: 'running' })).toBeNull();
    expect(describeSyncHealth({ state: 'notSynced' })).toBeNull();
    expect(describeSyncHealth(null)).toBeNull();
  });

  it('says plainly that files may be out of date, with the fix', () => {
    expect(describeSyncHealth({ state: 'paused', pausedAt: null, reason: null })).toMatchObject({
      text: 'Sync is paused on this computer. Your files may be out of date.',
      action: 'Resume',
    });
    expect(describeSyncHealth({ state: 'stopped' })).toMatchObject({
      short: 'Not syncing',
      line: 'Not syncing on this computer',
      action: 'Start syncing',
    });
    expect(describeSyncHealth({ state: 'starting' })).toMatchObject({ line: 'Starting sync…', action: null });
    expect(describeSyncHealth({ state: 'error', message: 'Bad CPU type in executable' })).toMatchObject({
      tone: 'bad',
      detail: 'Bad CPU type in executable',
      action: 'Try again',
    });
  });

  it('offers no resume for a space that was deleted or left', () => {
    expect(describeSyncHealth({ state: 'paused', pausedAt: null, reason: 'deleted' })?.action).toBeNull();
  });
});
