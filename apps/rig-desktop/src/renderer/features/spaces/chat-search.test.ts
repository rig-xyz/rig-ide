import { describe, expect, it } from 'vitest';
import {
  localMatches,
  matchCountLabel,
  matchRanges,
  mergeMatches,
  planSearch,
  searchableText,
  textMatches,
} from './chat-search';
import type { RoomMessage, RoomSnapshot, SessionEvent } from './types';

function message(id: string, seq: number, body: string, meta: RoomMessage['meta'] = { kind: 'text' }): RoomMessage {
  return { id, seq, authorId: 'sam', createdAt: '2026-10-05T10:00:00Z', time: '10:00', body, meta };
}

const chunk = (seq: number, text: string, messageId = 'm1'): SessionEvent => ({
  seq,
  kind: 'agent_message_chunk',
  payload: { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } },
});

type Searchable = Pick<RoomSnapshot, 'messages' | 'sessionEventsByRun' | 'sessionSummaryByRun'>;

describe('planSearch', () => {
  it('splits a query into words, lowercased, and matches a short or wordless one whole', () => {
    expect(planSearch('  ')).toBeNull();
    expect(planSearch('Pricing Page')).toEqual({ mode: 'words', terms: ['pricing', 'page'] });
    expect(planSearch('src/app.ts')).toEqual({ mode: 'words', terms: ['src', 'app', 'ts'] });
    expect(planSearch('Q3')).toEqual({ mode: 'substring', text: 'q3' });
    expect(planSearch('???')).toEqual({ mode: 'substring', text: '???' });
  });
});

describe('matching and highlights', () => {
  it('needs every word somewhere in the text, ignoring case', () => {
    const plan = planSearch('pric page')!;
    expect(textMatches('The Pricing page is up', plan)).toBe(true);
    expect(textMatches('Repricing the landing page', plan)).toBe(true);
    expect(textMatches('Pricing is up', plan)).toBe(false);
  });

  it('marks each occurrence, merging overlaps, in order', () => {
    expect(matchRanges('Pricing page, pricing', planSearch('pricing')!)).toEqual([
      [0, 7],
      [14, 21],
    ]);
    expect(matchRanges('pricing', planSearch('pri pricing')!)).toEqual([[0, 7]]);
    expect(matchRanges('a.ts and b.ts', planSearch('ts')!)).toEqual([
      [2, 4],
      [11, 13],
    ]);
  });

  it('reads a person’s text, a comment, and an agent turn by its answer; never a notice', () => {
    const snapshot: Searchable = {
      messages: [],
      sessionEventsByRun: { r1: [chunk(1, 'Draft '), chunk(2, 'answer'), chunk(3, 'Final answer', 'm2')] },
      sessionSummaryByRun: { r2: { answer: 'From disk', status: 'done', model: null, stepCount: 0, failureReason: null, privacy: null, detailsHidden: false, lastSeq: 1 } },
    };
    expect(searchableText(message('a', 1, 'hello'), snapshot)).toBe('hello');
    expect(searchableText(message('b', 2, 'note', { kind: 'comment_mirror', commentId: 'b', path: 'a.md', quote: 'q' }), snapshot)).toBe('note');
    expect(searchableText(message('c', 3, 'Asked Claude', { kind: 'session', runId: 'r1' }), snapshot)).toBe('Final answer');
    expect(searchableText(message('d', 4, '', { kind: 'session', runId: 'r2' }), snapshot)).toBe('From disk');
    expect(searchableText(message('e', 5, '', { kind: 'session', runId: 'r3' }), snapshot)).toBeNull();
    expect(searchableText(message('f', 6, 'Sam joined', { kind: 'system', event: 'member_joined' }), snapshot)).toBeNull();
  });

  it('finds the loaded matches in chat order, never a message still sending', () => {
    const snapshot: Searchable = {
      messages: [
        message('a', 1, 'pricing draft'),
        message('b', 2, 'lunch'),
        message('c', 3, 'Asked Claude about pricing', { kind: 'session', runId: 'r1' }),
        message('d', 4, 'the pricing answer'),
        { ...message('e', 5, 'pricing again'), sending: true },
      ],
      sessionEventsByRun: { r1: [chunk(1, 'Nothing to see here')] },
    };
    // The run's prompt says "pricing", its answer doesn't: an agent turn matches on its answer only.
    expect(localMatches(snapshot, planSearch('pricing')!).map((m) => m.id)).toEqual(['a', 'd']);
    expect(localMatches(snapshot, planSearch('see here')!).map((m) => m.id)).toEqual(['c']);
  });
});

describe('mergeMatches', () => {
  it('joins the loaded matches and the relay’s, once each, in chat order', () => {
    const loadedA = message('a', 10, 'pricing');
    const local = [loadedA];
    const remote = [message('a', 10, 'stale copy'), message('old2', 4, 'pricing'), message('old1', 2, 'pricing')];
    const merged = mergeMatches(local, remote, [loadedA]);
    expect(merged.map((m) => m.id)).toEqual(['old1', 'old2', 'a']);
    expect(merged.find((m) => m.id === 'a')).toBe(loadedA);
  });

  it('shows a relay match as the Room has it once loaded, even when it no longer matches here', () => {
    const remoteCopy = message('x', 3, 'app.ts');
    const loadedCopy = { ...remoteCopy, reactions: [] };
    expect(mergeMatches([], [remoteCopy], [loadedCopy])[0]).toBe(loadedCopy);
  });
});

describe('matchCountLabel', () => {
  it('counts, says when the relay has more, and quotes the query', () => {
    expect(matchCountLabel(12, ' pricing ', false)).toBe('12 matches for “pricing”');
    expect(matchCountLabel(1, 'pricing', false)).toBe('1 match for “pricing”');
    expect(matchCountLabel(30, 'pricing', true)).toBe('30+ matches for “pricing”');
  });
});
