import { describe, expect, it } from 'vitest';
import { FIXTURE_EVENTS } from './fixtures';
import { replaySessionTranscript } from './session-transcript';

describe('replaySessionTranscript', () => {
  it('turns a real recorded run into chat transcript turns, with its tool calls and answer', () => {
    const { committed, active } = replaySessionTranscript('run-a', FIXTURE_EVENTS['run-a-claude']);
    const turns = active ? [...committed, active] : committed;
    expect(turns.length).toBeGreaterThan(0);
    const kinds = new Set(turns.flatMap((turn) => turn.items.map((item) => item.kind)));
    expect(kinds.size).toBeGreaterThan(0);
    expect(JSON.stringify(turns)).toContain('"kind":"message"');
  });

  it('unwraps relay-coalesced chunks and closes the turn on turn_ended', () => {
    const chunk = (text: string) => ({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: { type: 'text', text },
    });
    const { committed, active } = replaySessionTranscript('run-x', [
      { seq: 1, kind: 'agent_message_chunk', payload: { chunks: [chunk('Signups '), chunk('fell.')] } },
      { seq: 2, kind: 'turn_ended', payload: { status: 'done' } },
    ]);
    expect(active).toBeNull();
    expect(JSON.stringify(committed)).toContain('Signups fell.');
  });

  it('shows a rig tool by its readable name, as the turn does', () => {
    const { committed } = replaySessionTranscript('run-r', [
      {
        seq: 1,
        kind: 'tool_call',
        payload: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'mcp__rig__rig_people', kind: 'other', status: 'completed' },
      },
      { seq: 2, kind: 'turn_ended', payload: { status: 'done' } },
    ]);
    const json = JSON.stringify(committed);
    expect(json).toContain('Rig · people');
    expect(json).not.toContain('mcp__rig__rig_people');
  });
});
