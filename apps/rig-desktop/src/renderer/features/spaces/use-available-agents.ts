import { useEffect, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { rigAgentRunnabilityChangedChannel } from '@shared/rig/agents-status';
import type { AgentKind } from './types';

/**
 * Your agents that can run on this computer right now (installed and
 * working, per main's probe), for the composer's send menu. Undefined until
 * known, or when it can't be read: the menu then offers all of them, as the
 * Room always did. Plain state rather than react-query, so the Room needs
 * no query client.
 */
export function useAvailableAgents(): AgentKind[] | undefined {
  const [agents, setAgents] = useState<AgentKind[] | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const load = () =>
      Promise.resolve()
        .then(() => rpc.agents.list())
        .then(
          (list) => {
            if (!alive) return;
            const ids = list.filter((a) => a.status === 'available').map((a) => a.id);
            setAgents((['claude', 'codex'] as const).filter((agent) => ids.includes(agent)));
          },
          () => undefined
        );
    void load();
    const off = events.on(rigAgentRunnabilityChangedChannel, () => void load());
    return () => {
      alive = false;
      off();
    };
  }, []);
  return agents;
}

/**
 * Your agents that your OTHER Macs report (GET /v1/me/agents through main):
 * a tag of one this Mac can't run still goes to them. Undefined while
 * loading; null when the relay can't say, and the composer then files the
 * request as it always did rather than dropping it.
 */
export function useOtherMacsAgents(): AgentKind[] | null | undefined {
  const [agents, setAgents] = useState<AgentKind[] | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const load = () =>
      Promise.resolve()
        .then(() => rpc.rig.spacesDispatch.otherMacsAgents())
        .then(
          (answer) => {
            if (alive) setAgents(answer ? answer.agents : null);
          },
          () => {
            if (alive) setAgents(null);
          }
        );
    void load();
    const off = events.on(rigAgentRunnabilityChangedChannel, () => void load());
    return () => {
      alive = false;
      off();
    };
  }, []);
  return agents;
}
