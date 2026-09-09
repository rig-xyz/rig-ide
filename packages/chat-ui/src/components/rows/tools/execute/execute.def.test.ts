import type { SegmentCtx } from '@core/units';
import { describe, expect, it } from 'vitest';
import type { FileMentionSegment } from '@/commands';
import type { ToolNode } from '@/model';
import { commandHeaderSegments, executeFromItem } from './execute.presenter';

function executeItem(overrides: Partial<Extract<ToolNode, { kind: 'execute-tool-call' }>> = {}) {
  return {
    kind: 'execute-tool-call',
    id: 'tool-1',
    seq: 0,
    toolCallId: 'call-1',
    title: 'echo ok',
    command: 'echo ok',
    status: 'done',
    ...overrides,
  } satisfies Extract<ToolNode, { kind: 'execute-tool-call' }>;
}

function ctx(outputText: string | null): SegmentCtx {
  return {
    caches: {} as SegmentCtx['caches'],
    expanded: () => false,
    active: false,
    plan: () => null,
    pendingToolCallIds: () => new Set<string>(),
    terminalOutputText: () => outputText,
    threadSummary: () => null,
  };
}

describe('executeFromItem', () => {
  it('passes static outputText through when no terminal id is present', () => {
    expect(executeFromItem(executeItem({ outputText: 'static output' }), ctx(null))).toMatchObject({
      command: 'echo ok',
      outputText: 'static output',
    });
  });

  it('prefers live terminal output over stale tool output', () => {
    expect(
      executeFromItem(
        executeItem({ terminalId: 'term-1', outputText: 'stale output' }),
        ctx('live output')
      )
    ).toMatchObject({
      outputText: 'live output',
      terminalId: 'term-1',
    });
  });

  it('falls back to static outputText when terminal output is unavailable', () => {
    expect(
      executeFromItem(
        executeItem({ terminalId: 'term-1', outputText: 'static fallback' }),
        ctx(null)
      )
    ).toMatchObject({
      outputText: 'static fallback',
      terminalId: 'term-1',
    });
  });

  it('passes provider inputSummary through for the card header', () => {
    expect(
      executeFromItem(executeItem({ inputSummary: 'Installing Dependencies' }), ctx(null))
    ).toMatchObject({
      inputSummary: 'Installing Dependencies',
    });
  });
});

// ── commandHeaderSegments ────────────────────────────────────────────────────

/** A fake `linkFileMentions`: matches one literal substring, resolving to `path`. */
function matcherFor(needle: string, path: string): (text: string) => FileMentionSegment[] {
  return (text) => {
    const idx = text.indexOf(needle);
    if (idx === -1) return [{ text }];
    const segs: FileMentionSegment[] = [];
    if (idx > 0) segs.push({ text: text.slice(0, idx) });
    segs.push({ text: needle, path });
    const rest = text.slice(idx + needle.length);
    if (rest.length > 0) segs.push({ text: rest });
    return segs;
  };
}

describe('commandHeaderSegments', () => {
  it('returns a single plain segment for a short command with no matcher', () => {
    expect(commandHeaderSegments('echo ok')).toEqual([{ text: 'echo ok' }]);
  });

  it('truncates a long command the same way the old plain header did, with no matcher', () => {
    const long = 'x'.repeat(80);
    const segs = commandHeaderSegments(long);
    expect(segs).toEqual([{ text: `${'x'.repeat(59)}…` }]);
  });

  it('falls back to the plain (possibly truncated) label when the matcher finds nothing', () => {
    const noMatch = () => [{ text: 'cat > "notes.md"' }];
    expect(commandHeaderSegments('cat > "notes.md"', noMatch)).toEqual([
      { text: 'cat > "notes.md"' },
    ]);
  });

  it('splits the header into plain/link/plain segments around a fully-visible match', () => {
    const matcher = matcherFor('notes.md', 'notes.md');
    expect(commandHeaderSegments('cat > "notes.md" now', matcher)).toEqual([
      { text: 'cat > "' },
      { text: 'notes.md', path: 'notes.md' },
      { text: '" now' },
    ]);
  });

  it('drops the leading plain segment when the match starts at position 0', () => {
    const matcher = matcherFor('notes.md', 'notes.md');
    expect(commandHeaderSegments('notes.md', matcher)).toEqual([
      { text: 'notes.md', path: 'notes.md' },
    ]);
  });

  it('clips a match straddling the truncation boundary; the ellipsis stays its own plain segment (never merged into the clickable text)', () => {
    // 55 'a's + the needle starting at index 55; visible window is 59 chars,
    // so only the first 4 chars of the needle are visible.
    const prefix = 'a'.repeat(55);
    const needle = 'docs/a-very-long-file-name.md';
    const matcher = matcherFor(needle, 'docs/a-very-long-file-name.md');
    const command = prefix + needle;
    const segs = commandHeaderSegments(command, matcher);
    expect(segs).toEqual([
      { text: prefix },
      { text: needle.slice(0, 4), path: 'docs/a-very-long-file-name.md' },
      { text: '…' },
    ]);
  });

  it('drops a match that falls entirely past the truncation boundary', () => {
    const prefix = 'a'.repeat(70); // already past HEADER_COMMAND_MAX on its own
    const matcher = matcherFor('notes.md', 'notes.md');
    const command = `${prefix} notes.md`;
    const segs = commandHeaderSegments(command, matcher);
    expect(segs).toEqual([{ text: `${'a'.repeat(59)}…` }]);
  });

  it('ignores a matcher whose segments do not reconstruct the input text', () => {
    const brokenMatcher = () => [{ text: 'not the same text at all', path: 'x.md' }];
    expect(commandHeaderSegments('echo ok', brokenMatcher)).toEqual([{ text: 'echo ok' }]);
  });

  it('returns the "command" placeholder for an empty command regardless of a matcher', () => {
    const matcher = matcherFor('notes.md', 'notes.md');
    expect(commandHeaderSegments('', matcher)).toEqual([{ text: 'command' }]);
  });
});
