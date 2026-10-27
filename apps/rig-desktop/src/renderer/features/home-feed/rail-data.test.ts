import { describe, expect, it } from 'vitest';
import { demoSpaces } from './mock';
import { sessionMatrix } from './model';
import { mergeRail, orderSpacesByActivity, realSpaceToRail, runToSession } from './rail-data';

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

  it('a chat still running shows as running, first, never "idle · Last active"; newest first after it', () => {
    const space = realSpaceToRail(
      {
        bindingId: 'b1',
        name: 'home',
        path: '/x',
        unread: 0,
        status: undefined,
        members: null,
        chats: [
          { id: 'c1', title: 'Older', updatedAt: NOW - 60_000 },
          { id: 'c2', title: 'Newer', updatedAt: NOW - 1000 },
          { id: 'c3', title: 'Draft the fix', updatedAt: NOW - 5 * 60_000, live: 'running' },
        ],
      },
      'me',
      NOW
    );
    expect(space.sessions.map((s) => s.name)).toEqual(['Draft the fix', 'Newer']);
    expect(space.sessions[0]).toMatchObject({ state: 'running', short: 'Working' });
    expect(space.lastActivityAt).toBe(NOW);
  });

  it('a chat that is also a run shows once, as the run; runs go newest first; activity is the newest', () => {
    const run = (runId: string, minutesAgo: number) => ({
      runId,
      agent: 'claude' as const,
      ownerUserId: 'me',
      startedAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
      activity: 'reading' as const,
      title: runId,
    });
    const space = realSpaceToRail(
      {
        bindingId: 'b1',
        name: 'ops',
        path: '/x',
        unread: 0,
        status: { bindingId: 'b1', running: [run('r_old', 30), run('r_new', 2)] } as never,
        members: null,
        chats: [{ id: 'r_new', title: 'Same session', updatedAt: NOW - 2 * 60_000 }],
      },
      'me',
      NOW
    );
    expect(space.sessions.map((s) => s.id)).toEqual(['run:r_new', 'run:r_old']);
    expect(space.lastActivityAt).toBe(NOW - 2 * 60_000);
  });

  it('a space where nothing happened has no last activity', () => {
    const space = realSpaceToRail(
      { bindingId: 'b1', name: 'quiet', path: '/x', unread: 0, status: undefined, members: null, chats: [] },
      'me',
      NOW
    );
    expect(space.lastActivityAt).toBeNull();
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

describe('orderSpacesByActivity', () => {
  it('puts the space with the newest session first, whenever the spaces were made', () => {
    const space = (id: string, lastActivityAt: number | null) => ({ id, lastActivityAt }) as unknown as Parameters<typeof orderSpacesByActivity>[0][number]['space'];
    const order = orderSpacesByActivity([
      { space: space('made-recently', null), madeAt: NOW - 60_000 },
      { space: space('worked-an-hour-ago', NOW - 3_600_000), madeAt: NOW - 30 * 86_400_000 },
      { space: space('just-started', NOW - 1000), madeAt: NOW - 60 * 86_400_000 },
    ]);
    expect(order.map((s) => s.id)).toEqual(['just-started', 'made-recently', 'worked-an-hour-ago']);
  });
});
