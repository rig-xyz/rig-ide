import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import { useRunnableAgents, type RunnableAgent } from '@renderer/features/chat/use-runnable-agents';
import type { AgentMention } from '../comments/comments-store';

/**
 * The paintbrush header control's own state (`docs/document-focus-design.md`
 * §2): whether the mode is armed, and which agent strokes are sent to.
 *
 * Two different lifetimes, deliberately: whether the mode is ON is
 * per-window UI state (plain `useState`, gone the moment this document
 * closes or the app restarts — the spec's own wording) while the CHOSEN
 * agent is a standing preference, worth remembering across sessions the same
 * way the chat panel's own harness choice is (`shared/rig/settings.ts`'s
 * `lastHarness`) — same storage mechanism (`rpc.rig.settings`), a sibling
 * field (`paintbrushAgent`) rather than reusing `lastHarness` itself, since
 * "which agent edits inline for me" and "which agent my chat panel talks to"
 * are two different questions that happen to often share an answer.
 */
export function usePaintbrushMode(): {
  /** Whether the header's orb is armed. */
  on: boolean;
  toggle(): void;
  /** Every agent this machine can actually run right now, for the dropdown. */
  agents: RunnableAgent[];
  /** The agent the dropdown currently has selected, or null before a first choice. */
  selected: RunnableAgent | null;
  /** Persists the choice (`rig.settings`) — survives restarts, global (not per-rig). */
  selectAgent(id: string): void;
  /** `selected`, reshaped for `DocCommentsStore.create`/`openComposer` — null until an agent is actually chosen. */
  mention: AgentMention | null;
} {
  const [on, setOn] = useState(false);
  const { agents } = useRunnableAgents();
  const queryClient = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: ['rig', 'settings', 'paintbrushAgent'],
    queryFn: () => rpc.rig.settings.get(),
  });
  const selectedId = settings?.paintbrushAgent ?? null;
  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId]
  );

  const selectAgent = useCallback(
    (id: string) => {
      void rpc.rig.settings.set({ paintbrushAgent: id }).then(() => {
        void queryClient.invalidateQueries({ queryKey: ['rig', 'settings', 'paintbrushAgent'] });
      });
    },
    [queryClient]
  );

  const mention: AgentMention | null = selected
    ? { providerId: selected.id, name: selected.name }
    : null;

  return { on, toggle: () => setOn((v) => !v), agents, selected, selectAgent, mention };
}
