import { describe, expect, it } from 'vitest';
import type { RoomMessageRow } from '../spaces/relay-api';
import { listAllMessages, listPageMessages, pinsFromRows, threadsFromRows } from './page-pins';

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

describe('threadsFromRows', () => {
  it('gathers each pin with its replies in order, naming the agent on agent replies', () => {
    const threads = threadsFromRows([
      row({ id: 'p', seq: 1, body: '@codex does the chart match the table?' }),
      row({ id: 'r2', seq: 4, parentId: 'p', body: 'Thanks', author: { userId: 'u2', name: 'janis', avatarUrl: null, kind: 'user' } }),
      row({ id: 'r1', seq: 3, parentId: 'p', body: 'No: +28%, not +41%.', meta: { agent: 'codex' }, author: { userId: 'u1', name: 'dylan', avatarUrl: null, kind: 'agent' } }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.replies.map((r) => [r.id, r.agent, r.authorName])).toEqual([
      ['r1', 'codex', 'dylan'],
      ['r2', null, 'janis'],
    ]);
  });
});

describe('listAllMessages', () => {
  it('pages with after until a short page, so pins past 200 messages load', async () => {
    const all = Array.from({ length: 450 }, (_, i) => row({ id: `m${i + 1}`, seq: i + 1 }));
    const calls: (string | undefined)[] = [];
    const api = {
      listMessages: async (_b: string, q: { after?: string; limit?: number }) => {
        calls.push(q.after);
        const after = Number(q.after ?? 0);
        return { success: true as const, data: all.filter((r) => r.seq > after).slice(0, q.limit ?? 200) };
      },
    };
    const got = await listAllMessages(api, 'bnd', 'https://example.com/');
    expect(got.success && got.data.map((r) => r.id).at(-1)).toBe('m450');
    expect(calls).toEqual([undefined, '200', '400']);
  });
});

describe('listPageMessages', () => {
  it("reads a Google Doc's pins under its key now and under its old edit link, in the order they were made", async () => {
    const byPath: Record<string, RoomMessageRow[]> = {
      'https://docs.google.com/document/d/1AbC': [row({ id: 'new', seq: 9 })],
      'https://docs.google.com/document/d/1AbC/edit': [row({ id: 'old', seq: 3 })],
    };
    const asked: string[] = [];
    const api = {
      listMessages: async (_b: string, q: { path?: string }) => {
        asked.push(q.path!);
        return { success: true as const, data: byPath[q.path!] ?? [] };
      },
    };
    const got = await listPageMessages(api, 'bnd', 'https://docs.google.com/document/d/1AbC');
    expect(got.success && got.data.map((r) => r.id)).toEqual(['old', 'new']);
    expect(asked).toContain('https://docs.google.com/document/d/1AbC/view');
  });
});
