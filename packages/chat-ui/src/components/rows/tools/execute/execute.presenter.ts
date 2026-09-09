import type { SegmentCtx } from '@core/units';
import type { FileMentionSegment } from '@/commands';
import type { ChatExecute, ToolNode } from '@/model';

export function executeFromItem(
  item: Extract<ToolNode, { kind: 'execute-tool-call' }>,
  ctx: SegmentCtx
): ChatExecute {
  const liveOutput = item.terminalId ? ctx.terminalOutputText(item.terminalId) : null;
  const outputText = liveOutput ?? item.outputText;
  return {
    kind: 'execute',
    id: item.id,
    command: item.command ?? item.title,
    ...(item.inputSummary !== undefined ? { inputSummary: item.inputSummary } : {}),
    ...(outputText !== undefined ? { outputText } : {}),
    status: item.status,
    awaitingPermission: ctx.pendingToolCallIds().has(item.toolCallId),
    startedAt: 0,
    ...(item.terminalId !== undefined ? { terminalId: item.terminalId } : {}),
  };
}

/** Command header cap — long enough to stay recognizable, short enough to stay a chip. */
const HEADER_COMMAND_MAX = 60;

/**
 * The header's collapsed label: "Ran <first line of the command>", truncated
 * — literal, not semantic (this names what ran, it does not try to guess
 * what it did; that's what the ✓/✗ glyph and the expanded body are for) —
 * split into segments so a workspace-file mention inside the command (e.g.
 * `cat > "notes.md"`, or an absolute path under the workspace root) renders
 * as a clickable piece of the header instead of plain text.
 *
 * `linkFileMentions` is matched against the UNTRUNCATED first line — the
 * header is truncated for DISPLAY (`HEADER_COMMAND_MAX`), not for matching
 * — then the result is clipped to the visible window. A match that falls
 * entirely past the visible window (truncated away) has nothing left to
 * click and is dropped; this is a deliberate, narrow limitation rather than
 * growing the header to fit every match.
 *
 * Kept in this pure presenter module (no Solid/DOM imports) rather than
 * `execute.def.tsx` so it stays unit-testable without dragging in the
 * markdown parser's jsdom requirement (see `parse.test.ts`'s own comment).
 */
export function commandHeaderSegments(
  command: string,
  linkFileMentions?: (text: string) => ReadonlyArray<FileMentionSegment>
): FileMentionSegment[] {
  const firstLine = (command || '').trim().split('\n')[0]?.trim();
  if (!firstLine) return [{ text: 'command' }];

  const truncated = firstLine.length > HEADER_COMMAND_MAX;
  const visibleLen = truncated ? HEADER_COMMAND_MAX - 1 : firstLine.length;
  const ellipsis = truncated ? '…' : '';
  const plain = (): FileMentionSegment[] => [{ text: firstLine.slice(0, visibleLen) + ellipsis }];

  if (!linkFileMentions) return plain();

  const mentionSegs = linkFileMentions(firstLine);
  const total = mentionSegs.reduce((sum, s) => sum + s.text.length, 0);
  if (total !== firstLine.length) return plain(); // matcher misbehaved — fall back

  const out: FileMentionSegment[] = [];
  let pos = 0;
  for (const seg of mentionSegs) {
    if (pos >= visibleLen) break;
    const remaining = visibleLen - pos;
    const text = seg.text.length > remaining ? seg.text.slice(0, remaining) : seg.text;
    if (text.length > 0) out.push({ text, path: seg.path });
    pos += seg.text.length;
  }

  if (ellipsis) {
    const last = out[out.length - 1];
    if (last && !last.path) last.text += ellipsis;
    else out.push({ text: ellipsis });
  }

  return out.length > 0 ? out : plain();
}
