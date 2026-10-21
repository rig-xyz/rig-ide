import { describe, expect, it } from 'vitest';
import { demoSpaces } from './mock';
import { sessionMatrix } from './model';
import { mergeRail, realSpaceToRail, runToSession, shortSpaceNames } from './rail-data';

const NOW = Date.parse('2026-10-21T09:00:00Z');

describe('real spaces in the rail', () => {
  it('a space with only you in it is private, otherwise it shows up to two faces', () => {
    const base = {
      bindingId: 'b1',
      name: 'ops',
      path: '/x',
      unread: 0,
      status: undefined,
      chats: [],
    };
    expect(
      realSpaceToRail({ ...base, members: [{ userId: 'me', name: 'Dylan' }] }, 'me', NOW).visibility
    ).toBe('private');
    const shared = realSpaceToRail(
      {
        ...base,
        members: [
          { userId: 'me', name: 'Dylan' },
          { userId: 'h', name: 'Hugo Renaudin' },
          { userId: 'j', name: 'Janis' },
          { userId: 'r', name: 'Riyad' },
        ],
      },
      'me',
      NOW
    );
    expect(shared.visibility).toBe('shared');
    expect(shared.faces.map((f) => f.name)).toEqual(['Hugo Renaudin', 'Janis']);
  });

  it('a run waiting on you needs you; one waiting on its owner is muted', () => {
    const run = {
      runId: 'r1',
      agent: 'claude' as const,
      ownerUserId: 'me',
      startedAt: new Date(NOW - 5 * 60_000).toISOString(),
      activity: 'waiting' as const,
      title: 'Fix the claim poller',
    };
    const mine = runToSession('b1', run, 'me', NOW);
    expect(mine).toMatchObject({
      state: 'needs_you',
      short: 'Needs you',
      name: 'Fix the claim poller',
    });
    expect(sessionMatrix(mine)).toEqual({ state: 'waiting', tone: 'warn' });
    const theirs = runToSession('b1', { ...run, ownerUserId: 'h', ownerName: 'Hugo' }, 'me', NOW);
    expect(theirs.state).toBe('waiting_on_person');
    expect(sessionMatrix(theirs).tone).toBe('mute');
    const reading = runToSession('b1', { ...run, activity: 'reading' }, 'me', NOW);
    expect(sessionMatrix(reading)).toEqual({ state: 'reading', tone: 'accent' });
  });

  it('lists at most two recent chats, and none older than three days', () => {
    const day = 24 * 60 * 60 * 1000;
    const space = realSpaceToRail(
      {
        bindingId: 'b1',
        name: 'ops',
        path: '/x',
        unread: 0,
        status: undefined,
        members: null,
        chats: [
          { id: 'c1', title: 'One', updatedAt: NOW - 1000 },
          { id: 'c2', title: null, updatedAt: NOW - day },
          { id: 'c3', title: 'Three', updatedAt: NOW - 2 * day },
          { id: 'c4', title: 'Old', updatedAt: NOW - 5 * day },
        ],
      },
      'me',
      NOW
    );
    expect(space.sessions.map((s) => s.name)).toEqual(['One', 'Untitled session']);
  });
});

describe('mergeRail', () => {
  it('a real space takes the place of the demo space with its name, keeping the demo sessions', () => {
    const real = realSpaceToRail(
      {
        bindingId: 'bind-ops',
        name: 'rig-ops',
        path: '/rig-ops',
        unread: 2,
        status: undefined,
        members: null,
        chats: [],
      },
      'me',
      NOW
    );
    const other = realSpaceToRail(
      {
        bindingId: 'bind-x',
        name: 'elsewhere',
        path: null,
        unread: 0,
        status: undefined,
        members: null,
        chats: [],
      },
      'me',
      NOW
    );
    const merged = mergeRail([real, other], demoSpaces());
    const ops = merged.find((s) => s.id === 'rig-ops')!;
    expect(ops).toMatchObject({
      root: '/rig-ops',
      bindingId: 'bind-ops',
      unread: 2,
      origin: 'real',
    });
    expect(ops.sessions.map((s) => s.id)).toEqual(['s-domains']);
    expect(merged.at(-1)!.id).toBe('bind-x');
    expect(merged.filter((s) => s.name === 'rig-ops')).toHaveLength(1);
  });
});

describe('shortSpaceNames', () => {
  it('drops a prefix your spaces share, and only that', () => {
    const short = shortSpaceNames([
      'rig-ops',
      'rig-marketing',
      'ulys-backlog',
      'ulys-ideas-simulator',
      'warm-island',
      'proactivity',
      'rig-qa',
    ]);
    expect(short.get('rig-ops')).toBe('ops');
    expect(short.get('rig-marketing')).toBe('marketing');
    expect(short.get('ulys-backlog')).toBe('backlog');
    expect(short.get('ulys-ideas-simulator')).toBe('ideas-simulator');
    expect(short.get('warm-island')).toBe('warm-island');
    expect(short.get('proactivity')).toBe('proactivity');
    // "qa" is too short to stand alone.
    expect(short.get('rig-qa')).toBe('rig-qa');
  });
});
