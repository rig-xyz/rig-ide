import { describe, expect, it } from 'vitest';
import { openTabsStateEquals, toOpenTabsState } from './tab-restore';

describe('toOpenTabsState', () => {
  it('carries the open session ids and the active one', () => {
    expect(toOpenTabsState(['a', 'b'], 'b')).toEqual({ sessionIds: ['a', 'b'], activeId: 'b' });
  });

  it('nulls out an activeId that is not actually among the open tabs', () => {
    expect(toOpenTabsState(['a', 'b'], 'c')).toEqual({ sessionIds: ['a', 'b'], activeId: null });
  });

  it('carries a null activeId through as-is (the zero-state tab)', () => {
    expect(toOpenTabsState(['a', 'b'], null)).toEqual({ sessionIds: ['a', 'b'], activeId: null });
  });

  it('handles no open tabs', () => {
    expect(toOpenTabsState([], null)).toEqual({ sessionIds: [], activeId: null });
  });

  it('does not mutate the input array', () => {
    const ids = ['a', 'b'];
    const result = toOpenTabsState(ids, 'a');
    result.sessionIds.push('c');
    expect(ids).toEqual(['a', 'b']);
  });
});

describe('openTabsStateEquals', () => {
  it('is true for identical snapshots', () => {
    expect(
      openTabsStateEquals({ sessionIds: ['a', 'b'], activeId: 'a' }, { sessionIds: ['a', 'b'], activeId: 'a' })
    ).toBe(true);
  });

  it('is false when activeId differs', () => {
    expect(
      openTabsStateEquals({ sessionIds: ['a'], activeId: 'a' }, { sessionIds: ['a'], activeId: null })
    ).toBe(false);
  });

  it('is false when the session id list differs', () => {
    expect(
      openTabsStateEquals({ sessionIds: ['a'], activeId: null }, { sessionIds: ['a', 'b'], activeId: null })
    ).toBe(false);
  });

  it('is false when order differs (order is meaningful — tab position)', () => {
    expect(
      openTabsStateEquals(
        { sessionIds: ['a', 'b'], activeId: null },
        { sessionIds: ['b', 'a'], activeId: null }
      )
    ).toBe(false);
  });
});
