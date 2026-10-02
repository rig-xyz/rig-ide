import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDismissed, DISMISSED_CAP, readDismissed } from './for-you-dismissed';

function fakeStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
    key: (i) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
}

describe('for-you dismissals', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps ids per Space under the documented key', () => {
    expect(readDismissed('b1')).toEqual([]);
    addDismissed('b1', ['n1']);
    addDismissed('b1', ['n2', 'n1']);
    addDismissed('b2', ['x']);
    expect(readDismissed('b1')).toEqual(['n1', 'n2']);
    expect(readDismissed('b2')).toEqual(['x']);
    expect(JSON.parse(localStorage.getItem('rig-for-you-dismissed:b1')!)).toEqual(['n1', 'n2']);
  });

  it('forgets the oldest past the cap', () => {
    addDismissed(
      'b1',
      Array.from({ length: DISMISSED_CAP + 3 }, (_, i) => `n${i}`)
    );
    const ids = readDismissed('b1');
    expect(ids).toHaveLength(DISMISSED_CAP);
    expect(ids[0]).toBe('n3');
    expect(ids.at(-1)).toBe(`n${DISMISSED_CAP + 2}`);
  });

  it('survives corrupt or unavailable storage', () => {
    localStorage.setItem('rig-for-you-dismissed:b1', '{not json');
    expect(readDismissed('b1')).toEqual([]);
    localStorage.setItem('rig-for-you-dismissed:b1', '{"a":1}');
    expect(readDismissed('b1')).toEqual([]);
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readDismissed('b1')).toEqual([]);
    expect(addDismissed('b1', ['n1'])).toEqual(['n1']);
  });
});
