import type { AgentInstallationStatus } from '@shared/core/agents/agent-payload';
import { agentProblem, type AgentProblem } from '@shared/core/agents/agent-problem';

/**
 * The one-time alert for an agent older than Rig is tested with: a toast,
 * raised once per agent and version, remembered on this computer
 * (`rig-agent-minimum-alerted`, a JSON map of agent id to the version last
 * alerted). The notice itself stays in Settings › Agents. Storage isn't
 * guaranteed: a read that fails remembers nothing, and the toast can show
 * again next launch.
 */

const KEY = 'rig-agent-minimum-alerted';

type AgentStatus = Pick<AgentInstallationStatus, 'status' | 'version' | 'installations' | 'used' | 'latestVersion'> & {
  id: string;
  name: string;
};

export type MinimumAlert = { id: string; name: string; version: string; problem: AgentProblem };

/** The agents to alert about now: below the tested version, at a version not alerted yet. */
export function agentsToAlert(agents: readonly AgentStatus[], alerted: Readonly<Record<string, string>>): MinimumAlert[] {
  const out: MinimumAlert[] = [];
  for (const agent of agents) {
    const problem = agentProblem({ id: agent.id, name: agent.name, payload: agent, signInNeeded: false, belowMinimum: true });
    if (problem?.kind !== 'belowMinimum' || !problem.version) continue;
    if (alerted[agent.id] === problem.version) continue;
    out.push({ id: agent.id, name: agent.name, version: problem.version, problem });
  }
  return out;
}

export function readAlerted(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

export function markAlerted(id: string, version: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readAlerted(), [id]: version }));
  } catch {
    // Not remembered: the toast may show again next launch.
  }
}
