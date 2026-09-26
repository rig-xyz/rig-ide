import { useRunnableAgents, type RunnableAgent } from '@renderer/features/chat/use-runnable-agents';
import { useCommentMode, useSmartHighlighterEnabled } from '@renderer/features/comment-mode/use-comment-mode';
import type { AgentMention } from '../comments/comments-store';

/**
 * A Markdown file's comment mode (canvas board 16), which the paintbrush now
 * is: the header's Comment control arms it, and a selection release opens
 * the composer addressed to whoever was picked. Picking an agent is the old
 * Smart Highlighter: its reply proposes an edit in place.
 */
export function usePaintbrushMode(): {
  /**
   * Experimental › Smart Highlighter (`smartHighlighterEnabled`): whether
   * agents can be picked here, and whether the paintbrush's decoration layer
   * is registered. Comment mode itself works either way.
   */
  enabled: boolean;
  on: boolean;
  setOn(on: boolean): void;
  toggle(): void;
  /** The agents that can be picked here: every runnable one with the setting on, none without. */
  agents: RunnableAgent[];
  /** The agent drafts are addressed to, or null for just you. */
  selected: RunnableAgent | null;
  pick(agentId: string | null): void;
  /** `selected`, shaped for `DocCommentsStore.openComposer`. */
  mention: AgentMention | null;
} {
  const enabled = useSmartHighlighterEnabled();
  const { agents: runnable } = useRunnableAgents();
  const agents = enabled ? runnable : [];
  const mode = useCommentMode(agents);
  return {
    enabled,
    on: mode.on,
    setOn: mode.setOn,
    toggle: mode.toggle,
    agents,
    selected: mode.who,
    pick: mode.pick,
    mention: mode.who ? { providerId: mode.who.id, name: mode.who.name } : null,
  };
}
