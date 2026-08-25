import { describe, expect, it } from 'vitest';
import { selectCards } from './card-rail';

describe('selectCards', () => {
  it('pinned files are always shown, first, ahead of in-progress and fresh', () => {
    const cards = selectCards({
      pinnedRelPaths: ['pinned.md'],
      inProgress: [{ relPath: 'writing.md', at: 200, sessionId: 's1' }],
      fresh: [{ relPath: 'fresh.md', at: 100 }],
    });
    expect(cards.map((c) => c.type)).toEqual(['pinned', 'in-progress', 'fresh']);
    expect(cards[0].relPath).toBe('pinned.md');
  });

  it('in-progress outranks fresh — both fit under the cap, in-progress still lands first', () => {
    const cards = selectCards({
      pinnedRelPaths: [],
      inProgress: [{ relPath: 'writing.md', at: 100, sessionId: 's1' }],
      fresh: [{ relPath: 'fresh.md', at: 999 }], // newer, but still ranks below in-progress
    });
    expect(cards.map((c) => c.type)).toEqual(['in-progress', 'fresh']);
  });

  it('a file never appears twice — pinned wins over in-progress for the same path', () => {
    const cards = selectCards({
      pinnedRelPaths: ['shared.md'],
      inProgress: [{ relPath: 'shared.md', at: 100, sessionId: 's1' }],
      fresh: [],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ type: 'pinned', relPath: 'shared.md', at: 100, sessionId: 's1' });
  });

  it('a file never appears twice — in-progress wins over fresh for the same path', () => {
    const cards = selectCards({
      pinnedRelPaths: [],
      inProgress: [{ relPath: 'shared.md', at: 100, sessionId: 's1' }],
      fresh: [{ relPath: 'shared.md', at: 999 }],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe('in-progress');
  });

  it('a pinned file borrows its recency from a fresh signal when it has no write of its own', () => {
    const cards = selectCards({
      pinnedRelPaths: ['pinned.md'],
      inProgress: [],
      fresh: [{ relPath: 'pinned.md', at: 555 }],
    });
    expect(cards[0]).toMatchObject({ type: 'pinned', relPath: 'pinned.md', at: 555 });
    expect(cards[0].sessionId).toBeUndefined();
  });

  it('a pinned file with no other signal at all still shows, with no recency', () => {
    const cards = selectCards({ pinnedRelPaths: ['quiet.md'], inProgress: [], fresh: [] });
    expect(cards).toEqual([{ type: 'pinned', relPath: 'quiet.md', at: undefined, sessionId: undefined }]);
  });

  it('in-progress and fresh sort newest-first within their own group', () => {
    const cards = selectCards({
      pinnedRelPaths: [],
      inProgress: [
        { relPath: 'older.md', at: 100, sessionId: 's1' },
        { relPath: 'newer.md', at: 200, sessionId: 's1' },
      ],
      fresh: [],
    });
    expect(cards.map((c) => c.relPath)).toEqual(['newer.md', 'older.md']);
  });

  it('respects maxNonPinned — the cap applies to in-progress + fresh combined, never to pinned', () => {
    const cards = selectCards({
      pinnedRelPaths: ['p1.md', 'p2.md', 'p3.md'],
      inProgress: [
        { relPath: 'w1.md', at: 300, sessionId: 's1' },
        { relPath: 'w2.md', at: 200, sessionId: 's1' },
      ],
      fresh: [
        { relPath: 'f1.md', at: 150 },
        { relPath: 'f2.md', at: 100 },
      ],
      maxNonPinned: 3,
    });
    expect(cards.filter((c) => c.type === 'pinned')).toHaveLength(3);
    expect(cards.filter((c) => c.type !== 'pinned')).toHaveLength(3);
    // both in-progress fit (2), fresh fills the remaining 1 slot with its newest.
    expect(cards.map((c) => c.relPath).slice(3)).toEqual(['w1.md', 'w2.md', 'f1.md']);
  });

  it('an empty rig produces no cards', () => {
    expect(selectCards({ pinnedRelPaths: [], inProgress: [], fresh: [] })).toEqual([]);
  });
});
