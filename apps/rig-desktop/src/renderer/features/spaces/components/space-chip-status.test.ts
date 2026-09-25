import { describe, expect, it } from 'vitest';
import type { RoomSnapshot, SessionEvent, SessionRunMeta } from '../types';
import { spaceChipStatus } from './agent-rows';

function run(id: string, owner: string, agent: 'claude' | 'codex', status: SessionRunMeta['status'] = 'running'): SessionRunMeta {
  return { id, agent, owner, model: null, title: '', status, startedAt: new Date().toISOString(), endedAt: null } as SessionRunMeta;
}

const chunk: SessionEvent = { seq: 1, kind: 'agent_message_chunk', payload: { messageId: 'x', content: { type: 'text', text: 'Working' } } };
const asking: SessionEvent = {
  seq: 2,
  kind: 'permission_requested',
  payload: { requestId: 'r1', toolCall: { toolCallId: 't1', title: 'Linear · create issue' }, options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }] },
};

function snapshot(overrides: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    members: [
      { id: 'dylan', name: 'dylan' },
      { id: 'sam', name: 'sam' },
    ],
    sessionMetaByRun: {},
    sessionEventsByRun: {},
    connection: 'live',
    ...overrides,
  } as unknown as RoomSnapshot;
}

describe('spaceChipStatus', () => {
  it('says nothing when nothing is going on', () => {
    expect(spaceChipStatus(snapshot(), 'dylan', 0)).toBeNull();
  });

  it('shows new files when that is all there is', () => {
    expect(spaceChipStatus(snapshot(), 'dylan', 3)).toEqual({ kind: 'new', count: 3 });
  });

  it("ranks someone else's working agent above new files", () => {
    const s = snapshot({ sessionMetaByRun: { r: run('r', 'sam', 'claude') }, sessionEventsByRun: { r: [chunk] } });
    expect(spaceChipStatus(s, 'dylan', 3)).toEqual({ kind: 'others-working', owner: 'sam', agent: 'claude', count: 1 });
  });

  it('ranks your own working agent above others', () => {
    const s = snapshot({
      sessionMetaByRun: { a: run('a', 'sam', 'claude'), b: run('b', 'dylan', 'codex') },
      sessionEventsByRun: { a: [chunk], b: [chunk] },
    });
    expect(spaceChipStatus(s, 'dylan', 0)).toEqual({ kind: 'yours-working', agents: ['codex'] });
  });

  it('ranks your agent waiting on your approval above it working', () => {
    const s = snapshot({ sessionMetaByRun: { b: run('b', 'dylan', 'claude') }, sessionEventsByRun: { b: [chunk, asking] } });
    expect(spaceChipStatus(s, 'dylan', 5)).toEqual({ kind: 'needs-you', agent: 'claude' });
  });

  it("doesn't count someone else's pending approval as yours", () => {
    const s = snapshot({ sessionMetaByRun: { b: run('b', 'sam', 'claude') }, sessionEventsByRun: { b: [chunk, asking] } });
    expect(spaceChipStatus(s, 'dylan', 0)?.kind).toBe('others-working');
  });

  it('puts a lost connection above everything', () => {
    const s = snapshot({ connection: 'offline', sessionMetaByRun: { b: run('b', 'dylan', 'claude') }, sessionEventsByRun: { b: [chunk, asking] } });
    expect(spaceChipStatus(s, 'dylan', 5)).toEqual({ kind: 'offline' });
  });

  it('ignores finished runs', () => {
    const s = snapshot({ sessionMetaByRun: { b: run('b', 'dylan', 'claude', 'done') }, sessionEventsByRun: { b: [chunk] } });
    expect(spaceChipStatus(s, 'dylan', 0)).toBeNull();
  });
});
