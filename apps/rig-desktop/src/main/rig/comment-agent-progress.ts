import type { ToolNode, TranscriptTurn } from '@emdash/core/acp';
import type { RigCommentAgentActivity } from '@shared/rig/comments';

export type CommentAgentProgress = {
  activity: RigCommentAgentActivity;
  text: string;
};

const CODEX_SKILLS_CONTEXT_WARNING =
  'Warning: Skill descriptions were shortened to fit the skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest.';

/**
 * The latest real assistant message. ACP exposes provider startup diagnostics
 * and progress commentary as separate assistant messages; only the latest one
 * is the candidate answer, and the known Codex skills-budget diagnostic is UI
 * chrome rather than collaborator-facing prose.
 */
export function assistantText(turns: readonly TranscriptTurn[]): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    const items = turns[i].items;
    for (let j = items.length - 1; j >= 0; j--) {
      const item = items[j];
      if (item.kind !== 'message' || item.role !== 'assistant') continue;
      const text = stripProviderDiagnostic(item.text);
      if (text) return text;
    }
  }
  return '';
}

function stripProviderDiagnostic(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith(CODEX_SKILLS_CONTEXT_WARNING)) return trimmed;
  return trimmed.slice(CODEX_SKILLS_CONTEXT_WARNING.length).trim();
}

export function commentAgentProgress(turn: TranscriptTurn): CommentAgentProgress {
  const text = assistantText([turn]);
  const runningTool = findRunningTool(turn.items);
  if (runningTool) {
    const checkingContext =
      runningTool.kind === 'execute-tool-call' &&
      runningTool.command?.trimStart().startsWith('rig context trace ');
    return { activity: checkingContext ? 'checking-context' : 'using-tool', text };
  }
  if (turn.items.some((item) => item.kind === 'thinking' && item.status === 'thinking')) {
    return { activity: 'thinking', text };
  }
  return { activity: text ? 'writing' : 'working', text };
}

function findRunningTool(items: readonly TranscriptTurn['items'][number][]): ToolNode | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === 'message' || item.kind === 'thinking') continue;
    const nested = findRunningToolNode(item);
    if (nested) return nested;
  }
  return null;
}

function findRunningToolNode(node: ToolNode): ToolNode | null {
  const children = node.children ?? [];
  for (let i = children.length - 1; i >= 0; i--) {
    const nested = findRunningToolNode(children[i]);
    if (nested) return nested;
  }
  return node.status === 'running' ? node : null;
}
