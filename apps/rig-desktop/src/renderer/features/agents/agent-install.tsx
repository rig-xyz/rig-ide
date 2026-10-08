import { Check, Copy, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { hasCliLogin, preferredInstallOptions } from '@renderer/features/onboarding/onboarding-state';
import { useClipboard } from '@renderer/lib/hooks/use-clipboard';
import { toast } from '@renderer/lib/hooks/use-toast';
import { events, rpc } from '@renderer/lib/ipc';
import { AgentIcon } from '@renderer/lib/ui/agent-icon';
import { Button } from '@renderer/lib/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@renderer/lib/ui/dialog';
import { cn } from '@renderer/lib/utils';
import type { AgentPayload, InstallMethod, InstallOption } from '@shared/core/agents/agent-payload';
import { agentInstallationStatusUpdatedChannel } from '@shared/events/appEvents';
import { rigAgentRunnabilityChangedChannel } from '@shared/rig/agents-status';
import { installErrorText } from './install-error-text';

/**
 * Installing Claude or Codex from anywhere in the app: the first-run Agent
 * step, Settings › Agents, Home's "Set up an agent" and a space's agent list
 * all use these. Plain state, no react-query, so the Room (which has no
 * query client) can open it too. A finished install changes the probe, and
 * main pushes `rigAgentRunnabilityChangedChannel`, which every agent list in
 * the app already listens to.
 */

/** The agents spaces run, in the order they're offered. */
export const SPACE_AGENT_IDS = ['claude', 'codex'] as const;

/** Runs `rpc.agents.install` for one agent; a failure says why in a toast. */
export function useAgentInstaller(onInstalled?: (id: string) => void) {
  const [installingId, setInstallingId] = useState<string | null>(null);
  const install = async (agent: Pick<AgentPayload, 'id' | 'name'>, method: InstallMethod) => {
    setInstallingId(agent.id);
    try {
      const result = await rpc.agents.install(agent.id, undefined, method);
      if (!result.success) {
        toast({ ...installErrorText(result.error, agent.name), variant: 'destructive' });
        return false;
      }
      onInstalled?.(agent.id);
      return true;
    } catch (error) {
      toast({ ...installErrorText(error, agent.name), variant: 'destructive' });
      return false;
    } finally {
      setInstallingId(null);
    }
  };
  return { installingId, install };
}

/** `rpc.agents.list()` as plain state, fresh after every probe change. Undefined until the first answer. */
export function useAgentPayloads(): { agents: AgentPayload[] | undefined; reload: () => void } {
  const [agents, setAgents] = useState<AgentPayload[] | undefined>(undefined);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    void Promise.resolve()
      .then(() => rpc.agents.list() as Promise<AgentPayload[]>)
      .then(
        (list) => {
          if (alive) setAgents(list);
        },
        () => undefined
      );
    return () => {
      alive = false;
    };
  }, [nonce]);
  useEffect(() => {
    const reload = () => setNonce((n) => n + 1);
    const offRunnable = events.on(rigAgentRunnabilityChangedChannel, reload);
    const offStatus = events.on(agentInstallationStatusUpdatedChannel, reload);
    return () => {
      offRunnable();
      offStatus();
    };
  }, []);
  return { agents, reload: () => setNonce((n) => n + 1) };
}

/** One agent's install offer: its commands, each with Copy and Install, and a sign-in note. */
export function AgentInstallRow({
  agent,
  installing,
  onInstall,
  className,
}: {
  agent: Pick<AgentPayload, 'id' | 'name' | 'icon' | 'installOptions' | 'capabilities'>;
  installing: boolean;
  onInstall: (method: InstallMethod) => void;
  className?: string;
}) {
  const options = preferredInstallOptions(agent.installOptions);
  if (options.length === 0) {
    return (
      <div
        className={cn('border-border-hairline flex items-center gap-2 rounded-control border p-3', className)}
        data-testid="agent-install-row"
        data-agent-id={agent.id}
      >
        <AgentIcon icon={agent.icon} size={16} />
        <span className="text-text-primary flex-1 text-sm font-medium">{agent.name}</span>
        <span className="text-text-muted text-xs">Rig can’t install this one for you</span>
      </div>
    );
  }

  return (
    <div
      className={cn('border-border-hairline flex flex-col gap-2 rounded-control border p-3', className)}
      data-testid="agent-install-row"
      data-agent-id={agent.id}
    >
      <div className="flex items-center gap-2">
        <AgentIcon icon={agent.icon} size={16} />
        <span className="text-text-primary text-sm font-medium">{agent.name}</span>
      </div>
      {options.map((option) => (
        <InstallCommandRow
          key={option.method}
          option={option}
          installing={installing}
          onInstall={() => onInstall(option.method)}
        />
      ))}
      {hasCliLogin(agent.capabilities) && (
        <p className="text-text-muted text-xs">{agent.name} may ask you to sign in the first time you use it.</p>
      )}
      {agent.id === 'codex' && (
        // The ChatGPT app carries its own Codex, which Rig finds by itself.
        <p className="text-text-muted text-xs" data-testid="codex-chatgpt-hint">
          Already use the ChatGPT app? Sign in there and Rig will find Codex.
        </p>
      )}
    </div>
  );
}

