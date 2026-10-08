import { useEffect } from 'react';
import { useRunnableAgents } from '@renderer/features/chat/use-runnable-agents';
import { toast } from '@renderer/lib/hooks/use-toast';
import { agentsToAlert, alertLines, markAlerted, readAlerted } from './agent-minimum-alert';

/**
 * Raises an agent's version notice (older than Rig is tested with, or out
 * of date) once per agent version, as a toast that opens Settings › Agents,
 * where the notice stays.
 * Marked the moment it shows, like the update toast. Mount once (App).
 */
export function useAgentMinimumAlert(openAgentsSettings: () => void): void {
  const { data } = useRunnableAgents();
  useEffect(() => {
    if (!data) return;
    for (const alert of agentsToAlert(data, readAlerted())) {
      markAlerted(alert.id, alert.version);
      const { title, description } = alertLines(alert.problem);
      toast({
        id: `agent-minimum-${alert.id}`,
        title,
        description,
        action: { label: 'Open Settings', onClick: openAgentsSettings },
        duration: Infinity,
        closeButton: true,
      });
    }
  }, [data, openAgentsSettings]);
}
