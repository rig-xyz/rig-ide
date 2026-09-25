import { describe, expect, it } from 'vitest';
import type { RigSpaceStatus } from '@shared/rig/space-status';
import {
  countNeedsApproval,
  deriveSpaceTileState,
  deriveSpaceStatusLine,
  filterSpaceRows,
  indexSpaceStatuses,
  RECENT_ENDED_MS,
  sortSpaceRowsByActivity,
  spaceIsActive,
  spaceNeedsApproval,
} from './space-status-state';

const NOW = Date.parse('2026-09-25T12:00:00Z');

function running(over: Partial<RigSpaceStatus['running'][number]> = {}): RigSpaceStatus['running'][number] {
  return {
    runId: 'run_1',
    agent: 'claude',
    ownerUserId: 'user_1',
    startedAt: new Date(NOW - 60_000).toISOString(),
    activity: 'editing',
    ...over,
  };
}

describe('indexSpaceStatuses', () => {
  it('maps by bindingId', () => {
    const map = indexSpaceStatuses([{ bindingId: 'a', running: [] }, { bindingId: 'b', running: [] }]);
    expect(map.get('a')?.bindingId).toBe('a');
    expect(map.get('c')).toBeUndefined();
  });
});

describe('deriveSpaceTileState', () => {
  it('a running item wins, regardless of any lastRun', () => {
    const status: RigSpaceStatus = { bindingId: 'x', running: [running()], lastRun: { status: 'done', endedAt: new Date(NOW).toISOString(), agent: 'claude', ownerUserId: 'u' } };
    expect(deriveSpaceTileState(status, NOW)).toEqual({ kind: 'live', state: 'editing' });
  });

  it('a running item with no activity still shows live, defaulting to thinking', () => {
    const status: RigSpaceStatus = { bindingId: 'x', running: [running({ activity: null })] };
    expect(deriveSpaceTileState(status, NOW)).toEqual({ kind: 'live', state: 'thinking' });
  });

  it('a recently-ended run shows its own end glyph', () => {
    const status: RigSpaceStatus = {
      bindingId: 'x',
      running: [],
      lastRun: { status: 'done', endedAt: new Date(NOW - 60_000).toISOString(), agent: 'claude', ownerUserId: 'u' },
    };
    expect(deriveSpaceTileState(status, NOW)).toEqual({ kind: 'end', state: 'done' });
  });

  it('failed/stopped map to their own end glyphs', () => {
    const failed: RigSpaceStatus = { bindingId: 'x', running: [], lastRun: { status: 'failed', endedAt: new Date(NOW - 60_000).toISOString(), agent: 'codex', ownerUserId: 'u' } };
    const stopped: RigSpaceStatus = { bindingId: 'x', running: [], lastRun: { status: 'stopped', endedAt: new Date(NOW - 60_000).toISOString(), agent: 'codex', ownerUserId: 'u' } };
    expect(deriveSpaceTileState(failed, NOW)).toEqual({ kind: 'end', state: 'failed' });
    expect(deriveSpaceTileState(stopped, NOW)).toEqual({ kind: 'end', state: 'stopped' });
  });

  it('an old lastRun settles back to quiet, past RECENT_ENDED_MS', () => {
    const status: RigSpaceStatus = {
      bindingId: 'x',
      running: [],
      lastRun: { status: 'done', endedAt: new Date(NOW - RECENT_ENDED_MS - 1000).toISOString(), agent: 'claude', ownerUserId: 'u' },
    };
    expect(deriveSpaceTileState(status, NOW)).toEqual({ kind: 'quiet' });
  });

  it('no status at all, or no runs ever — quiet', () => {
    expect(deriveSpaceTileState(undefined, NOW)).toEqual({ kind: 'quiet' });
    expect(deriveSpaceTileState({ bindingId: 'x', running: [] }, NOW)).toEqual({ kind: 'quiet' });
  });
});

describe('deriveSpaceStatusLine', () => {
  it('a running edit reads "{Agent} editing {title}"', () => {
    const status: RigSpaceStatus = { bindingId: 'x', running: [running({ agent: 'codex', activity: 'editing', title: 'metrics.md' })] };
    expect(deriveSpaceStatusLine(status, NOW)).toBe('Codex editing metrics.md');
  });

  it('a running edit with no title still reads as a sentence', () => {
    const status: RigSpaceStatus = { bindingId: 'x', running: [running({ title: undefined })] };
    expect(deriveSpaceStatusLine(status, NOW)).toBe('Claude editing');
  });

  it('waiting reads as a full sentence, not "Claude waiting"', () => {
    const status: RigSpaceStatus = { bindingId: 'x', running: [running({ activity: 'waiting', title: 'Create an issue' })] };
    expect(deriveSpaceStatusLine(status, NOW)).toBe('Claude is waiting on you');
  });

  it('a recently-ended run reads "{Agent} finished · Xm"', () => {
    const status: RigSpaceStatus = {
      bindingId: 'x',
      running: [],
      lastRun: { status: 'done', endedAt: new Date(NOW - 3 * 60_000).toISOString(), agent: 'codex', ownerUserId: 'u' },
    };
    expect(deriveSpaceStatusLine(status, NOW)).toBe('Codex finished · 3m ago');
  });

  it('a failed run reads "failed", a stopped one reads "stopped"', () => {
    const failed: RigSpaceStatus = { bindingId: 'x', running: [], lastRun: { status: 'failed', endedAt: new Date(NOW - 60_000).toISOString(), agent: 'claude', ownerUserId: 'u' } };
    expect(deriveSpaceStatusLine(failed, NOW)).toBe('Claude failed · 1m ago');
  });

  it('an old lastRun reads "Quiet · Xd"', () => {
    const status: RigSpaceStatus = {
      bindingId: 'x',
      running: [],
      lastRun: { status: 'done', endedAt: new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString(), agent: 'claude', ownerUserId: 'u' },
    };
    expect(deriveSpaceStatusLine(status, NOW)).toBe('Quiet · 2d ago');
  });

  it('never ran at all — plain "Quiet"', () => {
    expect(deriveSpaceStatusLine(undefined, NOW)).toBe('Quiet');
    expect(deriveSpaceStatusLine({ bindingId: 'x', running: [] }, NOW)).toBe('Quiet');
  });
});

