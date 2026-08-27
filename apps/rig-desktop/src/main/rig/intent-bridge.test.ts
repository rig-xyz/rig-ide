import type { TranscriptTurn } from '@emdash/core/acp';
import { describe, expect, it } from 'vitest';
import { intentContextFromTurn } from './intent-context';

function turn(items: TranscriptTurn['items']): TranscriptTurn {
  return {
    id: 'turn-1',
    seq: 1,
    initiator: 'user',
    items,
    outcome: { kind: 'done' },
  };
}

function message(
  role: 'user' | 'assistant',
  text: string,
  seq: number
): TranscriptTurn['items'][number] {
  return { kind: 'message', id: `message-${seq}`, seq, role, text };
}

describe('intentContextFromTurn', () => {
  it('uses the user prompt as intent and the latest assistant message as context', () => {
    const context = intentContextFromTurn(
      turn([
        message('user', '  Investigate\n session   persistence  ', 0),
        message('assistant', 'I found the restart race.', 1),
        message('assistant', 'Fixed the race and added coverage.', 2),
      ])
    );

    expect(context).toEqual({
      title: 'Investigate session persistence',
      summaryText: 'Fixed the race and added coverage.',
    });
  });

  it('bounds large prompt and response fields before sending them to the relay', () => {
    const context = intentContextFromTurn(
      turn([message('user', 'p'.repeat(300), 0), message('assistant', 'a'.repeat(1_000), 1)])
    );

    expect(context.title).toHaveLength(160);
    expect(context.title?.endsWith('…')).toBe(true);
    expect(context.summaryText).toHaveLength(800);
    expect(context.summaryText?.endsWith('…')).toBe(true);
  });

  it('returns null fields for agent-only turns without user-facing prose', () => {
    expect(intentContextFromTurn(turn([]))).toEqual({ title: null, summaryText: null });
  });
});
