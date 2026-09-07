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
  /**
   * Discoverability round (punch-list finding 4): true while the mode is
   * armed and the reader has never dismissed the first-use coach mark —
   * `PaintbrushControl` renders it anchored to the header pill.
   */
  showCoachMark: boolean;
  /** Persists `paintbrushCoachMarkSeen` so the coach mark never shows again this install. */
  dismissCoachMark(): void;
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

  // Optimistic local flag ahead of the settings round trip landing — a
  // reader dismissing the coach mark must not see it flash back for the
  // frame or two before `rig.settings.set` resolves and this query
  // refetches.
  const [dismissedLocally, setDismissedLocally] = useState(false);
  const coachMarkSeen = (settings?.paintbrushCoachMarkSeen ?? false) || dismissedLocally;
  const showCoachMark = on && !coachMarkSeen;
  const dismissCoachMark = useCallback(() => {
    setDismissedLocally(true);
    void rpc.rig.settings.set({ paintbrushCoachMarkSeen: true }).then(() => {
      void queryClient.invalidateQueries({ queryKey: ['rig', 'settings', 'paintbrushAgent'] });
    });
  }, [queryClient]);

  return {
    on,
    toggle: () => setOn((v) => !v),
    agents,
    selected,
    selectAgent,
    mention,
    showCoachMark,
    dismissCoachMark,
  };
}
