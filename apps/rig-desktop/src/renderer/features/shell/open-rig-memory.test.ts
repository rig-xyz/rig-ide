import { describe, expect, it } from 'vitest';
import { readOpenRig, writeOpenRig } from './open-rig-memory';

function memoryStore() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    raw: map,
  };
}

describe('open rig memory', () => {
  it('round-trips the open rig, and a space keeps its kind', () => {
    const store = memoryStore();
    writeOpenRig({ path: '/Users/me/Rig/notes' }, store);
    expect(readOpenRig(store)).toEqual({ path: '/Users/me/Rig/notes' });
    writeOpenRig({ path: '/Users/me/Rig/growth', kind: 'space' }, store);
    expect(readOpenRig(store)).toEqual({ path: '/Users/me/Rig/growth', kind: 'space' });
  });

  it('forgets it on null (back on Home)', () => {
    const store = memoryStore();
    writeOpenRig({ path: '/Users/me/Rig/notes' }, store);
    writeOpenRig(null, store);
    expect(readOpenRig(store)).toBeNull();
  });

  it('reads nothing from an empty or garbled entry', () => {
    const store = memoryStore();
    expect(readOpenRig(store)).toBeNull();
    store.raw.set('rig-open-rig', '{not json');
    expect(readOpenRig(store)).toBeNull();
    store.raw.set('rig-open-rig', JSON.stringify({ path: 42 }));
    expect(readOpenRig(store)).toBeNull();
    store.raw.set('rig-open-rig', JSON.stringify({ path: '/x', kind: 'weird' }));
    expect(readOpenRig(store)).toEqual({ path: '/x' });
  });

  it('never throws when storage does', () => {
    const denied = () => {
      throw new Error('denied');
    };
    const broken = { getItem: denied, setItem: denied, removeItem: denied };
    expect(readOpenRig(broken)).toBeNull();
    expect(() => writeOpenRig({ path: '/x' }, broken)).not.toThrow();
  });
});
