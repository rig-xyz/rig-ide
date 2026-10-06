import { describe, expect, it } from 'vitest';
import type { RigMember, RigPerson } from '@shared/rig/rig-share';
import {
  addChip,
  ageWord,
  commitQuery,
  type InviteChip,
  inviteRequests,
  isValidEmail,
  memberName,
  NOT_AN_EMAIL,
  rankCollaborators,
  rankPeople,
  sendLabel,
  splitTyped,
} from './people-state';

const NOW = Date.parse('2026-10-06T12:00:00Z');

function person(overrides: Partial<RigPerson> & { userId: string; name: string }): RigPerson {
  return {
    clerkUserId: null,
    avatarUrl: null,
    sharedSpaces: [{ bindingId: 'b_1', name: 'launch' }],
    lastSharedAt: '2026-10-06T09:00:00Z',
    viaOrg: false,
    ...overrides,
  };
}

const HUGO = person({ userId: 'usr_h', name: 'Hugo Renaudin' });
const JEREMIE = person({
  userId: 'usr_j',
  name: 'Jérémie Rappaz',
  sharedSpaces: [
    { bindingId: 'b_1', name: 'launch' },
    { bindingId: 'b_2', name: 'feedback' },
  ],
});
const NAT = person({ userId: 'usr_n', name: 'Nat Okafor', lastSharedAt: '2026-09-29T12:00:00Z' });
const ANTOINE = person({
  userId: 'usr_a',
  name: 'Antoine Dubois',
  sharedSpaces: [],
  viaOrg: true,
  lastSharedAt: null,
});

describe('isValidEmail', () => {
  it('accepts ordinary addresses', () => {
    expect(isValidEmail('sam@northwind.io')).toBe(true);
    expect(isValidEmail('  first.last+tag@sub.example.co.uk ')).toBe(true);
  });

  it('rejects names, half addresses and lists', () => {
    for (const text of [
      'Jérémie',
      'sam@',
      'sam@northwind',
      'sam@northwind.i',
      'a b@x.io',
      'a@x.io, b@y.io',
      '',
    ]) {
      expect(isValidEmail(text)).toBe(false);
    }
  });
});

describe('commitQuery', () => {
  it('turns a full email into an email chip and clears the field', () => {
    expect(commitQuery('sam@northwind.io ', [])).toEqual({
      chips: [{ kind: 'email', email: 'sam@northwind.io' }],
      query: '',
      error: null,
    });
  });

  it('keeps anything else in the field with a reason', () => {
    expect(commitQuery('Sam', [])).toEqual({ chips: [], query: 'Sam', error: NOT_AN_EMAIL });
  });

  it('does nothing for empty text', () => {
    expect(commitQuery('   ', [])).toEqual({ chips: [], query: '', error: null });
  });

  it('never adds the same address twice, whatever its case', () => {
    const chips: InviteChip[] = [{ kind: 'email', email: 'sam@northwind.io' }];
    expect(commitQuery('SAM@northwind.io', chips).chips).toHaveLength(1);
  });
});

describe('splitTyped', () => {
  it('leaves plain typing alone, spaces included (names have them)', () => {
    expect(splitTyped('Jérémie Rap', [])).toEqual({ chips: [], query: 'Jérémie Rap', error: null });
  });

  it('turns every finished email of a pasted list into a chip, keeping the unfinished tail', () => {
    expect(splitTyped('a@x.io, b@y.io; c@z', [])).toEqual({
      chips: [
        { kind: 'email', email: 'a@x.io' },
        { kind: 'email', email: 'b@y.io' },
      ],
      query: 'c@z',
      error: null,
    });
  });

  it('keeps a finished piece that is not an email, with a reason', () => {
    const result = splitTyped('Sam, b@y.io,', []);
    expect(result.chips).toEqual([{ kind: 'email', email: 'b@y.io' }]);
    expect(result.query).toBe('Sam');
    expect(result.error).toBe(NOT_AN_EMAIL);
  });
});

describe('addChip', () => {
  it('dedupes a person by user id', () => {
    const chip: InviteChip = { kind: 'person', userId: 'usr_h', name: 'Hugo', avatarUrl: null };
    expect(addChip([chip], { ...chip, name: 'Hugo R' })).toEqual([chip]);
  });
});

