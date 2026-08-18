import { describe, expect, it } from 'vitest';
import {
  formatClockTime,
  isOfflineError,
  offlineChipLabel,
  parseCommentsCache,
  toCacheEntry,
} from './comments-cache';

function message(id: string) {
  return {
    id,
    seq: '1',
    bindingId: 'b1',
    author: { userId: 'u1', name: 'Dylan', avatarUrl: null, kind: 'user' as const },
    kind: 'text',
    body: 'hello',
    parentId: null,
    intentId: null,
    path: 'docs/spec.md',
    meta: null,
    anchor: null,
    resolvedAt: null,
    resolvedBy: null,
    createdAt: '2026-08-14T20:04:00.000Z',
    editedAt: null,
    deletedAt: null,
  };
}

describe('isOfflineError', () => {
  it('is true for a transport failure (kind relay, no status)', () => {
    expect(isOfflineError({ kind: 'relay' })).toBe(true);
  });

  it('is false for a relay-answered error (kind relay, has status)', () => {
    expect(isOfflineError({ kind: 'relay', status: 500 })).toBe(false);
    expect(isOfflineError({ kind: 'relay', status: 404 })).toBe(false);
  });

  it('is false for every other error kind', () => {
    expect(isOfflineError({ kind: 'invalid' })).toBe(false);
    expect(isOfflineError({ kind: 'agent' })).toBe(false);
    expect(isOfflineError({ kind: 'unauthenticated' })).toBe(false);
  });
});

describe('toCacheEntry / parseCommentsCache round-trip', () => {
  it('round-trips a valid entry', () => {
    const entry = toCacheEntry('b1', 'docs/spec.md', [message('m1'), message('m2')], '2026-08-14T20:04:00.000Z');
    const parsed = parseCommentsCache(JSON.parse(JSON.stringify(entry)));
    expect(parsed).toEqual(entry);
  });

  it('bounds the cached message count', () => {
    const messages = Array.from({ length: 250 }, (_, i) => message(`m${i}`));
    const entry = toCacheEntry('b1', 'docs/spec.md', messages, '2026-08-14T20:04:00.000Z');
    expect(entry.messages).toHaveLength(200);
  });

  it('rejects null, non-objects, and missing fields', () => {
    expect(parseCommentsCache(null)).toBeNull();
    expect(parseCommentsCache('nope')).toBeNull();
    expect(parseCommentsCache({})).toBeNull();
    expect(parseCommentsCache({ bindingId: 'b1' })).toBeNull();
  });

  it('rejects a cache whose messages array contains something implausible', () => {
    const raw = {
      bindingId: 'b1',
      relPath: 'docs/spec.md',
      lastSyncedAt: '2026-08-14T20:04:00.000Z',
      messages: [message('m1'), { id: 'm2' /* missing body/createdAt/author */ }],
    };
    expect(parseCommentsCache(raw)).toBeNull();
  });

  it('degrades a corrupt blob to null rather than throwing', () => {
    expect(() => parseCommentsCache(42)).not.toThrow();
    expect(parseCommentsCache(42)).toBeNull();
  });
});

describe('formatClockTime', () => {
  it('formats as h:mm + lowercase am/pm with no space', () => {
    const result = formatClockTime('2026-08-14T20:04:00.000Z');
    expect(result).toMatch(/^\d{1,2}:\d{2}(am|pm)$/);
  });

  it('returns empty string for an unparseable timestamp', () => {
    expect(formatClockTime('not-a-date')).toBe('');
  });
});

describe('offlineChipLabel', () => {
  it('says "not yet synced" when nothing has ever synced', () => {
    expect(offlineChipLabel(null)).toBe('offline · not yet synced');
  });

  it('includes a clock-time "last synced" when a timestamp exists', () => {
    const label = offlineChipLabel('2026-08-14T20:04:00.000Z');
    expect(label).toMatch(/^offline · last synced \d{1,2}:\d{2}(am|pm)$/);
  });
});
