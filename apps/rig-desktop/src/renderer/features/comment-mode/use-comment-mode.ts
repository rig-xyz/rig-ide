import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import type { RunnableAgent } from '@renderer/features/chat/use-runnable-agents';
import { rpc } from '@renderer/lib/ipc';

/**
 * Comment mode (canvas board 16): one mode for files and pages. On, a
 * selection (a file) or a click (a page) opens a draft straight away,
 * addressed to whoever was picked: you, or one of your agents. It replaces
 * the Smart Highlighter's own switch; same mechanic, one name.
 *
 * Whether it's on is per view and never remembered. Who it's addressed to is
 * a standing choice (`rig.settings`' `paintbrushAgent`, null for "just me"),
 * shared by every file and page.
 */
export function useCommentMode(agents: RunnableAgent[]): {
  on: boolean;
  setOn(on: boolean): void;
  toggle(): void;
  /** The agent drafts are addressed to, or null for just you (also when the saved one can't be asked here). */
  who: RunnableAgent | null;
  /** Picks who (null for just you) and turns the mode on. */
  pick(agentId: string | null): void;
} {
  const [on, setOn] = useState(false);
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: ['rig', 'settings', 'paintbrushAgent'],
    queryFn: () => rpc.rig.settings.get(),
  });
  const savedId = settings?.paintbrushAgent ?? null;
  const who = agents.find((agent) => agent.id === savedId) ?? null;

  const pick = useCallback(
    (agentId: string | null) => {
      setOn(true);
      void rpc.rig.settings.set({ paintbrushAgent: agentId }).then(() => {
        void queryClient.invalidateQueries({ queryKey: ['rig', 'settings', 'paintbrushAgent'] });
      });
    },
    [queryClient]
  );

  return { on, setOn, toggle: () => setOn((v) => !v), who, pick };
}
