import type { TranscriptTurn } from '@emdash/core/acp/client';
import { describe, expect, it } from 'vitest';
import {
  newTurnsSince,
  nextLastSeq,
  parseStoredEvents,
  shouldPersistTitle,
  withTurnTimestamps,
} from './session-writer';

function userTurn(seq: number, extraItems: TranscriptTurn['items'] = []): TranscriptTurn {
  return {
    id: `turn-${seq}`,
    seq,
    initiator: 'user',
    items: [
      { kind: 'message', id: `msg-${seq}`, seq: 0, role: 'user', text: `prompt ${seq}` },
      ...extraItems,
    ],
  };
}

describe('newTurnsSince', () => {
  it('returns turns with seq greater than lastSeq, ascending', () => {
    const turns = [{ seq: 2 }, { seq: 0 }, { seq: 1 }, { seq: 3 }];
    expect(newTurnsSince(turns, 0)).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
  });

  it('returns everything when lastSeq is -1 (nothing persisted yet)', () => {
    const turns = [{ seq: 0 }, { seq: 1 }];
    expect(newTurnsSince(turns, -1)).toEqual([{ seq: 0 }, { seq: 1 }]);
  });

  it('returns an empty array when nothing is new', () => {
    const turns = [{ seq: 0 }, { seq: 1 }];
    expect(newTurnsSince(turns, 1)).toEqual([]);
  });

  it('is exclusive at the boundary — seq === lastSeq is not new', () => {
    expect(newTurnsSince([{ seq: 5 }], 5)).toEqual([]);
  });

  it('handles an empty turn list', () => {
    expect(newTurnsSince([], 3)).toEqual([]);
  });

  it('resume dedup: replayed turns matching the stored seq range are never treated as new', () => {
    // The exact scenario Round E's dedup fix protects: `_lastPersistedSeq`
    // is established from OUR stored turns (seq 0..2) before the resume's
    // AcpLiveSession.resume() call; the adapter's loadSession replay then
    // reconstructs the identical conversation from scratch, with the same
    // seq numbering (0..2) but fresh reducer-assigned turn ids. Those must
    // never look "new" to the persistence writer, or every resume would
    // duplicate the stored event log.
    const lastPersistedSeq = 2; // from 3 stored turns, seq 0,1,2
    const replayedTurns = [
      { seq: 0, id: 'replay-turn-0' },
      { seq: 1, id: 'replay-turn-1' },
      { seq: 2, id: 'replay-turn-2' },
    ];
    expect(newTurnsSince(replayedTurns, lastPersistedSeq)).toEqual([]);
  });

  it('resume dedup: a genuinely new turn sent after resume still persists', () => {
    const lastPersistedSeq = 2;
    const turnsAfterNewPrompt = [
      { seq: 0, id: 'replay-turn-0' },
      { seq: 1, id: 'replay-turn-1' },
      { seq: 2, id: 'replay-turn-2' },
      { seq: 3, id: 'new-turn-3' },
    ];
    expect(newTurnsSince(turnsAfterNewPrompt, lastPersistedSeq)).toEqual([
      { seq: 3, id: 'new-turn-3' },
    ]);
  });

  it('preserves extra fields on each turn (not just seq)', () => {
    const turns = [{ seq: 1, id: 'a' }, { seq: 0, id: 'b' }];
    expect(newTurnsSince(turns, -1)).toEqual([{ seq: 0, id: 'b' }, { seq: 1, id: 'a' }]);
  });
});

describe('nextLastSeq', () => {
  it('advances to the highest appended seq', () => {
    expect(nextLastSeq(-1, [{ seq: 0 }, { seq: 2 }, { seq: 1 }])).toBe(2);
  });

  it('never regresses when appended is empty', () => {
    expect(nextLastSeq(5, [])).toBe(5);
  });

  it('never regresses below current even if appended is somehow lower', () => {
    expect(nextLastSeq(5, [{ seq: 2 }])).toBe(5);
  });
});

