import { describe, expect, it } from 'vitest';
import { reduceRoom } from './fixtures/room-feed';
import { emptySnapshot } from './relay-room-source';
import { applyThemeEvents, themesFromSnapshot, type RoomThemes, type ThemeEvent } from './themes';
import type { RoomMessage, RoomSnapshot } from './types';

const base: RoomThemes = themesFromSnapshot({
  enabled: true,
  themes: [
    { id: 'A', name: 'Pricing', description: 'Plans', bornSeq: 1, count: 2, lastSeq: 10 },
    { id: 'B', name: 'Launch', description: 'Date', bornSeq: 5, count: 1, lastSeq: 8 },
  ],
  assignments: {
    m1: { themeId: 'A', via: 'jev' },
    m2: { themeId: 'A', via: 'reply' },
    m3: { themeId: 'B', via: 'jev' },
  },
  latestEventId: '100',
});

const noSeq = (_id: string): number | undefined => undefined;
const apply = (
  themes: RoomThemes,
  events: ThemeEvent[],
  upTo: string | null = null,
  seqOf = noSeq
) => applyThemeEvents(themes, events, upTo, seqOf);
const count = (t: RoomThemes, id: string) => t.list.find((x) => x.id === id)?.count;

describe('themesFromSnapshot', () => {
  it('takes the snapshot whole, its latest event id as the cursor', () => {
    expect(base.cursor).toBe('100');
    expect(base.enabled).toBe(true);
    expect(base.list.map((t) => t.id)).toEqual(['A', 'B']);
    expect(base.themeOf.m3).toEqual({ themeId: 'B', via: 'jev' });
  });
});

