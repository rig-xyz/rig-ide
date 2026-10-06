import { describe, expect, it } from 'vitest';
import { FORMER_MEMBER, personOf, resolvePerson, SOMEONE } from './person-identity';
import type { RoomMember, RoomMessage } from './types';

function member(over: Partial<RoomMember> & Pick<RoomMember, 'id' | 'name'>): RoomMember {
  return { email: '', role: 'editor', initial: over.name.slice(0, 1), status: 'here', ...over };
}

describe('resolvePerson', () => {
  const hugo = member({ id: 'usr_h', name: 'Hugo Renaudin', avatarUrl: 'https://img/h.png' });

  it('uses the roster first', () => {
    expect(resolvePerson('usr_h', { members: [hugo], seen: { name: 'Old Hugo' } })).toMatchObject({
      name: 'Hugo Renaudin',
      avatarUrl: 'https://img/h.png',
      named: true,
      member: hugo,
    });
  });

  it("falls back to the relay's name and photo for someone not in the roster", () => {
    expect(
      resolvePerson('usr_left', {
        members: [hugo],
        seen: { name: 'Ana Left', avatarUrl: 'https://img/a.png' },
      })
    ).toEqual({
      name: 'Ana Left',
      avatarUrl: 'https://img/a.png',
      named: true,
    });
  });

  it('shows an email used as a name as is', () => {
    expect(resolvePerson('usr_s', { members: [], seen: { name: 'sam@northwind.io' } }).name).toBe(
      'sam@northwind.io'
    );
  });

  it('names you by your own email when you have no name', () => {
    const me = member({ id: 'usr_me', name: SOMEONE });
    expect(
      resolvePerson('usr_me', { members: [me], self: { id: 'usr_me', email: 'me@play.local' } })
        .name
    ).toBe('me@play.local');
    expect(resolvePerson('usr_me', { members: [{ ...me, email: 'me@play.local' }] }).name).toBe(
      'me@play.local'
    );
  });

  it('says Former member for a deleted account, never its id', () => {
    expect(resolvePerson('former_usr_x', { members: [] })).toEqual({
      name: FORMER_MEMBER,
      avatarUrl: null,
      named: false,
    });
    expect(resolvePerson('usr_x', { members: [], seen: { name: 'Former member' } }).name).toBe(
      FORMER_MEMBER
    );
  });

  it('says Someone only when nothing is known, never an id', () => {
    expect(resolvePerson('user_2abcDEF', { members: [] })).toEqual({
      name: SOMEONE,
      avatarUrl: null,
      named: false,
    });
    expect(resolvePerson(null, { members: [] }).name).toBe(SOMEONE);
    expect(
      resolvePerson('usr_q', { members: [member({ id: 'usr_q', name: SOMEONE })] })
    ).toMatchObject({ name: SOMEONE, named: false });
  });
});

describe('personOf', () => {
  const message = (over: Partial<RoomMessage>): RoomMessage => ({
    id: 'm1',
    seq: 1,
    authorId: 'usr_left',
    createdAt: '2026-10-06T10:00:00.000Z',
    time: '10:00',
    meta: { kind: 'text' },
    ...over,
  });

  it("reads a former member's name off their messages", () => {
    const snapshot = { members: [], messages: [message({ authorName: 'Ana Left' })] };
    expect(personOf(snapshot, 'usr_left').name).toBe('Ana Left');
  });

  it("reads an invited person's name off their invite", () => {
    const snapshot = {
      members: [],
      messages: [],
      invitesById: {
        i1: {
          id: 'i1',
          by: 'usr_me',
          who: '',
          status: 'sent' as const,
          target: { userId: 'usr_j', name: 'Jérémie Rappaz', avatarUrl: null },
        },
      },
    };
    expect(personOf(snapshot, 'usr_j').name).toBe('Jérémie Rappaz');
  });
});
