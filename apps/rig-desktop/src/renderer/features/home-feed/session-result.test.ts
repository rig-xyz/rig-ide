import type { TranscriptTurn } from '@emdash/core/acp/client';
import { describe, expect, it } from 'vitest';
import { lastAnswer, plainText, sessionResult } from './session-result';

const answer = `The draft review of #350 is ready in [notes/reviews/basket-invest-pr350.md](notes/reviews/basket-invest-pr350.md). Nothing has been posted to **GitHub**.

**What I checked:** the PR's code.

**Decisions for you:**

1. **Request changes or just comment?** I drafted it as request changes.
2. **Should I post it?** Say the word.`;

describe('sessionResult', () => {
  it("leads with the answer's first paragraph, as plain words", () => {
    expect(sessionResult(answer).lead).toBe(
      'The draft review of #350 is ready in notes/reviews/basket-invest-pr350.md. Nothing has been posted to GitHub.'
    );
  });

  it('counts the decisions it left for you', () => {
    expect(sessionResult(answer).decisions).toBe(2);
    expect(sessionResult('Decisions for you:\n- one\n- two\n- three\n\nThanks.').decisions).toBe(3);
  });

  it('has none when there is no such list', () => {
    expect(sessionResult('Done. I wrote notes/summary.md.').decisions).toBe(0);
  });
});

describe('lastAnswer', () => {
  it("is the last assistant message, skipping turns that ended without one", () => {
    const turn = (id: string, items: TranscriptTurn['items']): TranscriptTurn => ({ id, seq: 1, initiator: 'user', items });
    const msg = (id: string, role: 'user' | 'assistant', text: string) => ({ kind: 'message' as const, id, seq: 1, role, text });
    const turns = [turn('t1', [msg('a', 'assistant', 'First answer')]), turn('t2', [msg('b', 'user', 'Thanks')])];
    expect(lastAnswer(turns)).toBe('First answer');
    expect(lastAnswer([])).toBeNull();
  });
});

describe('plainText', () => {
  it('keeps link text and drops marks', () => {
    expect(plainText('See `x` in [the doc](a.md), **now**.')).toBe('See x in the doc, now.');
  });
});