describe('applyThemeEvents', () => {
  it('born adds an empty theme at its born seq', () => {
    const next = apply(base, [
      {
        id: '101',
        atSeq: 12,
        type: 'born',
        themeId: 'C',
        name: 'Hiring',
        description: 'Roles',
        bornSeq: 12,
      },
    ]);
    expect(next.list.at(-1)).toEqual({
      id: 'C',
      name: 'Hiring',
      description: 'Roles',
      bornSeq: 12,
      count: 0,
      lastSeq: 12,
    });
    expect(next.cursor).toBe('101');
  });

  it('records each born event as a birth, keeps earlier ones, and none for a snapshot or a theme already there', () => {
    expect(base.births).toBeUndefined();
    const born = (id: string, themeId: string, name: string): ThemeEvent => ({
      id,
      atSeq: 12,
      type: 'born',
      themeId,
      name,
      description: '',
      bornSeq: 12,
    });
    const one = apply(base, [born('101', 'C', 'Hiring')]);
    expect(one.births).toEqual([{ eventId: '101', themeId: 'C', name: 'Hiring' }]);
    const two = apply(one, [born('102', 'D', 'Ops'), born('103', 'D', 'Ops again')]);
    expect(two.births).toEqual([
      { eventId: '101', themeId: 'C', name: 'Hiring' },
      { eventId: '102', themeId: 'D', name: 'Ops' },
    ]);
    // Events that are not births carry them along; a replay of a theme the Room has adds none.
    const three = apply(two, [
      { id: '104', atSeq: 13, type: 'assign', messageId: 'm9', themeId: 'C', via: 'jev' },
    ]);
    expect(three.births).toBe(two.births);
    expect(apply(three, [born('105', 'A', 'Pricing')]).births).toBe(two.births);
    // A snapshot, whatever themes it holds, has none.
    expect(
      themesFromSnapshot({
        enabled: true,
        themes: [...two.list.map((t) => ({ ...t }))],
        assignments: {},
        latestEventId: '110',
      }).births
    ).toBeUndefined();
  });

  it('assign puts a message in a theme: count up, lastSeq at the message seq, themeOf set', () => {
    const next = apply(
      base,
      [{ id: '101', atSeq: 99, type: 'assign', messageId: 'm4', themeId: 'B', via: 'proposer' }],
      null,
      (id) => (id === 'm4' ? 15 : undefined)
    );
    expect(next.list.find((t) => t.id === 'B')).toMatchObject({ count: 2, lastSeq: 15 });
    expect(next.themeOf.m4).toEqual({ themeId: 'B', via: 'proposer' });
  });

  it('assign without the message in the Room falls back to the event seq', () => {
    const next = apply(base, [
      { id: '101', atSeq: 20, type: 'assign', messageId: 'm4', themeId: 'B', via: 'jev' },
    ]);
    expect(next.list.find((t) => t.id === 'B')?.lastSeq).toBe(20);
  });

  it('assign of an already-assigned message moves it, counts follow', () => {
    const next = apply(base, [
      { id: '101', atSeq: 20, type: 'assign', messageId: 'm1', themeId: 'B', via: 'jev' },
    ]);
    expect(count(next, 'A')).toBe(1);
    expect(count(next, 'B')).toBe(2);
  });

  it('assign to a theme the Room does not know changes nothing but the cursor', () => {
    const next = apply(base, [
      { id: '101', atSeq: 20, type: 'assign', messageId: 'm4', themeId: 'ghost', via: 'jev' },
    ]);
    expect(next.list).toEqual(base.list);
    expect(next.themeOf).toEqual(base.themeOf);
    expect(next.cursor).toBe('101');
  });

  it('move takes a message from one theme to another', () => {
    const next = apply(
      base,
      [{ id: '101', atSeq: 20, type: 'move', messageId: 'm1', from: 'A', to: 'B' }],
      null,
      (id) => (id === 'm1' ? 3 : undefined)
    );
    expect(count(next, 'A')).toBe(1);
    expect(count(next, 'B')).toBe(2);
    expect(next.themeOf.m1).toEqual({ themeId: 'B', via: 'jev' });
    // A message leaving never lowers the old theme's lastSeq; arriving raises the new one only to the message's seq.
    expect(next.list.find((t) => t.id === 'A')?.lastSeq).toBe(10);
    expect(next.list.find((t) => t.id === 'B')?.lastSeq).toBe(8);
  });

  it('move of a message the Room has no theme for trusts the event`s from; via becomes gardener', () => {
    const next = apply(base, [
      { id: '101', atSeq: 20, type: 'move', messageId: 'old', from: 'A', to: 'B' },
    ]);
    expect(count(next, 'A')).toBe(1);
    expect(count(next, 'B')).toBe(2);
    expect(next.themeOf.old).toEqual({ themeId: 'B', via: 'gardener' });
  });

  it('counts never go below zero', () => {
    const next = apply(base, [
      { id: '101', atSeq: 20, type: 'move', messageId: 'o1', from: 'B', to: 'A' },
      { id: '102', atSeq: 21, type: 'move', messageId: 'o2', from: 'B', to: 'A' },
    ]);
    expect(count(next, 'B')).toBe(0);
  });

  it('rename changes the name, and the description when one is sent', () => {
    const a = apply(base, [
      { id: '101', atSeq: 20, type: 'rename', themeId: 'A', name: 'Tiers', description: 'Seats' },
    ]);
    expect(a.list[0]).toMatchObject({ name: 'Tiers', description: 'Seats' });
    const b = apply(base, [
      { id: '101', atSeq: 20, type: 'rename', themeId: 'A', name: 'Tiers', description: null },
    ]);
    expect(b.list[0]).toMatchObject({ name: 'Tiers', description: 'Plans' });
  });

  it('merge retires the source: its messages and count move into the target', () => {
    const next = apply(base, [{ id: '101', atSeq: 20, type: 'merge', from: 'A', into: 'B' }]);
    expect(next.list.map((t) => t.id)).toEqual(['B']);
    expect(next.list[0]).toMatchObject({ count: 3, lastSeq: 10 });
    expect(next.themeOf.m1).toEqual({ themeId: 'B', via: 'jev' });
    expect(next.themeOf.m2).toEqual({ themeId: 'B', via: 'reply' });
    expect(next.themeOf.m3.themeId).toBe('B');
  });

  it('a moved message after a merge counts in the survivor', () => {
    const next = apply(base, [
      { id: '101', atSeq: 20, type: 'merge', from: 'A', into: 'B' },
      { id: '102', atSeq: 21, type: 'assign', messageId: 'm9', themeId: 'B', via: 'jev' },
    ]);
    expect(count(next, 'B')).toBe(4);
  });

  it('applies events in id order whatever order they come in', () => {
    const born: ThemeEvent = {
      id: '101',
      atSeq: 12,
      type: 'born',
      themeId: 'C',
      name: 'Hiring',
      description: '',
      bornSeq: 12,
    };
    const assign: ThemeEvent = {
      id: '102',
      atSeq: 12,
      type: 'assign',
      messageId: 'm9',
      themeId: 'C',
      via: 'proposer',
    };
    const next = apply(base, [assign, born]);
    expect(count(next, 'C')).toBe(1);
    expect(next.cursor).toBe('102');
  });

  it('is idempotent: the same event id arriving twice counts once', () => {
    const events: ThemeEvent[] = [
      {
        id: '101',
        atSeq: 12,
        type: 'born',
        themeId: 'C',
        name: 'Hiring',
        description: '',
        bornSeq: 12,
      },
      { id: '102', atSeq: 12, type: 'assign', messageId: 'm9', themeId: 'C', via: 'proposer' },
      { id: '103', atSeq: 13, type: 'move', messageId: 'm1', from: 'A', to: 'C' },
    ];
    const once = apply(base, events);
    const twice = apply(once, events);
    expect(twice).toBe(once);
    expect(count(twice, 'C')).toBe(2);
    expect(count(twice, 'A')).toBe(1);
  });

  it('an overlap with the snapshot leaves the same counts (assign and move already reflected)', () => {
    const next = apply(base, [
      { id: '90', atSeq: 3, type: 'assign', messageId: 'm1', themeId: 'A', via: 'jev' },
      { id: '95', atSeq: 8, type: 'move', messageId: 'm3', from: 'A', to: 'B' },
    ]);
    // Both are at or before the snapshot's cursor, so they are skipped outright...
    expect(next).toBe(base);
    // ...and replayed with later ids (a worker that re-sent them) they still count nothing twice.
    const replay = apply(base, [
      { id: '101', atSeq: 3, type: 'assign', messageId: 'm1', themeId: 'A', via: 'jev' },
      { id: '102', atSeq: 8, type: 'move', messageId: 'm3', from: 'A', to: 'B' },
    ]);
    expect(count(replay, 'A')).toBe(2);
    expect(count(replay, 'B')).toBe(1);
  });

  it('replaying a whole born, assign, merge sequence a snapshot already holds converges', () => {
    // The snapshot has the merge done: theme X is gone, m5 sits in B.
    const snap = themesFromSnapshot({
      enabled: true,
      themes: [{ id: 'B', name: 'Launch', description: '', bornSeq: 5, count: 2, lastSeq: 30 }],
      assignments: { m3: { themeId: 'B', via: 'jev' }, m5: { themeId: 'B', via: 'proposer' } },
      latestEventId: '100',
    });
    const next = apply(snap, [
      { id: '101', atSeq: 28, type: 'born', themeId: 'X', name: 'X', description: '', bornSeq: 28 },
      { id: '102', atSeq: 30, type: 'assign', messageId: 'm5', themeId: 'X', via: 'proposer' },
      { id: '103', atSeq: 30, type: 'merge', from: 'X', into: 'B' },
    ]);
    expect(next.list.map((t) => t.id)).toEqual(['B']);
    expect(next.list[0]!.count).toBe(2);
    expect(next.themeOf.m5.themeId).toBe('B');
  });

  it('upTo moves the cursor past events this build skipped, and never backwards', () => {
    expect(apply(base, [], '120').cursor).toBe('120');
    expect(apply(base, [], '50').cursor).toBe('100');
    expect(apply(base, [], null)).toBe(base);
  });

  it('never mutates the themes it was given', () => {
    const before = JSON.stringify(base);
    apply(base, [
      { id: '101', atSeq: 20, type: 'assign', messageId: 'm1', themeId: 'B', via: 'jev' },
      { id: '102', atSeq: 20, type: 'merge', from: 'A', into: 'B' },
      { id: '103', atSeq: 21, type: 'rename', themeId: 'B', name: 'Z', description: 'z' },
    ]);
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe('reduceRoom themes events', () => {
  const msg = (id: string, seq: number) => ({ id, seq }) as unknown as RoomMessage;
  const room = (themes?: RoomThemes | null): RoomSnapshot => ({
    ...emptySnapshot('Growth', 'me'),
    messages: [msg('m4', 33)],
    themes,
  });

  it('themes_synced sets, themes_cleared unsets', () => {
    const synced = reduceRoom(room(), {
      type: 'themes_synced',
      snapshot: { enabled: true, themes: [], assignments: {}, latestEventId: '7' },
    });
    expect(synced.themes).toEqual({ enabled: true, list: [], themeOf: {}, cursor: '7' });
    const cleared = reduceRoom(synced, { type: 'themes_cleared' });
    expect(cleared.themes).toBeNull();
    expect(reduceRoom(cleared, { type: 'themes_cleared' })).toBe(cleared);
  });

  it('themes_applied reads a message`s seq from the Room, and does nothing without themes', () => {
    const applied = reduceRoom(room(base), {
      type: 'themes_applied',
      events: [{ id: '101', atSeq: 5, type: 'assign', messageId: 'm4', themeId: 'B', via: 'jev' }],
      upTo: '101',
    });
    expect(applied.themes?.list.find((t) => t.id === 'B')).toMatchObject({ count: 2, lastSeq: 33 });
    const none = room(null);
    expect(reduceRoom(none, { type: 'themes_applied', events: [], upTo: '9' })).toBe(none);
    const same = room(base);
    expect(reduceRoom(same, { type: 'themes_applied', events: [], upTo: null })).toBe(same);
  });
});