describe('spaceNeedsApproval / spaceIsActive', () => {
  const selfId = 'user_1';

  it('true only when a run YOU own is waiting', () => {
    const mine: RigSpaceStatus = { bindingId: 'x', running: [running({ activity: 'waiting', ownerUserId: selfId })] };
    const theirs: RigSpaceStatus = { bindingId: 'x', running: [running({ activity: 'waiting', ownerUserId: 'someone_else' })] };
    const mineNotWaiting: RigSpaceStatus = { bindingId: 'x', running: [running({ activity: 'editing', ownerUserId: selfId })] };
    expect(spaceNeedsApproval(mine, selfId)).toBe(true);
    expect(spaceNeedsApproval(theirs, selfId)).toBe(false);
    expect(spaceNeedsApproval(mineNotWaiting, selfId)).toBe(false);
    expect(spaceNeedsApproval(mine, null)).toBe(false);
  });

  it('spaceIsActive is just "something is running"', () => {
    expect(spaceIsActive({ bindingId: 'x', running: [running()] })).toBe(true);
    expect(spaceIsActive({ bindingId: 'x', running: [] })).toBe(false);
    expect(spaceIsActive(undefined)).toBe(false);
  });
});

describe('filterSpaceRows / countNeedsApproval', () => {
  const rows = [
    { bindingId: 'a', name: 'growth' },
    { bindingId: 'b', name: 'launch' },
    { bindingId: 'c', name: 'ops' },
  ];
  const statusByBinding = new Map<string, RigSpaceStatus>([
    ['a', { bindingId: 'a', running: [running({ activity: 'waiting', ownerUserId: 'me' })] }],
    ['b', { bindingId: 'b', running: [running({ activity: 'editing' })] }],
  ]);
  const ctx = { statusByBinding, pinnedIds: new Set(['c']), selfUserId: 'me' };

  it('all — everything', () => {
    expect(filterSpaceRows(rows, 'all', ctx).map((r) => r.bindingId)).toEqual(['a', 'b', 'c']);
  });
  it('needsYou — only rows waiting on the caller', () => {
    expect(filterSpaceRows(rows, 'needsYou', ctx).map((r) => r.bindingId)).toEqual(['a']);
  });
  it('active — anything running', () => {
    expect(filterSpaceRows(rows, 'active', ctx).map((r) => r.bindingId)).toEqual(['a', 'b']);
  });
  it('pinned — only pinned bindingIds', () => {
    expect(filterSpaceRows(rows, 'pinned', ctx).map((r) => r.bindingId)).toEqual(['c']);
  });
  it('countNeedsApproval matches the needsYou filter', () => {
    expect(countNeedsApproval(rows, statusByBinding, 'me')).toBe(1);
  });
});

describe('sortSpaceRowsByActivity', () => {
  it('ranks needs-you, then live, then recently-ended, then quiet — name breaks remaining ties', () => {
    const rows = [
      { bindingId: 'quiet', name: 'z-quiet' },
      { bindingId: 'ended', name: 'ended' },
      { bindingId: 'live', name: 'live' },
      { bindingId: 'waiting', name: 'waiting' },
    ];
    const statusByBinding = new Map<string, RigSpaceStatus>([
      ['ended', { bindingId: 'ended', running: [], lastRun: { status: 'done', endedAt: new Date(NOW - 60_000).toISOString(), agent: 'claude', ownerUserId: 'u' } }],
      ['live', { bindingId: 'live', running: [running({ ownerUserId: 'someone_else', activity: 'editing' })] }],
      ['waiting', { bindingId: 'waiting', running: [running({ ownerUserId: 'me', activity: 'waiting' })] }],
    ]);
    const sorted = sortSpaceRowsByActivity(rows, statusByBinding, 'me', NOW);
    expect(sorted.map((r) => r.bindingId)).toEqual(['waiting', 'live', 'ended', 'quiet']);
  });
});
