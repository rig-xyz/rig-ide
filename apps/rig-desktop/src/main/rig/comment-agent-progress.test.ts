import type { TranscriptTurn } from '@emdash/core/acp';
import { describe, expect, it } from 'vitest';
import { assistantText, commentAgentProgress } from './comment-agent-progress';

function turn(items: TranscriptTurn['items']): TranscriptTurn {
  return { id: 'turn-1', seq: 1, initiator: 'user', items };
}

describe('commentAgentProgress', () => {
  it('streams assistant prose while it is being written', () => {
    const current = turn([
      { kind: 'message', id: 'user', seq: 0, role: 'user', text: 'Why?' },
      { kind: 'message', id: 'assistant', seq: 1, role: 'assistant', text: 'Because the' },
    ]);

    expect(commentAgentProgress(current)).toEqual({ activity: 'writing', text: 'Because the' });
    expect(assistantText([current])).toBe('Because the');
  });

  it('drops Codex startup diagnostics and posts only the latest answer message', () => {
    const current = turn([
      {
        kind: 'message',
        id: 'warning',
        seq: 0,
        role: 'assistant',
        text: 'Warning: Skill descriptions were shortened to fit the skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest.',
      },
      {
        kind: 'message',
        id: 'progress',
        seq: 1,
        role: 'assistant',
        text: 'I’m using the Rig context trace to check the source.',
      },
      {
        kind: 'message',
        id: 'answer',
        seq: 2,
        role: 'assistant',
        text: 'The recorded source is finance/q2.md.',
      },
    ]);

    expect(assistantText([current])).toBe('The recorded source is finance/q2.md.');
  });

  it('does not stream a standalone Codex startup diagnostic as thinking', () => {
    const current = turn([
      {
        kind: 'message',
        id: 'warning',
        seq: 0,
        role: 'assistant',
        text: 'Warning: Skill descriptions were shortened to fit the skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest.',
      },
    ]);

    expect(commentAgentProgress(current)).toEqual({ activity: 'working', text: '' });
  });

  it('surfaces provenance lookup activity without exposing the opaque target', () => {
    const current = turn([
      {
        kind: 'execute-tool-call',
        id: 'tool',
        seq: 0,
        toolCallId: 'call-1',
        title: 'Run command',
        status: 'running',
        command: 'rig context trace --target secret-locator --json',
      },
    ]);

    expect(commentAgentProgress(current)).toEqual({ activity: 'checking-context', text: '' });
  });

  it('distinguishes thinking and other tool work from a stalled turn', () => {
    expect(
      commentAgentProgress(
        turn([
          {
            kind: 'thinking',
            id: 'thinking',
            seq: 0,
            segmentId: 'segment-1',
            text: '',
            status: 'thinking',
            startedAt: 1,
          },
        ])
      ).activity
    ).toBe('thinking');
    expect(
      commentAgentProgress(
        turn([
          {
            kind: 'read-tool-call',
            id: 'tool',
            seq: 0,
            toolCallId: 'call-1',
            title: 'Read file',
            status: 'running',
            path: 'docs/forecast.md',
          },
        ])
      ).activity
    ).toBe('using-tool');
  });
});
