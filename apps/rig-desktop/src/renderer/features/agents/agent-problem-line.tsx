import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useRunnableAgents } from '@renderer/features/chat/use-runnable-agents';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { cn } from '@renderer/lib/utils';
import { agentProblem } from '@shared/core/agents/agent-problem';
import { AgentSetupDialog } from './agent-install';
import { AgentSignInButton } from './agent-sign-in-button';
import { useAgentSignInNeeded } from './use-agent-sign-in-needed';

const NAMES = { claude: 'Claude', codex: 'Codex' } as const;

/**
 * One agent's problem on this Mac (`agentProblem`): not installed, out of
 * date, signed out or failing to start, as one line with one button. Install
 * opens the shared install offer (`AgentSetupDialog`), Update runs the same
 * update as Settings or says where the copy is updated, and Sign in opens
 * the same sign-in dialog. Renders nothing when the agent is fine.
 *
 * `home` is Home's quiet mono line; `space` is a 28px row in a space's
 * agent list.
 */
export function AgentProblemLine({
  agentId,
  variant,
  showMissing = true,
  missing = false,
  onInstall,
}: {
  agentId: 'claude' | 'codex';
  variant: 'home' | 'space';
  /** A missing agent gets a line. */
  showMissing?: boolean;
  /** The caller knows it can't run here (a space's own list), whatever the probe says. */
  missing?: boolean;
  /** Install, when the caller has its own way to open the install offer. */
  onInstall?: () => void;
}) {
  const queryClient = useQueryClient();
  const { data } = useRunnableAgents();
  const { needed, agent, loginMethod, markSignedIn } = useAgentSignInNeeded(agentId);
  const [setUpOpen, setSetUpOpen] = useState(false);
  const [updating, setUpdating] = useState<'idle' | 'busy' | 'failed'>('idle');
  const name = NAMES[agentId];
  const payload = data?.find((a) => a.id === agentId);
  const problem = agentProblem({
    id: agentId,
    name,
    payload: missing && payload ? { ...payload, status: 'missing', installations: [] } : payload,
    signInNeeded: needed,
    showMissing,
  });
  if (!problem) return null;

  const update = async () => {
    if (problem.update?.how === 'elsewhere') {
      toast({ title: `Update ${name}`, description: problem.update.hint });
      return;
    }
    setUpdating('busy');
    const result = await rpc.agents.update(agentId).catch(() => null);
    setUpdating(result?.success ? 'idle' : 'failed');
    void queryClient.invalidateQueries({ queryKey: ['rig', 'agents', 'list'] });
  };

  const buttonClass =
    variant === 'home'
      ? 'text-accent font-sans transition-opacity hover:opacity-80 disabled:opacity-60'
      : 'bg-accent-subtle text-accent ml-auto shrink-0 rounded-chip px-2 py-0.5 text-2xs transition-opacity hover:opacity-80 disabled:opacity-60';
  let button: ReactNode = null;
  if (problem.action === 'install') {
    button = (
      <button
        type="button"
        onClick={() => (onInstall ? onInstall() : setSetUpOpen(true))}
        className={buttonClass}
        data-testid="agent-problem-install"
      >
        Install
      </button>
    );
  } else if (problem.action === 'update') {
    button = (
      <button type="button" onClick={() => void update()} disabled={updating === 'busy'} className={buttonClass} data-testid="agent-problem-update">
        {updating === 'busy' ? 'Updating…' : 'Update'}
      </button>
    );
  } else if (agent && loginMethod) {
    button = <AgentSignInButton agent={agent} loginMethod={loginMethod} onSignedIn={markSignedIn} className={buttonClass} />;
  }
  const text = updating === 'failed' ? `${problem.text} The update didn't finish. Try again.` : problem.text;

  return (
    <>
      <div
        className={cn(
          variant === 'home'
            ? 'text-text-muted flex items-center gap-1.5 self-start font-mono text-xs'
            : 'flex min-h-7 shrink-0 items-center gap-2 rounded-control py-1 pr-2 pl-8'
        )}
        title={variant === 'space' ? text : undefined}
        data-testid="agent-problem"
        data-agent={agentId}
        data-kind={problem.kind}
      >
        <CircleAlert className={cn('text-warning shrink-0', variant === 'home' ? 'size-3' : 'size-3.5')} strokeWidth={1.5} />
        <span className={cn(variant === 'space' && 'min-w-0 text-xs text-text-secondary')}>{text}</span>
        {button}
      </div>
      {!onInstall && problem.action === 'install' && <AgentSetupDialog open={setUpOpen} onOpenChange={setSetUpOpen} agent={agentId} />}
    </>
  );
}
