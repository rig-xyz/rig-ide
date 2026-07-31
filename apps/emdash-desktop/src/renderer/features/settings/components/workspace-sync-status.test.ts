import { describe, expect, it } from 'vitest';
import {
  formatLastSynced,
  hubWorkspaceUrl,
  isWorkspaceLive,
  LIVE_THRESHOLD_MS,
} from './workspace-sync-status';

const NOW = new Date('2026-07-31T12:00:00Z');

describe('formatLastSynced', () => {
  it('reports "Never synced" for null', () => {
    expect(formatLastSynced(null, NOW)).toBe('Never synced');
  });

  it('reports "Never synced" for an unparsable timestamp', () => {
    expect(formatLastSynced('not a date', NOW)).toBe('Never synced');
  });

  it('reports "just now" inside the live threshold', () => {
    const at = new Date(NOW.getTime() - 30_000).toISOString();
    expect(formatLastSynced(at, NOW)).toBe('just now');
  });

  it('reports a relative time past the live threshold, "N minutes ago"-style', () => {
    const at = new Date(NOW.getTime() - 2 * 60_000).toISOString();
    expect(formatLastSynced(at, NOW)).toBe('2 minutes ago');
  });

  it('reports hours and days the same way', () => {
    const hoursAgo = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
    expect(formatLastSynced(hoursAgo, NOW)).toBe('3 hours ago');
    const daysAgo = new Date(NOW.getTime() - 5 * 24 * 60 * 60_000).toISOString();
    expect(formatLastSynced(daysAgo, NOW)).toBe('5 days ago');
  });
});

describe('isWorkspaceLive', () => {
  it('is false for null (never synced)', () => {
    expect(isWorkspaceLive(null, NOW)).toBe(false);
  });

  it('is false for an unparsable timestamp', () => {
    expect(isWorkspaceLive('not a date', NOW)).toBe(false);
  });

  it('is true strictly inside the threshold', () => {
    const at = new Date(NOW.getTime() - (LIVE_THRESHOLD_MS - 1)).toISOString();
    expect(isWorkspaceLive(at, NOW)).toBe(true);
  });

  it('is false at and beyond the threshold', () => {
    const at = new Date(NOW.getTime() - LIVE_THRESHOLD_MS).toISOString();
    expect(isWorkspaceLive(at, NOW)).toBe(false);
  });
});

describe('hubWorkspaceUrl', () => {
  it('links to the binding on userig.xyz, deep-linked to the Share tab', () => {
    expect(hubWorkspaceUrl('bnd_1')).toBe('https://userig.xyz/home/workspaces/bnd_1?tab=share');
  });
});