describe('rankPeople', () => {
  const all = [NAT, ANTOINE, HUGO, JEREMIE];

  it('keeps the relay order for people you share spaces with, and puts organization-only people after', () => {
    expect(
      rankPeople(all, { query: '', exclude: new Set(), nowMs: NOW }).map((p) => p.userId)
    ).toEqual(['usr_n', 'usr_h', 'usr_j', 'usr_a']);
  });

  it('matches without accents or case, on any word of the name', () => {
    expect(
      rankPeople(all, { query: 'jer', exclude: new Set(), nowMs: NOW }).map((p) => p.name)
    ).toEqual(['Jérémie Rappaz']);
    expect(
      rankPeople(all, { query: 'RAPP', exclude: new Set(), nowMs: NOW }).map((p) => p.name)
    ).toEqual(['Jérémie Rappaz']);
  });

  it('puts a word that starts with the query before one that only contains it', () => {
    const anna = person({ userId: 'usr_x', name: 'Joanna Lee' });
    const annie = person({ userId: 'usr_y', name: 'Annie Hall' });
    expect(
      rankPeople([anna, annie], { query: 'ann', exclude: new Set(), nowMs: NOW }).map(
        (p) => p.userId
      )
    ).toEqual(['usr_y', 'usr_x']);
  });

  it('leaves out members, pending invites and picks (the exclude set)', () => {
    const exclude = new Set(['usr_h', 'usr_j']);
    expect(rankPeople(all, { query: '', exclude, nowMs: NOW }).map((p) => p.userId)).toEqual([
      'usr_n',
      'usr_a',
    ]);
  });

  it('says how you know them', () => {
    const rows = rankPeople(all, { query: '', exclude: new Set(), nowMs: NOW });
    const why = Object.fromEntries(rows.map((r) => [r.userId, [r.group, r.why]]));
    expect(why.usr_j).toEqual(['people', '2 spaces together · today']);
    expect(why.usr_n).toEqual(['people', '1 space together · last week']);
    expect(why.usr_a).toEqual(['org', 'Your organization']);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      person({ userId: `usr_${i}`, name: `Person ${i}` })
    );
    expect(rankPeople(many, { query: '', exclude: new Set(), nowMs: NOW })).toHaveLength(6);
  });

  it('skips a person with no name at all, since there is nothing to show or match', () => {
    const nameless = { ...person({ userId: 'usr_z', name: 'x' }), name: null };
    expect(rankPeople([nameless], { query: '', exclude: new Set(), nowMs: NOW })).toEqual([]);
  });
});

describe('rankCollaborators (older relay)', () => {
  const member = (overrides: Partial<RigMember>): RigMember => ({
    userId: 'u_1',
    name: 'Sam Rivera',
    email: 'sam@example.com',
    avatarUrl: null,
    role: 'editor',
    ...overrides,
  });

  it('matches name or email, needs an email, and leaves out members and already picked addresses', () => {
    const sam = member({});
    const ada = member({ userId: 'u_2', name: 'Ada', email: 'ada@example.com' });
    const noEmail = member({ userId: 'u_3', name: 'Sammy', email: null });
    const opts = { query: 'sam', exclude: new Set<string>(), excludeEmails: new Set<string>() };
    expect(rankCollaborators([sam, ada, noEmail], opts)).toEqual([sam]);
    expect(rankCollaborators([sam, ada], { ...opts, query: 'ada@' })).toEqual([ada]);
    expect(rankCollaborators([sam], { ...opts, exclude: new Set(['u_1']) })).toEqual([]);
    expect(
      rankCollaborators([sam], { ...opts, excludeEmails: new Set(['sam@example.com']) })
    ).toEqual([]);
  });
});

describe('inviteRequests', () => {
  it('aims a person chip by id and an email chip by address, one request each', () => {
    const chips: InviteChip[] = [
      { kind: 'person', userId: 'usr_j', name: 'Jérémie', avatarUrl: null },
      { kind: 'email', email: 'sam@northwind.io' },
    ];
    expect(inviteRequests(chips, 'viewer').map(({ chip: _chip, ...rest }) => rest)).toEqual([
      { email: null, targetUserId: 'usr_j', role: 'viewer' },
      { email: 'sam@northwind.io', targetUserId: null, role: 'viewer' },
    ]);
  });
});

describe('labels', () => {
  it('counts invites on the send button', () => {
    expect(sendLabel(1, false)).toBe('Send invite');
    expect(sendLabel(3, false)).toBe('Send 3 invites');
    expect(sendLabel(3, true)).toBe('Sending 3 invites…');
  });

  it('names a member by name, then email, then Someone', () => {
    expect(memberName({ name: 'Ada', email: 'ada@x.io' })).toBe('Ada');
    expect(memberName({ name: null, email: 'ada@x.io' })).toBe('ada@x.io');
    expect(memberName({ name: null, email: null })).toBe('Someone');
  });

  it('words an age', () => {
    expect(ageWord(NOW - 3_600_000, NOW)).toBe('today');
    expect(ageWord(NOW - 86_400_000 * 1.5, NOW)).toBe('yesterday');
    expect(ageWord(NOW - 86_400_000 * 9, NOW)).toBe('last week');
    expect(ageWord(NOW - 86_400_000 * 90, NOW)).toBe('a while ago');
  });
});
