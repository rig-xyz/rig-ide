import type { RunProblem } from '@shared/rig/orch-progress';

/**
 * What stopped a read, in plain words, and its one fix: the same on the Read
 * step and on Home's catch-up strip. `fix` names the button; who does what
 * on a click is the caller's (sign in, retry, open the agent's sign-in, or
 * the connector's page).
 */

export type ProblemCopy = { title: string; detail: string; fix: string };

const TOOL_NAME: Record<string, string> = {
  slack: 'Slack',
  linear: 'Linear',
  github: 'GitHub',
  gmail: 'Gmail',
  calendar: 'Calendar',
  notion: 'Notion',
};

export const toolName = (connector: string) =>
  TOOL_NAME[connector] ?? connector.charAt(0).toUpperCase() + connector.slice(1);

/** A run that stopped: why, and its fix. With no known cause, Try again. */
export function stoppedCopy(problem: RunProblem | undefined, error?: string): ProblemCopy {
  switch (problem) {
    case 'rig_signed_out':
      return {
        title: 'Your Rig sign-in lapsed',
        detail: 'Sign in again and Rig picks up where it stopped.',
        fix: 'Sign in again',
      };
    case 'relay_unreachable':
      return {
        title: "Rig can't reach its server",
        detail: 'Check your connection; nothing is lost.',
        fix: 'Try again',
      };
    case 'agent_signed_out':
      return {
        title: 'Claude needs signing in',
        detail: 'Claude is signed out, or on an API key that can’t reach your tools.',
        fix: 'Sign in to Claude',
      };
    case 'timeout':
      return {
        title: 'Reading took too long',
        detail: 'What it found so far is on your Feed.',
        fix: 'Try again',
      };
    default:
      return {
        title: 'Rig stopped reading',
        detail: error ?? 'Something went wrong while reading.',
        fix: 'Try again',
      };
  }
}

/** A connector that needs signing in again: the run goes on without it. */
export function reconnectCopy(connector: string, connectorsHome: string): ProblemCopy {
  const name = toolName(connector);
  return {
    title: `${name} needs reconnecting`,
    detail: `Rig read around it this time.`,
    fix: connector === 'github' ? 'Sign in to gh again ↗' : `Reconnect in ${connectorsHome} ↗`,
  };
}
