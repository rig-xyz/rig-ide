import type { ToolNode, TranscriptTurn } from '@emdash/core/acp/client';
import type { SessionEvent, SessionStatus } from './types';

/**
 * A space session's turns (`TranscriptTurn`s, from its chat store) drawn the
 * way the Room draws an agent's turn: the prompt as your message, then one
 * session card built from the same ACP-shaped events a Room run logs
 * (`projection.ts`). Pure, so the mapping is testable.
 */

export type SessionApproval = {
  requestId: string;
  title: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
};

export type SessionTurnView = {
  id: string;
  /** What you asked: the turn's user message, if it has one. */
  prompt: string | null;
  /** The card's events: steps, thinking, the answer, and how it ended. */
  events: SessionEvent[];
  status: SessionStatus;
};

/** The ACP tool kind the Room's steps read, from the chat model's item kind. */
const ACP_KIND: Record<string, string> = {
  'execute-tool-call': 'execute',
  'read-tool-call': 'read',
  'create-file-tool-call': 'edit',
  'modify-file-tool-call': 'edit',
  'delete-file-tool-call': 'delete',
  'search-tool-call': 'search',
  'mcp-tool-call': 'other',
  'web-fetch-tool-call': 'fetch',
  'spawn-subagent-tool-call': 'think',
  'create-plan-tool-call': 'think',
};

const ACP_STATUS = { running: 'in_progress', done: 'completed', error: 'failed' } as const;

/** Every tool call in a node, groups opened up, in order. */
function toolCalls(node: ToolNode): Exclude<ToolNode, { kind: 'tool-group' }>[] {
  if (node.kind === 'tool-group') return node.children.flatMap(toolCalls);
  return [node, ...(node.children ?? []).flatMap(toolCalls)];
}

function toolEvent(call: Exclude<ToolNode, { kind: 'tool-group' }>): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    toolCallId: call.toolCallId,
    kind: call.kind === 'unknown-tool-call' ? (call.toolKind ?? 'other') : (ACP_KIND[call.kind] ?? 'other'),
    title: call.title,
    status: ACP_STATUS[call.status],
  };
  if ('path' in call && call.path) payload.locations = [{ path: call.path }];
  if (call.kind === 'modify-file-tool-call') {
    payload.content = [{ type: 'diff', path: call.path, oldText: call.oldText, newText: call.newText }];
  } else if (call.kind === 'create-file-tool-call') {
    payload.content = [{ type: 'diff', path: call.path, oldText: null, newText: call.content }];
  }
  return payload;
}

/**
 * One turn as the Room would show it. `live` marks the turn still going;
 * `approvals` are what it waits on you for (the live store's queue).
 */
export function turnView(
  turn: TranscriptTurn,
  { live = false, approvals = [] }: { live?: boolean; approvals?: readonly SessionApproval[] } = {}
): SessionTurnView {
  const events: SessionEvent[] = [];
  const push = (kind: string, payload: Record<string, unknown>) =>
    events.push({ seq: events.length + 1, kind, payload });
  let prompt: string | null = null;
  for (const item of turn.items) {
    if (item.kind === 'message') {
      if (item.role === 'user') prompt = prompt === null ? item.text : `${prompt}\n\n${item.text}`;
      else push('agent_message_chunk', { messageId: item.id, content: { type: 'text', text: item.text } });
    } else if (item.kind === 'thinking') {
      push('agent_thought_chunk', { content: { type: 'text', text: item.text } });
    } else {
      for (const call of toolCalls(item)) push('tool_call', toolEvent(call));
    }
  }
  for (const approval of approvals) {
    push('permission_requested', {
      requestId: approval.requestId,
      toolCall: { toolCallId: approval.requestId, title: approval.title },
      options: approval.options,
    });
  }
  const outcome = turn.outcome?.kind;
  const status: SessionStatus = live
    ? approvals.length > 0
      ? 'waiting'
      : 'running'
    : outcome === 'error'
      ? 'failed'
      : outcome === 'cancelled' || outcome === 'interrupted'
        ? 'stopped'
        : 'done';
  if (!live) push('turn_ended', { status });
  return { id: turn.id, prompt, events, status };
}
