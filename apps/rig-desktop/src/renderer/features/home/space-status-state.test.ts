import { describe, expect, it } from 'vitest';
import type { RigSpaceStatus } from '@shared/rig/space-status';
import {
  baselineMarker,
  countNeedsApproval,
  countNewMessages,
  deriveSpaceAttention,
  deriveSpaceStatusLine,
  DICE_FACES,
  filterSpaceRows,
  idlePattern,
  indexSpaceStatuses,
  RESERVED_PATTERNS,
  sortSpaceRowsByActivity,
  spaceIsActive,
  spaceNeedsApproval,
  spaceStatusLineTone,
  type SpaceAttention,
  type SpaceSeenMarker,
} from './space-status-state';

const NOW = Date.parse('2026-09-25T12:00:00Z');

function running(over: Partial<RigSpaceStatus['running'][number]> = {}): RigSpaceStatus['running'][number] {
  return {
    runId: 'run_1',
    agent: 'claude',
    ownerUserId: 'me',
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

const SELF = 'me';
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function msg(seq: number, authorUserId = 'sam', over: Partial<NonNullable<RigSpaceStatus['recentMessages']>[number]> = {}) {
  return { id: `m${seq}`, seq, createdAt: iso((100 - seq) * 60_000), authorUserId, authorKind: 'user' as const, ...over };
}

function lastRun(
  status: 'done' | 'failed' | 'stopped',
  msAgo: number,
  agent: 'claude' | 'codex' = 'claude',
  owner: { ownerUserId: string; ownerName?: string } = { ownerUserId: SELF }
) {
  return { status, endedAt: iso(msAgo), agent, ...owner };
}

/** Opened 30 minutes ago, having read up to seq 10. */
const MARKER: SpaceSeenMarker = { lastSeenSeq: 10, openedAt: NOW - 30 * 60_000 };

describe('deriveSpaceAttention — priority', () => {
  it('a running item wins over everything, defaulting a missing activity to thinking', () => {
    const status: RigSpaceStatus = {
      bindingId: 'x',
      running: [running({ activity: null })],
      lastRun: lastRun('failed', 60_000),
      recentMessages: [msg(11), msg(12)],
    };
    expect(deriveSpaceAttention(status, MARKER, SELF)).toEqual({ kind: 'live', state: 'thinking' });
    expect(deriveSpaceAttention({ ...status, running: [running()] }, MARKER, SELF)).toEqual({ kind: 'live', state: 'editing' });
  });

  it('an unseen failure beats new messages', () => {
    const status: RigSpaceStatus = { bindingId: 'x', running: [], lastRun: lastRun('failed', 60_000, 'codex'), recentMessages: [msg(11)] };
    expect(deriveSpaceAttention(status, MARKER, SELF)).toEqual({ kind: 'failed', agent: 'codex', endedAt: NOW - 60_000 });
  });

  it('an unseen finish beats new messages', () => {
    const status: RigSpaceStatus = { bindingId: 'x', running: [], lastRun: lastRun('done', 60_000), recentMessages: [msg(11)] };
    expect(deriveSpaceAttention(status, MARKER, SELF).kind).toBe('finished');
  });

  it('new messages beat idle', () => {
    const status: RigSpaceStatus = { bindingId: 'x', running: [], recentMessages: [msg(9), msg(11), msg(12)] };
    expect(deriveSpaceAttention(status, MARKER, SELF)).toEqual({ kind: 'messages', count: 2 });
  });

  it('nothing for you is idle, carrying the latest activity (or none)', () => {
    const status: RigSpaceStatus = { bindingId: 'x', running: [], lastRun: lastRun('done', 2 * 3_600_000), recentMessages: [msg(9)] };
    // The newest of the run's end (2h ago) and the read message (91m ago).
    expect(deriveSpaceAttention(status, MARKER, SELF)).toEqual({ kind: 'idle', lastActivityAt: NOW - 91 * 60_000 });
    expect(deriveSpaceAttention({ bindingId: 'x', running: [] }, MARKER, SELF)).toEqual({ kind: 'idle', lastActivityAt: null });
    expect(deriveSpaceAttention(undefined, null, SELF)).toEqual({ kind: 'idle', lastActivityAt: null });
  });
});

describe('deriveSpaceAttention — unseen vs seen', () => {
  it('a run that ended before you last opened the space is seen', () => {
    const status: RigSpaceStatus = { bindingId: 'x', running: [], lastRun: lastRun('failed', 40 * 60_000) };
    expect(deriveSpaceAttention(status, MARKER, SELF).kind).toBe('idle');
  });

  it('opening the space clears an outcome and messages at once', () => {
    const status: RigSpaceStatus = { bindingId: 'x', running: [], lastRun: lastRun('failed', 60_000), recentMessages: [msg(11), msg(12)] };
    expect(deriveSpaceAttention(status, MARKER, SELF).kind).toBe('failed');
    expect(deriveSpaceAttention(status, { lastSeenSeq: 12, openedAt: NOW }, SELF)).toEqual({
      kind: 'idle',
      lastActivityAt: NOW - 60_000,
    });
  });

  it('a stopped run is never flagged — it falls through to messages, then idle', () => {
    const status: RigSpaceStatus = { bindingId: 'x', running: [], lastRun: lastRun('stopped', 60_000), recentMessages: [msg(11)] };
    expect(deriveSpaceAttention(status, MARKER, SELF)).toEqual({ kind: 'messages', count: 1 });
  });

  it('with no marker at all nothing reads as unseen', () => {
    const status: RigSpaceStatus = { bindingId: 'x', running: [], lastRun: lastRun('failed', 60_000), recentMessages: [msg(11)] };
    expect(deriveSpaceAttention(status, null, SELF).kind).toBe('idle');
    expect(deriveSpaceAttention(status, { lastSeenSeq: null, openedAt: null }, SELF).kind).toBe('idle');
  });

  it('your own messages (and your agent turns) never count; a guest on your share link does', () => {
    const status: RigSpaceStatus = {
      bindingId: 'x',
      running: [],
      recentMessages: [msg(11, SELF), msg(12, SELF, { authorKind: 'agent' }), msg(13, SELF, { authorKind: 'guest' }), msg(14)],
    };
    expect(countNewMessages(status, 10, SELF)).toBe(2);
  });

  it('counts only messages after the read marker, and none without one', () => {
    const status: RigSpaceStatus = { bindingId: 'x', running: [], recentMessages: [msg(8), msg(10), msg(11)] };
    expect(countNewMessages(status, 10, SELF)).toBe(1);
    expect(countNewMessages(status, null, SELF)).toBe(0);
  });

  it('nine of nine newer caps at 9 ("9+")', () => {
    const nine = Array.from({ length: 9 }, (_, i) => msg(20 + i));
    const status: RigSpaceStatus = { bindingId: 'x', running: [], recentMessages: nine };
    expect(deriveSpaceAttention(status, MARKER, SELF)).toEqual({ kind: 'messages', count: 9 });
  });
});

describe('deriveSpaceStatusLine', () => {
  const line = (status: RigSpaceStatus | undefined, marker: SpaceSeenMarker | null = MARKER) =>
    deriveSpaceStatusLine(status, deriveSpaceAttention(status, marker, SELF), NOW);

  it('a running edit reads "{Agent} editing {title}", or without a title still as a sentence', () => {
    expect(line({ bindingId: 'x', running: [running({ agent: 'codex', title: 'metrics.md' })] })).toBe('Codex editing metrics.md');
    expect(line({ bindingId: 'x', running: [running({ title: undefined })] })).toBe('Claude editing');
  });

  it('waiting reads as a full sentence, not "Claude waiting"', () => {
    expect(line({ bindingId: 'x', running: [running({ activity: 'waiting', title: 'Create an issue' })] })).toBe(
      'Claude is waiting on you'
    );
  });

  it('an unseen outcome reads "{Agent} failed/finished · time ago"', () => {
    expect(line({ bindingId: 'x', running: [], lastRun: lastRun('failed', 60 * 60_000 - 1, 'codex') }, { lastSeenSeq: 0, openedAt: NOW - 2 * 3_600_000 })).toBe(
      'Codex failed · 1h ago'
    );
    expect(line({ bindingId: 'x', running: [], lastRun: lastRun('done', 20 * 60_000) })).toBe('Claude finished · 20m ago');
  });

  it('new messages read "1 new message", "N new messages", "9+ new messages"', () => {
    expect(line({ bindingId: 'x', running: [], recentMessages: [msg(11)] })).toBe('1 new message');
    expect(line({ bindingId: 'x', running: [], recentMessages: [msg(11), msg(12), msg(13)] })).toBe('3 new messages');
    const nine = Array.from({ length: 9 }, (_, i) => msg(20 + i));
    expect(line({ bindingId: 'x', running: [], recentMessages: nine })).toBe('9+ new messages');
  });

  it("names someone else's agent by the owner's first name; yours stays plain", () => {
    const sam = { ownerUserId: 'sam', ownerName: 'Sam Lee' };
    expect(line({ bindingId: 'x', running: [], lastRun: lastRun('done', 5 * 60_000, 'claude', sam) })).toBe("Sam's Claude finished · 5m ago");
    expect(line({ bindingId: 'x', running: [], lastRun: lastRun('failed', 5 * 60_000, 'codex', sam) })).toBe("Sam's Codex failed · 5m ago");
    expect(line({ bindingId: 'x', running: [running({ ...sam, title: 'metrics.md' })] })).toBe("Sam's Claude editing metrics.md");
    expect(line({ bindingId: 'x', running: [running({ ...sam, activity: null })] })).toBe("Sam's Claude working");
    // Their agent waits on them, not on you.
    expect(line({ bindingId: 'x', running: [running({ ...sam, activity: 'waiting' })] })).toBe("Sam's Claude is waiting on Sam");
    expect(line({ bindingId: 'x', running: [], lastRun: lastRun('done', 5 * 60_000) })).toBe('Claude finished · 5m ago');
  });

  it("falls back to \"A teammate's\" when the owner's name isn't known, and to plain when who you are isn't", () => {
    const unnamed = { ownerUserId: 'sam' };
    expect(line({ bindingId: 'x', running: [], lastRun: lastRun('done', 5 * 60_000, 'claude', unnamed) })).toBe(
      "A teammate's Claude finished · 5m ago"
    );
    expect(line({ bindingId: 'x', running: [running({ ...unnamed, activity: 'waiting' })] })).toBe(
      "A teammate's Claude is waiting for approval"
    );
    const status: RigSpaceStatus = { bindingId: 'x', running: [], lastRun: lastRun('done', 5 * 60_000, 'claude', unnamed) };
    expect(deriveSpaceStatusLine(status, deriveSpaceAttention(status, MARKER, null), NOW)).toBe('Claude finished · 5m ago');
  });

  it('idle reads the latest activity as a relative time, or "No activity yet"', () => {
    expect(line({ bindingId: 'x', running: [], lastRun: lastRun('done', 2 * 24 * 3_600_000) })).toBe('2d ago');
    expect(line({ bindingId: 'x', running: [], recentMessages: [msg(5)] })).toBe('2h ago');
    expect(line({ bindingId: 'x', running: [] })).toBe('No activity yet');
    expect(line(undefined, null)).toBe('No activity yet');
  });

  it('tones: failed in the error tone, other unseen a step brighter, the rest muted', () => {
    const tone = (a: SpaceAttention) => spaceStatusLineTone(a);
    expect(tone({ kind: 'failed', agent: 'claude', endedAt: NOW })).toBe('danger');
    expect(tone({ kind: 'finished', agent: 'claude', endedAt: NOW })).toBe('secondary');
    expect(tone({ kind: 'messages', count: 2 })).toBe('secondary');
    expect(tone({ kind: 'idle', lastActivityAt: null })).toBe('muted');
    expect(tone({ kind: 'live', state: 'editing' })).toBe('muted');
  });
});

describe('dice faces', () => {
  it('maps 1–9 to the agreed faces; 5 is a plus, not the failed cross', () => {
    expect(DICE_FACES[1]).toEqual([4]);
    expect(DICE_FACES[2]).toEqual([0, 8]);
    expect(DICE_FACES[3]).toEqual([0, 4, 8]);
    expect(DICE_FACES[4]).toEqual([0, 2, 6, 8]);
    expect(DICE_FACES[5]).toEqual([1, 3, 4, 5, 7]);
    expect(DICE_FACES[5]).not.toEqual([0, 2, 4, 6, 8]);
    expect(DICE_FACES[6]).toEqual([0, 2, 3, 5, 6, 8]);
    expect(DICE_FACES[7]).toEqual([0, 2, 3, 4, 5, 6, 8]);
    expect(DICE_FACES[8]).toEqual([0, 1, 2, 3, 5, 6, 7, 8]);
    expect(DICE_FACES[9]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('idlePattern', () => {
  const seeds = Array.from({ length: 1000 }, (_, i) => `bnd_${i.toString(36)}_${(i * 7919).toString(16)}`);

  it('is stable for a seed', () => {
    for (const seed of seeds.slice(0, 50)) expect(idlePattern(seed)).toEqual(idlePattern(seed));
    expect(idlePattern('growth')).toEqual(idlePattern('growth'));
  });

  it('lights 3–4 cells and is never a dice face, glyph, row, column or diagonal — across 1000 seeds', () => {
    const reserved = [
      ...Object.values(DICE_FACES),
      [1, 3, 5, 7],
      [0, 2, 4, 6, 8],
      [3, 4, 5],
      [0, 1, 2],
      [6, 7, 8],
      [0, 3, 6],
      [1, 4, 7],
      [2, 5, 8],
      [0, 4, 8],
      [2, 4, 6],
    ].map((cells) => cells.join(','));
    for (const seed of seeds) {
      const cells = idlePattern(seed);
      expect(cells.length === 3 || cells.length === 4).toBe(true);
      expect(new Set(cells).size).toBe(cells.length);
      expect(cells.every((c) => c >= 0 && c <= 8)).toBe(true);
      expect(reserved).not.toContain(cells.join(','));
      expect(RESERVED_PATTERNS.has(cells.join(','))).toBe(false);
    }
  });

  it('differs between spaces', () => {
    expect(new Set(seeds.map((s) => idlePattern(s).join(','))).size).toBeGreaterThan(50);
  });
});

describe('baselineMarker', () => {
  it('a never-opened space is "seen up to now"', () => {
    const status: RigSpaceStatus = { bindingId: 'x', running: [], recentMessages: [msg(3), msg(7)] };
    expect(baselineMarker(status, { lastSeenSeq: null, openedAt: null }, NOW)).toEqual({ lastSeenSeq: 7, openedAt: NOW });
    expect(baselineMarker({ bindingId: 'x', running: [], recentMessages: [] }, { lastSeenSeq: null, openedAt: null }, NOW)).toEqual({
      lastSeenSeq: 0,
      openedAt: NOW,
    });
  });

  it('keeps an existing marker, and waits for a relay that sends recentMessages', () => {
    const status: RigSpaceStatus = { bindingId: 'x', running: [], recentMessages: [msg(7)] };
    expect(baselineMarker(status, { lastSeenSeq: 5, openedAt: 1 }, NOW)).toBeNull();
    expect(baselineMarker(status, { lastSeenSeq: 5, openedAt: null }, NOW)).toEqual({ openedAt: NOW });
    expect(baselineMarker({ bindingId: 'x', running: [] }, { lastSeenSeq: null, openedAt: 1 }, NOW)).toBeNull();
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
  it('ranks needs-you, then live, then what you missed, then idle — name breaks remaining ties', () => {
    const rows = [
      { bindingId: 'quiet', name: 'z-quiet' },
      { bindingId: 'missed', name: 'missed' },
      { bindingId: 'live', name: 'live' },
      { bindingId: 'waiting', name: 'waiting' },
    ];
    const statusByBinding = new Map<string, RigSpaceStatus>([
      ['missed', { bindingId: 'missed', running: [], lastRun: { status: 'done', endedAt: new Date(NOW - 60_000).toISOString(), agent: 'claude', ownerUserId: 'u' } }],
      ['live', { bindingId: 'live', running: [running({ ownerUserId: 'someone_else', activity: 'editing' })] }],
      ['waiting', { bindingId: 'waiting', running: [running({ ownerUserId: 'me', activity: 'waiting' })] }],
    ]);
    const attention = new Map(
      rows.map((r) => [r.bindingId, deriveSpaceAttention(statusByBinding.get(r.bindingId), { lastSeenSeq: 0, openedAt: NOW - 3_600_000 }, 'me')])
    );
    const sorted = sortSpaceRowsByActivity(rows, statusByBinding, attention, 'me', NOW);
    expect(sorted.map((r) => r.bindingId)).toEqual(['waiting', 'live', 'missed', 'quiet']);
  });

  it('orders idle spaces by their latest activity, messages included', () => {
    const rows = [
      { bindingId: 'old', name: 'a-old' },
      { bindingId: 'chatty', name: 'b-chatty' },
    ];
    const statusByBinding = new Map<string, RigSpaceStatus>([
      ['old', { bindingId: 'old', running: [], lastRun: { status: 'done', endedAt: new Date(NOW - 86_400_000).toISOString(), agent: 'claude', ownerUserId: 'u' } }],
      ['chatty', { bindingId: 'chatty', running: [], recentMessages: [{ id: 'm', seq: 1, createdAt: new Date(NOW - 60_000).toISOString(), authorUserId: 'me', authorKind: 'user' }] }],
    ]);
    const attention = new Map(rows.map((r) => [r.bindingId, deriveSpaceAttention(statusByBinding.get(r.bindingId), null, 'me')]));
    expect(sortSpaceRowsByActivity(rows, statusByBinding, attention, 'me', NOW).map((r) => r.bindingId)).toEqual(['chatty', 'old']);
  });
});
