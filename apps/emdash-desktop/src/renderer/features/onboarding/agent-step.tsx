import { useQuery } from '@tanstack/react-query';
import { Bot, CheckCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AgentRow } from '@renderer/features/settings/agents-page/AgentRow';
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client';
import { RECOMMENDED_IDS } from '@renderer/features/settings/agents-page/CliAgentsList';
import { InstallDependencyCard } from '@renderer/features/settings/agents-page/InstallDependencyCard';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { useAgentInstallationStatus } from '@renderer/lib/stores/use-agent-installation-statuses';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { Button } from '@renderer/lib/ui/button';
import { PRODUCT_NAME } from '@shared/app-identity';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import {
  cliLoginMethod,
  hasInstalledAgent,
  onboardingAgents,
  preferredInstallOptions,
} from './agent-step-state';

/**
 * One recommended agent: its status row, plus whichever single action it needs
 * next — install it, or sign in to it. Its own component so each row can hold
 * its own installation view-model.
 */
function AgentSetupRow({ agent }: { agent: AgentPayload }) {
  const vm = useAgentInstallationStatus(agent.id, undefined, agent);
  const installed = vm.status === 'available';
  const loginMethod = cliLoginMethod(agent.capabilities);
  // Flipped by the sign-in modal's completion callback, which only fires when
  // the CLI actually reports authenticated — signing in succeeded silently
  // before this, which read as "nothing happened".
  const [signedIn, setSignedIn] = useState(false);
  // Probe existing auth up front, so someone already signed in (or authed via
  // an API key the CLI recognizes) sees the check immediately instead of being
  // offered a sign-in that opens a terminal just to say "already logged in".
  const { data: probed } = useQuery({
    queryKey: ['onboarding', 'agent-auth', agent.id],
    enabled: installed && loginMethod !== undefined,
    queryFn: async () => {
      const client = await getAgentConfigRuntimeClient();
      const result = await client.refreshAuthStatus({ providerId: agent.id });
      return result.success ? result.data : null;
    },
  });
  const showSignedIn = signedIn || probed?.kind === 'authenticated';
  const installOptions = useMemo(
    () => preferredInstallOptions(vm.data?.installOptions ?? agent.installOptions),
    [vm.data?.installOptions, agent.installOptions]
  );

  return (
    <div className="rounded-lg border">
      <AgentRow agent={agent} />
      {!installed && (
        <div className="px-3 pb-3">
          <InstallDependencyCard
            vm={vm}
            installOptions={installOptions}
            isInstalling={vm.isInstalling}
            installingMethod={vm.installingMethod}
            className="border-0 p-0"
          />
        </div>
      )}
      {installed && loginMethod && (
        <div className="px-3 pb-3">
          {showSignedIn ? (
            <p className="flex items-center justify-center gap-1.5 py-1.5 text-sm text-foreground-muted">
              <CheckCircle className="h-4 w-4 text-foreground-success" />
              Signed in to {agent.name}
              {probed?.kind === 'authenticated' && probed.account ? ` as ${probed.account}` : ''}
            </p>
          ) : (
            <Button
              variant="outline"
              className="w-full"
              onClick={() =>
                showModal('agentSignInModal', {
                  providerId: agent.id,
                  methodId: loginMethod.id,
                  providerName: agent.name,
                  onSuccess: () => setSignedIn(true),
                })
              }
            >
              Sign in to {agent.name}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * First-run step 1. Nothing in the app does anything without a coding agent, so
 * this is unconditional and blocks until one is installed.
 *
 * Signing in is offered but never required: an agent can equally be
 * authenticated by an API-key environment variable, which we cannot see from
 * here — so an installed agent is the completion bar.
 */
export function AgentStep({ onComplete }: { onComplete: () => void }) {
  const { data: agents, isLoading } = useAgents();
  const visibleAgents = useMemo(() => onboardingAgents(agents, RECOMMENDED_IDS), [agents]);
  const ready = hasInstalledAgent(agents);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-foreground-muted">
        Loading...
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col space-y-8">
      <div className="flex flex-col items-center justify-center gap-6">
        <Bot className="h-10 w-10" absoluteStrokeWidth strokeWidth={1.5} />
        <div className="flex flex-col items-center justify-center gap-2">
          <h1 className="text-center text-xl">Set up your agent</h1>
          <p className="text-md text-center text-foreground-muted">
            {PRODUCT_NAME} runs coding agents for you. Install at least one to continue — you can
            add the rest later in Settings.
          </p>
        </div>
      </div>

      <div className="flex w-full flex-col gap-2">
        {visibleAgents.map((agent) => (
          <AgentSetupRow key={agent.id} agent={agent} />
        ))}
      </div>

      <div className="flex w-full flex-col gap-2">
        <Button size={'lg'} onClick={onComplete} disabled={!ready}>
          Continue
        </Button>
        {ready ? (
          <p className="flex items-center justify-center gap-1.5 text-center text-xs text-foreground-muted">
            <CheckCircle className="h-3.5 w-3.5 text-foreground-success" />
            Sign in above if your agent asks for it — an API key in your environment works too.
          </p>
        ) : (
          <p className="text-center text-xs text-foreground-muted">
            Waiting for an agent to be installed.
          </p>
        )}
      </div>
    </div>
  );
}
