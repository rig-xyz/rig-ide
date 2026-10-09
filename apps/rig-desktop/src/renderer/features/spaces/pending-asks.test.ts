import { describe, expect, it } from 'vitest';
import { PENDING_ASK_WINDOW_MS, waitingAgentFor } from './pending-asks';
import type { MessageMeta, RoomMessage } from './types';

const T0 = Date.parse('2026-10-09T10:00:00Z');

function msg(id: string, seq: number, authorId: string, meta: MessageMeta): RoomMessage {
  const createdAt = new Date(T0 + seq * 1000).toISOString();
  return { id, seq, authorId, createdAt, time: '10:00', body: id, meta };
}

const ask = msg('ask', 1, 'me', { kind: 'text', asks: 'claude' });

describe('waitingAgentFor', () => {
  it('names the asked agent until a run starts on the message', () => {
    expect(waitingAgentFor(ask, [ask], T0 + 5_000)).toBe('claude');
    const started = msg('run', 2, 'me', { kind: 'session', runId: 'r1', sourceMessageId: 'ask' });
    expect(waitingAgentFor(ask, [ask, started], T0 + 5_000)).toBeNull();
  });

  it('keeps waiting when a run answers some other message', () => {
    const other = msg('run', 2, 'me', { kind: 'session', runId: 'r1', sourceMessageId: 'elsewhere' });
    expect(waitingAgentFor(ask, [ask, other], T0 + 5_000)).toBe('claude');
  });

  it("settles on the asker's own agent failure after it, not someone else's", () => {
    const theirs = msg('f1', 2, 'sam', { kind: 'system', event: 'agent_failed' });
    expect(waitingAgentFor(ask, [ask, theirs], T0 + 5_000)).toBe('claude');
    const mine = msg('f2', 3, 'me', { kind: 'system', event: 'agent_failed' });
    expect(waitingAgentFor(ask, [ask, theirs, mine], T0 + 5_000)).toBeNull();
  });

  it('ignores a failure from before the ask', () => {
    const earlier = msg('f0', 0, 'me', { kind: 'system', event: 'agent_failed' });
    expect(waitingAgentFor(ask, [earlier, ask], T0 + 5_000)).toBe('claude');
  });

  it('stops waiting once the ask is old', () => {
    expect(waitingAgentFor(ask, [ask], T0 + 1_000 + PENDING_ASK_WINDOW_MS + 1)).toBeNull();
  });

  it('is null for a message that asked no agent', () => {
    const plain = msg('plain', 1, 'me', { kind: 'text' });
    expect(waitingAgentFor(plain, [plain], T0)).toBeNull();
  });
});
