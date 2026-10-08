import { useEffect } from 'react';
import { useRunnableAgents } from '@renderer/features/chat/use-runnable-agents';
import { toast } from '@renderer/lib/hooks/use-toast';
import { agentsToAlert, markAlerted, readAlerted } from './agent-minimum-alert';

/**
 * Raises the soft "older than Rig is tested with" notice once per agent
 * version, as a toast that opens Settings › Agents, where the notice stays.
 * Marked the moment it shows, like the update toast. Mount once (App).
 */
export function useAgentMinimumAlert(openAgentsSettings: () => void): void {
  const { data } = useRunnableAgents();
  useEffect(() => {
    if (!data) return;
    for (const alert of agentsToAlert(data, readAlerted())) {
      markAlerted(alert.id, alert.version);
      toast({
        id: `agent-minimum-${alert.id}`,
        title: `${alert.name} is older than Rig is tested with`,
        description: `The ${alert.problem.cli} CLI is ${alert.version}. Rig is tested with ${alert.problem.minimum} or newer.`,
        action: { label: 'Open Settings', onClick: openAgentsSettings },
        duration: Infinity,
        closeButton: true,
      });
    }
  }, [data, openAgentsSettings]);
}
