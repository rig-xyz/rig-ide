import { describe, expect, it } from 'vitest';
import type { RoomSnapshot, SessionEvent, SessionRunMeta } from '../types';
import { deriveAgentTileState, describeAgentTileState, RECENT_ENDED_MS } from './space-rail-status';

function run(
  id: string,
  owner: string,
  agent: 'claude' | 'codex',
  status: SessionRunMeta['status'] = 'running',
  startedAt = new Date(0).toISOString(),
  endedAt: string | null = null
): SessionRunMeta {
  return { id, agent, owner, model: '', title: '', status, startedAt, endedAt } as unknown as SessionRunMeta;
}

const chunk: SessionEvent = { seq: 1, kind: 'agent_message_chunk', payload: { messageId: 'x', content: { type: 'text', text: 'Working' } } };
const asking: SessionEvent = {
  seq: 2,
  kind: 'permission_requested',
  payload: { requestId: 'r1', toolCall: { toolCallId: 't1', title: 'Linear · create issue' }, options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }] },
};

function snapshot(overrides: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    sessionMetaByRun: {},
    sessionEventsByRun: {},
    ...overrides,
  } as unknown as RoomSnapshot;
}

describe('deriveAgentTileState', () => {
  it('is quiet with no runs at all', () => {
    expect(deriveAgentTileState([], snapshot(), 0)).toEqual({ kind: 'quiet' });
  });

  it('is a plain live tile for a running turn', () => {
    const meta = run('r', 'dylan', 'claude');
    const s = snapshot({ sessionEventsByRun: { r: [chunk] } });
    expect(deriveAgentTileState([meta], s, 0)).toEqual({ kind: 'live', state: 'thinking' });
  });

  it('breathes ("waiting") when the run is asking for your approval', () => {
    const meta = run('r', 'dylan', 'claude');
    const s = snapshot({ sessionEventsByRun: { r: [chunk, asking] } });
    expect(deriveAgentTileState([meta], s, 0)).toEqual({ kind: 'live', state: 'waiting' });
  });

  it('shows a recently-ended run\'s own end glyph', () => {
    const now = 20 * 60_000; // 20 minutes in
    const endedAt = new Date(now - 60_000).toISOString(); // ended 1 minute ago
    const meta = run('r', 'dylan', 'claude', 'done', new Date(0).toISOString(), endedAt);
    const s = snapshot();
    expect(deriveAgentTileState([meta], s, now)).toEqual({ kind: 'live', state: 'done' });
  });

  it('a failed run gets the failed glyph while still recent', () => {
    const now = 1000;
    const endedAt = new Date(now - 1).toISOString();
    const meta = run('r', 'dylan', 'claude', 'failed', new Date(0).toISOString(), endedAt);
    expect(deriveAgentTileState([meta], snapshot(), now)).toEqual({ kind: 'live', state: 'failed' });
  });

  it('settles back to quiet once the end is no longer recent', () => {
    const now = RECENT_ENDED_MS * 3;
    const endedAt = new Date(0).toISOString();
    const meta = run('r', 'dylan', 'claude', 'done', new Date(0).toISOString(), endedAt);
    expect(deriveAgentTileState([meta], snapshot(), now)).toEqual({ kind: 'quiet' });
  });

  it('picks the latest run when there are several', () => {
    const older = run('a', 'dylan', 'claude', 'done', new Date(0).toISOString(), new Date(0).toISOString());
    const newer = run('b', 'dylan', 'claude', 'running', new Date(1_000).toISOString());
    const s = snapshot({ sessionEventsByRun: { b: [chunk] } });
    expect(deriveAgentTileState([older, newer], s, 1_000)).toEqual({ kind: 'live', state: 'thinking' });
  });
});

describe('describeAgentTileState', () => {
  it('names a quiet agent', () => {
    expect(describeAgentTileState({ kind: 'quiet' }, 'Claude')).toBe('Claude quiet');
  });

  it('says waiting on you in words', () => {
    expect(describeAgentTileState({ kind: 'live', state: 'waiting' }, 'Claude')).toBe('Claude is waiting on you');
  });

  it('names a working agent', () => {
    expect(describeAgentTileState({ kind: 'live', state: 'thinking' }, 'Claude')).toBe('Claude working');
  });

  it('names each end state', () => {
    expect(describeAgentTileState({ kind: 'live', state: 'done' }, 'Claude')).toBe('Claude finished');
    expect(describeAgentTileState({ kind: 'live', state: 'failed' }, 'Claude')).toBe('Claude failed');
    expect(describeAgentTileState({ kind: 'live', state: 'stopped' }, 'Claude')).toBe('Claude stopped');
  });
});
