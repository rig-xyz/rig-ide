import { describe, expect, it } from 'vitest';
import type { RoomMessageRow } from '../spaces/relay-api';
import { pinsFromRows } from './page-pins';

const place = { xo: [], hops: [{ index: 2, sig: 'By quarter' }], path: 'body>td:nth-of-type(1)', tag: 'td', text: '398', fx: 0.5, fy: 0.5 };
const row = (over: Partial<RoomMessageRow>): RoomMessageRow => ({
  id: 'm',
  seq: 1,
  author: { userId: 'u1', name: 'dylan', avatarUrl: null, kind: 'user' },
  kind: 'text',
  body: 'Where does 398 come from?',
  meta: null,
  createdAt: '2026-09-26T10:00:00Z',
  path: 'https://claude.ai/artifact/x',
  parentId: null,
  quote: '398',
  anchor: { exact: '398', page: place },
  resolvedAt: null,
  ...over,
});

describe('pinsFromRows', () => {
  it('numbers page pins by when they were made, keeping resolved ones so numbers never shift', () => {
    const pins = pinsFromRows([
      row({ id: 'b', seq: 7, body: 'second' }),
      row({ id: 'r', seq: 8, parentId: 'a', body: 'a reply' }),
      row({ id: 'a', seq: 3, body: 'first', resolvedAt: '2026-09-26T11:00:00Z' }),
      row({ id: 'f', seq: 5, anchor: { exact: 'a passage in a file' } }),
    ]);
    expect(pins.map((p) => [p.n, p.id, p.comment, p.resolved])).toEqual([
      [1, 'a', 'first', true],
      [2, 'b', 'second', false],
    ]);
    expect(pins[1]!.anchor).toEqual(place);
    expect(pins[1]!.quote).toBe('398');
  });
});