function InstallCommandRow({
  option,
  installing,
  onInstall,
}: {
  option: InstallOption;
  installing: boolean;
  onInstall: () => void;
}) {
  const clipboard = useClipboard();
  return (
    <div className="bg-bg-2 flex items-center gap-2 rounded-control px-2 py-1.5">
      <code className="text-text-secondary min-w-0 flex-1 truncate font-mono text-xs">{option.command}</code>
      <button
        type="button"
        onClick={() => clipboard.copy(option.command)}
        className="text-text-muted hover:text-text-primary flex shrink-0 items-center gap-1 text-xs"
      >
        {clipboard.copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        {clipboard.copied ? 'Copied' : 'Copy'}
      </button>
      <Button size="xs" onClick={onInstall} disabled={installing} data-testid={`agent-install-${option.method}`}>
        {installing ? <Loader2 className="size-3 animate-spin" /> : 'Install'}
      </Button>
    </div>
  );
}

/**
 * Claude and Codex, each either ready or with its install offer, and Check
 * again for an install done some other way. `only` narrows it to one agent.
 */
export function AgentSetupList({ only }: { only?: string }) {
  const { agents, reload } = useAgentPayloads();
  const { installingId, install } = useAgentInstaller(() => reload());
  const [checking, setChecking] = useState(false);
  const ids = only ? [only] : [...SPACE_AGENT_IDS];
  const shown = (agents ?? []).filter((a) => ids.includes(a.id)).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));

  const checkAgain = async () => {
    setChecking(true);
    try {
      await rpc.agents.probeAll();
    } catch {
      // The list below still reloads with whatever the last probe found.
    } finally {
      setChecking(false);
      reload();
    }
  };

  if (!agents) {
    return (
      <div className="text-text-muted flex items-center justify-center gap-2 px-3 py-6 text-sm">
        <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
        Checking this Mac…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="agent-setup-list">
      {shown.map((agent) =>
        agent.status === 'available' ? (
          <div
            key={agent.id}
            className="border-border-hairline flex min-h-9 items-center gap-2 rounded-control border px-3 py-2"
            data-testid="agent-ready-row"
            data-agent-id={agent.id}
          >
            <AgentIcon icon={agent.icon} size={16} />
            <span className="text-text-primary min-w-0 flex-1 truncate text-sm">{agent.name}</span>
            <span className="text-success text-xs">Ready on this Mac</span>
          </div>
        ) : (
          <AgentInstallRow
            key={agent.id}
            agent={agent}
            installing={installingId === agent.id}
            onInstall={(method) => void install(agent, method)}
          />
        )
      )}
      <Button variant="outline" size="sm" className="self-center" onClick={() => void checkAgain()} disabled={checking}>
        <RefreshCw className={cn('size-3.5', checking && 'animate-spin')} strokeWidth={1.5} />
        {checking ? 'Checking…' : 'Check again'}
      </Button>
    </div>
  );
}

/** "Set up an agent" as a dialog, from anywhere: Home, a space's agent list, the composer. */
export function AgentSetupDialog({
  open,
  onOpenChange,
  agent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Just this agent; both Claude and Codex without it. */
  agent?: string;
}) {
  const title = agent === 'claude' ? 'Set up Claude' : agent === 'codex' ? 'Set up Codex' : 'Set up an agent';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="agent-setup-dialog">
        <div className="flex shrink-0 items-center justify-between px-4 py-3">
          <DialogTitle>{title}</DialogTitle>
          <DialogClose />
        </div>
        <div className="flex flex-col gap-3 overflow-y-auto px-4 pb-4">
          <p className="text-text-secondary text-sm">Spaces work with Claude and Codex. Install one on this Mac to ask it things here.</p>
          {open && <AgentSetupList only={agent} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
