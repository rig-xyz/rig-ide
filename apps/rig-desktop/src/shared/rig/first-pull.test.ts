import { describe, expect, it } from 'vitest';
import { firstPullFrom, stillSyncingDetail } from './first-pull';

describe('firstPullFrom', () => {
  it('stays syncing while tapd has changes left to apply', () => {
    expect(firstPullFrom({ pendingApplies: 12, offline: false })).toEqual({ state: 'syncing', pending: 12 });
  });

  it('is done only once tapd reached the relay with nothing left to apply', () => {
    expect(firstPullFrom({ pendingApplies: 0, offline: false })).toEqual({ state: 'done' });
  });

  it('stays syncing without a count while the relay is out of reach', () => {
    expect(firstPullFrom({ pendingApplies: 0, offline: true })).toEqual({ state: 'syncing', pending: null });
  });

  it('is unknown when tapd gave no answer', () => {
    expect(firstPullFrom(null)).toEqual({ state: 'unknown' });
  });
});

describe('stillSyncingDetail', () => {
  it('counts what is left, and says so when the probe was capped', () => {
    expect(stillSyncingDetail({ state: 'syncing', pending: 1 })).toBe('1 change to go');
    expect(stillSyncingDetail({ state: 'syncing', pending: 42 })).toBe('42 changes to go');
    expect(stillSyncingDetail({ state: 'syncing', pending: 100 })).toBe('100 or more changes to go');
    expect(stillSyncingDetail({ state: 'syncing', pending: null })).toBeNull();
    expect(stillSyncingDetail({ state: 'done' })).toBeNull();
    expect(stillSyncingDetail(null)).toBeNull();
  });
});
