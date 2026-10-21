import { describe, expect, it } from 'vitest';
import { agoShort, connectorsReducer, resultLine } from './connectors-model';
import { CHECKS, initialConnectorsState } from './connectors-script';

const NOW = Date.parse('2026-10-21T15:00:00Z');

describe('connectorsReducer', () => {
  it('a check shows Claude checking, then lands its items in the grid and their topics', () => {
    let s = initialConnectorsState(NOW);
    const cells = s.cells.length;
    s = connectorsReducer(s, { type: 'check-start', connector: 'linear' });
    expect(s.connectors.find((c) => c.connector === 'linear')!.checking).toBe(true);
    s = connectorsReducer(s, {
      type: 'check-done',
      connector: 'linear',
      at: NOW,
      arrivals: CHECKS[0]!.arrivals,
    });
    const linear = s.connectors.find((c) => c.connector === 'linear')!;
    expect(linear).toMatchObject({
      checking: false,
      lastCheckAt: NOW,
      lastResult: { added: 1, toFeed: 0, held: 0 },
    });
    expect(s.cells).toHaveLength(cells + 1);
    expect(s.cells.at(-1)).toMatchObject({ ref: 'ULY-521', topic: 'earn', fresh: true });
    expect(s.topics.find((t) => t.id === 'earn')).toMatchObject({ count: 13, fresh: 1, bump: 1 });
  });

  it('an item can start a topic, and one that needs you puts its topic in the Feed', () => {
    let s = initialConnectorsState(NOW);
    s = connectorsReducer(s, {
      type: 'check-done',
      connector: 'github',
      at: NOW,
      arrivals: CHECKS[1]!.arrivals,
    });
    expect(s.topics.find((t) => t.id === 'spaces')).toMatchObject({
      name: 'Spaces Reliability',
      count: 1,
      state: 'none',
    });
    s = connectorsReducer(s, {
      type: 'check-done',
      connector: 'github',
      at: NOW,
      arrivals: CHECKS[4]!.arrivals,
    });
    expect(s.topics.find((t) => t.id === 'spaces')!.state).toBe('feed');
    expect(resultLine(s.connectors.find((c) => c.connector === 'github')!)).toBe(
      '1 new, 1 to your Feed'
    );
  });

  it('looking at a topic is seeing what is new in it; new cells settle', () => {
    let s = initialConnectorsState(NOW);
    s = connectorsReducer(s, {
      type: 'check-done',
      connector: 'linear',
      at: NOW,
      arrivals: CHECKS[0]!.arrivals,
    });
    s = connectorsReducer(s, { type: 'focus', topic: 'earn' });
    expect(s.topics.find((t) => t.id === 'earn')!.fresh).toBe(0);
    s = connectorsReducer(s, { type: 'settle' });
    expect(s.cells.some((c) => c.fresh)).toBe(false);
  });

  it('says what a check did in a few words', () => {
    expect(resultLine({ lastResult: { added: 0, toFeed: 0, held: 0 } })).toBe('nothing new');
    expect(resultLine({ lastResult: { added: 2, toFeed: 0, held: 1 } })).toBe('2 new, 1 held back');
    expect(agoShort(NOW - 10_000, NOW)).toBe('just now');
    expect(agoShort(NOW - 4 * 60_000, NOW)).toBe('4m ago');
  });
});
