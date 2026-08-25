import type { TranscriptTurn } from '@emdash/core/acp/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getEverWrittenPaths,
  getRecentWrites,
  recordFileWritesFromTurns,
  resetWriteActivityForTests,
} from './write-activity';

afterEach(() => {
  resetWriteActivityForTests();
  vi.useRealTimers();
});

function toolCall(overrides: Record<string, unknown>) {
  return {
    id: 'id-1',
    seq: 0,
    toolCallId: 'tc-1',
    title: 'x',
    status: 'done',
    ...overrides,
  };
}

function turnWith(items: unknown[]): TranscriptTurn {
  return { id: 't1', seq: 0, initiator: 'agent', items } as unknown as TranscriptTurn;
}

describe('recordFileWritesFromTurns / getRecentWrites', () => {
  it('records a completed create-file-tool-call', () => {
    const turn = turnWith([toolCall({ kind: 'create-file-tool-call', path: 'a.md', content: '' })]);
    recordFileWritesFromTurns([turn], '/rig-a', 'session-1');
    const writes = getRecentWrites('/rig-a');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ relPath: 'a.md', sessionId: 'session-1' });
  });

  it('ignores a tool call that has not settled yet', () => {
    const turn = turnWith([toolCall({ kind: 'modify-file-tool-call', path: 'b.md', status: 'running', oldText: '', newText: '' })]);
    recordFileWritesFromTurns([turn], '/rig-b', 'session-1');
    expect(getRecentWrites('/rig-b')).toEqual([]);
  });

  it('ignores non-file tool calls entirely', () => {
    const turn = turnWith([toolCall({ kind: 'execute-tool-call' })]);
    recordFileWritesFromTurns([turn], '/rig-c', 'session-1');
    expect(getRecentWrites('/rig-c')).toEqual([]);
  });

  it('recurses into a tool-group\'s children to find a nested file write', () => {
    const turn = turnWith([
      {
        kind: 'tool-group',
        id: 'g1',
        seq: 0,
        label: 'group',
        groupKind: 'sequential',
        status: 'done',
        children: [toolCall({ kind: 'delete-file-tool-call', path: 'nested/c.md' })],
      },
    ]);
    recordFileWritesFromTurns([turn], '/rig-d', 'session-1');
    expect(getRecentWrites('/rig-d').map((w) => w.relPath)).toEqual(['nested/c.md']);
  });

  it('scopes writes by root — a write for one rig never shows up under another', () => {
    const turn = turnWith([toolCall({ kind: 'create-file-tool-call', path: 'a.md', content: '' })]);
    recordFileWritesFromTurns([turn], '/rig-e', 'session-1');
    expect(getRecentWrites('/rig-other')).toEqual([]);
  });

  it('a later write to the same path replaces the earlier one, not duplicates it', () => {
    const first = turnWith([toolCall({ kind: 'create-file-tool-call', path: 'a.md', content: '' })]);
    const second = turnWith([toolCall({ kind: 'modify-file-tool-call', path: 'a.md', oldText: '', newText: '' })]);
    recordFileWritesFromTurns([first], '/rig-f', 'session-1');
    recordFileWritesFromTurns([second], '/rig-f', 'session-1');
    expect(getRecentWrites('/rig-f')).toHaveLength(1);
  });

  it('a write older than the 5-minute window is not returned', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const turn = turnWith([toolCall({ kind: 'create-file-tool-call', path: 'a.md', content: '' })]);
    recordFileWritesFromTurns([turn], '/rig-g', 'session-1');
    expect(getRecentWrites('/rig-g')).toHaveLength(1);

    vi.setSystemTime(6 * 60 * 1000);
    expect(getRecentWrites('/rig-g')).toEqual([]);
  });

  it('returns newest-first when multiple files were written', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    recordFileWritesFromTurns(
      [turnWith([toolCall({ kind: 'create-file-tool-call', path: 'first.md', content: '' })])],
      '/rig-h',
      'session-1'
    );
    vi.setSystemTime(1000);
    recordFileWritesFromTurns(
      [turnWith([toolCall({ kind: 'create-file-tool-call', path: 'second.md', content: '' })])],
      '/rig-h',
      'session-1'
    );
    expect(getRecentWrites('/rig-h').map((w) => w.relPath)).toEqual(['second.md', 'first.md']);
  });
});

describe('getEverWrittenPaths', () => {
  it('remembers a write past the 5-minute card window — this set never prunes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    recordFileWritesFromTurns(
      [turnWith([toolCall({ kind: 'create-file-tool-call', path: 'a.md', content: '' })])],
      '/rig-i',
      'session-1'
    );
    vi.setSystemTime(60 * 60 * 1000); // 1 hour later — long past the card window
    expect(getRecentWrites('/rig-i')).toEqual([]);
    expect(getEverWrittenPaths('/rig-i').has('a.md')).toBe(true);
  });

  it('accumulates every distinct path written, not just the latest', () => {
    recordFileWritesFromTurns(
      [turnWith([toolCall({ kind: 'create-file-tool-call', path: 'a.md', content: '' })])],
      '/rig-j',
      'session-1'
    );
    recordFileWritesFromTurns(
      [turnWith([toolCall({ kind: 'create-file-tool-call', path: 'b.md', content: '' })])],
      '/rig-j',
      'session-1'
    );
    expect([...getEverWrittenPaths('/rig-j')].sort()).toEqual(['a.md', 'b.md']);
  });

  it('a root with no recorded writes returns an empty set', () => {
    expect(getEverWrittenPaths('/never-touched').size).toBe(0);
  });

  it('scopes by root, same as getRecentWrites', () => {
    recordFileWritesFromTurns(
      [turnWith([toolCall({ kind: 'create-file-tool-call', path: 'a.md', content: '' })])],
      '/rig-k',
      'session-1'
    );
    expect(getEverWrittenPaths('/rig-other-k').has('a.md')).toBe(false);
  });
});
