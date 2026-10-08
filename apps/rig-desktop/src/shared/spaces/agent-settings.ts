import { defineEvent } from '../lib/ipc/events';

/** One of a space agent's settings as its session reports it (the same shape as `AgentConfigChoice` in main). */
type Choice = { selected: string | null; options: Array<{ id: string; name: string; description?: string }> };

/**
 * A space agent's model / effort changed from outside its settings pill (the
 * agent's own `rig_settings_update`): the new settings, so an open pill shows
 * them without refetching.
 */
export const spacesAgentConfigChangedChannel = defineEvent<{
  bindingId: string;
  agent: 'claude' | 'codex';
  config: { model: Choice | null; effort: Choice | null; mode: Choice | null };
}>('rig:spaces-agent-config-changed');
