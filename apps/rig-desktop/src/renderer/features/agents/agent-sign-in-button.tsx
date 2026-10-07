import { useState } from 'react';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import type { CliLoginMethod } from './agent-auth-state';
import { AgentSignInDialog } from './agent-sign-in-dialog';

/**
 * A "Sign in" button that opens the same `AgentSignInDialog` onboarding and
 * Settings use, for the persistent needs-sign-in warnings on Home and in the
 * space panel (`useAgentSignInNeeded`). Callers style the button to fit.
 */
export function AgentSignInButton({
  agent,
  loginMethod,
  onSignedIn,
  className,
}: {
  agent: AgentPayload;
  loginMethod: CliLoginMethod;
  onSignedIn: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className} data-testid="agent-sign-in-button">
        Sign in
      </button>
      <AgentSignInDialog
        open={open}
        onOpenChange={setOpen}
        providerId={agent.id}
        methodId={loginMethod.id}
        providerName={agent.name}
        onSuccess={() => {
          onSignedIn();
          setOpen(false);
        }}
      />
    </>
  );
}