describe('withTurnTimestamps', () => {
  it('stamps at onto the first user message of each turn it knows a time for', () => {
    const turns = [userTurn(0), userTurn(1)];
    const stamped = withTurnTimestamps(turns, new Map([[0, 111], [1, 222]]));
    expect((stamped[0].items[0] as { at?: number }).at).toBe(111);
    expect((stamped[1].items[0] as { at?: number }).at).toBe(222);
  });

  it('leaves a turn untouched when its seq has no known at yet', () => {
    const turns = [userTurn(0)];
    const stamped = withTurnTimestamps(turns, new Map());
    expect(stamped[0]).toBe(turns[0]);
    expect((stamped[0].items[0] as { at?: number }).at).toBeUndefined();
  });

  it('only stamps the user message, not other items in the same turn', () => {
    const turns = [
      userTurn(0, [{ kind: 'message', id: 'reply-0', seq: 1, role: 'assistant', text: 'ok' }]),
    ];
    const stamped = withTurnTimestamps(turns, new Map([[0, 111]]));
    expect((stamped[0].items[0] as { at?: number }).at).toBe(111);
    expect((stamped[0].items[1] as { at?: number }).at).toBeUndefined();
  });

  it('does not mutate the input turns', () => {
    const turns = [userTurn(0)];
    withTurnTimestamps(turns, new Map([[0, 111]]));
    expect((turns[0].items[0] as { at?: number }).at).toBeUndefined();
  });
});

describe('parseStoredEvents', () => {
  it('parses valid stored turns and builds the seq→at map', () => {
    const result = parseStoredEvents([
      { seq: 0, at: 111, turn: userTurn(0) },
      { seq: 1, at: 222, turn: userTurn(1) },
    ]);
    expect(result.turns).toHaveLength(2);
    expect(result.atBySeq).toEqual(new Map([[0, 111], [1, 222]]));
  });

  it('drops a record whose stored JSON no longer matches the turn schema', () => {
    const result = parseStoredEvents([
      { seq: 0, at: 111, turn: userTurn(0) },
      { seq: 1, at: 222, turn: { not: 'a turn' } },
    ]);
    expect(result.turns).toHaveLength(1);
    expect(result.atBySeq.has(1)).toBe(false);
  });

  it('returns empty results for an empty input', () => {
    expect(parseStoredEvents([])).toEqual({ turns: [], atBySeq: new Map() });
  });
});

describe('shouldPersistTitle', () => {
  it('is true exactly on the untitled-to-titled transition', () => {
    expect(shouldPersistTitle(null, 'Fix the flaky test')).toBe(true);
  });

  it('is false once a title already exists — never re-persisted on later prompts', () => {
    expect(shouldPersistTitle('Already titled', 'Fix the flaky test')).toBe(false);
  });

  it('is false when the derived title is still null (an all-whitespace first line)', () => {
    expect(shouldPersistTitle(null, null)).toBe(false);
  });

  it('is false for a resumed session seeded with its stored title before any prompt', () => {
    // RigChatStore's `resume` constructor param sets `title` up front, so by
    // the time submitPrompt runs, previousTitle is already non-null.
    expect(shouldPersistTitle('Resumed session title', 'Resumed session title')).toBe(false);
  });

  it('defaults titleSource to auto — every pre-round-S2+ call site keeps its old behavior', () => {
    expect(shouldPersistTitle(null, 'Fix the flaky test')).toBe(true);
  });

  it('round S2+: a manual title is never re-derived, even on the untitled-to-titled transition', () => {
    // The one case the null-check ALONE would get wrong: a session renamed
    // by hand before it ever had an auto-derived title (previousTitle is
    // still null from the null-check's point of view) must still refuse.
    expect(shouldPersistTitle(null, 'Auto-derived title', 'manual')).toBe(false);
  });

  it('round S2+: a manual title is never re-derived on a later prompt either', () => {
    expect(shouldPersistTitle('My renamed session', 'My renamed session', 'manual')).toBe(false);
  });

  it('round S2+: an auto title still persists normally — the veto is source-specific, not universal', () => {
    expect(shouldPersistTitle(null, 'Fix the flaky test', 'auto')).toBe(true);
  });
});
