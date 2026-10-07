import { describe, expect, it } from 'vitest';
import type { PageThread } from '@shared/spaces/pages';
import { replyCountLabel, threadExcerpt, threadListGroups } from './page-thread-list';

const thread = (n: number, resolved = false): PageThread => ({
  n,
  id: `t${n}`,
  quote: '398',
  comment: 'Where does 398 come from?',
  authorName: 'dylan',
  createdAt: '2026-09-26T10:00:00Z',
  resolved,
  anchor: { xo: [], hops: [], path: 'td', tag: 'td', text: '398', fx: 0.5, fy: 0.5 },
  replies: [],
});

describe('threadListGroups', () => {
  it('lists open threads first, then resolved ones, each in pin order', () => {
    const groups = threadListGroups([thread(3), thread(1, true), thread(2), thread(4, true)]);
    expect(groups.open.map((t) => t.n)).toEqual([2, 3]);
    expect(groups.resolved.map((t) => t.n)).toEqual([1, 4]);
  });

  it('leaves the input order alone', () => {
    const threads = [thread(2), thread(1)];
    threadListGroups(threads);
    expect(threads.map((t) => t.n)).toEqual([2, 1]);
  });
});

describe('threadExcerpt', () => {
  it('folds line breaks and runs of spaces into one line', () => {
    expect(threadExcerpt('  Where does\n\n398   come from?  ')).toBe('Where does 398 come from?');
  });
});

describe('replyCountLabel', () => {
  it('says nothing for no replies, then counts them', () => {
    expect(replyCountLabel(0)).toBeNull();
    expect(replyCountLabel(1)).toBe('1 reply');
    expect(replyCountLabel(3)).toBe('3 replies');
  });
});
