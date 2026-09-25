import { describe, expect, it } from 'vitest';
import type { RigSpaceStatus } from '@shared/rig/space-status';
import { createOwnerNameCache, memberDisplayName, withOwnerNames, type MemberNames } from './space-status';

const done = (ownerUserId: string): RigSpaceStatus['lastRun'] => ({ status: 'done', endedAt: null, agent: 'claude', ownerUserId });
const live = (ownerUserId: string): RigSpaceStatus['running'][number] => ({
  runId: 'r',
  agent: 'claude',
  ownerUserId,
  startedAt: '',
  activity: null,
});

describe('memberDisplayName', () => {
  it("uses the profile name, else the email's local part", () => {
    expect(memberDisplayName({ userId: 'u', name: ' Sam Lee ', email: 'sam@x.com' })).toEqual({ userId: 'u', name: 'Sam Lee' });
    expect(memberDisplayName({ userId: 'u', name: null, email: 'sam@x.com' })).toEqual({ userId: 'u', name: 'sam' });
    expect(memberDisplayName({ userId: 'u' })).toBeNull();
    expect(memberDisplayName({ name: 'Sam' })).toBeNull();
  });
});

describe('withOwnerNames', () => {
  it("copies each run owner's name onto running items and the last run, when known", () => {
    const statuses: RigSpaceStatus[] = [
      { bindingId: 'a', running: [live('sam'), live('ghost')] },
      { bindingId: 'b', running: [], lastRun: done('sam') },
      { bindingId: 'c', running: [], lastRun: done('sam') },
    ];
    const names = new Map<string, MemberNames>([
      ['a', new Map([['sam', 'Sam Lee']])],
      ['b', new Map([['sam', 'Sam']])],
    ]);
    const out = withOwnerNames(statuses, names);
    expect(out[0]!.running.map((r) => r.ownerName)).toEqual(['Sam Lee', undefined]);
    expect(out[1]!.lastRun?.ownerName).toBe('Sam');
    expect(out[2]).toBe(statuses[2]); // no names for that space: untouched
  });
});

describe('createOwnerNameCache', () => {
  it('reads a space once, re-reads after five minutes, or after a minute when an owner is missing', async () => {
    let now = 0;
    const calls: string[] = [];
    let roster = new Map([['sam', 'Sam']]);
    const namesFor = createOwnerNameCache(async (bindingId) => {
      calls.push(bindingId);
      return roster;
    }, () => now);

    const quiet: RigSpaceStatus = { bindingId: 'q', running: [] };
    const bySam: RigSpaceStatus = { bindingId: 'a', running: [], lastRun: done('sam') };
    expect((await namesFor([quiet, bySam])).get('a')?.get('sam')).toBe('Sam');
    expect(calls).toEqual(['a']); // a space with no runs needs no names

    now = 30_000;
    await namesFor([bySam]);
    expect(calls).toEqual(['a']);

    // Someone new ran something: not re-read on every poll, but within a minute.
    const byNew: RigSpaceStatus = { bindingId: 'a', running: [live('newbie')] };
    await namesFor([byNew]);
    expect(calls).toEqual(['a']);
    now = 61_000;
    roster = new Map([...roster, ['newbie', 'Nia']]);
    expect((await namesFor([byNew])).get('a')?.get('newbie')).toBe('Nia');
    expect(calls).toEqual(['a', 'a']);

    now = 61_000 + 5 * 60_000;
    await namesFor([bySam]);
    expect(calls).toEqual(['a', 'a', 'a']);
  });

  it('keeps the last good names when a read fails, and does not retry on the next poll', async () => {
    let now = 0;
    let fail = false;
    let calls = 0;
    const namesFor = createOwnerNameCache(async () => {
      calls += 1;
      return fail ? null : new Map([['sam', 'Sam']]);
    }, () => now);
    const bySam: RigSpaceStatus = { bindingId: 'a', running: [], lastRun: done('sam') };
    await namesFor([bySam]);
    fail = true;
    now = 5 * 60_000;
    expect((await namesFor([bySam])).get('a')?.get('sam')).toBe('Sam');
    now += 1_000;
    await namesFor([bySam]);
    expect(calls).toBe(2);
  });
});
