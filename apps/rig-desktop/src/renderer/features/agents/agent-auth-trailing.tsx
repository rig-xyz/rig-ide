import { CheckCircle, LogIn } from 'lucide-react';
import { useState } from 'react';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import { AgentSignInDialog } from './agent-sign-in-dialog';
import { useAgentAuthProbe } from './use-agent-auth-probe';

/**
 * The trailing (right-aligned) content for one INSTALLED agent's row —
 * shared by `agents-step.tsx`'s ready-agent list and `settings-modal.tsx`'s
 * `AgentsSection`, the two places an installed row already renders. Callers
 * keep their own outer row markup (icon + name) untouched; this only
 * replaces the static "installed" label with the honest three-state auth
 * block for agents that actually support CLI sign-in.
 *
 * `noAuthSupport` renders the exact same "installed" label both call sites
 * already showed — an agent with no auth capability (or an API-key-only
 * one) gets no fake auth state, per the round's own instruction.
 *
 * Correction round (Dylan's screenshot): the signed-in block used to put
 * the check icon on its own line, vertically centered against a TWO-line
 * badge+email stack — on a narrow row this could visibly separate the icon
 * from "signed in" and misalign the email. Now the icon and "signed in"
 * share ONE line (badge line), with the email as its own second muted line
 * directly under it — one right-aligned column, `shrink-0` so the agent
 * name (which truncates instead) is what gives way on a tight row, not
 * this block wrapping.
 */
export function AgentAuthTrailing({ agent }: { agent: AgentPayload }) {
  const { loginMethod, state, markSignedIn } = useAgentAuthProbe(agent);
  const [dialogOpen, setDialogOpen] = useState(false);

  if (state.kind === 'noAuthSupport') {
    return (
      <span className="text-text-muted shrink-0 font-mono text-xs tracking-wide uppercase">installed</span>
    );
  }

  if (state.kind === 'probing') {
    return (
      <span className="text-text-muted shrink-0 font-mono text-xs tracking-wide uppercase">checking…</span>
    );
  }

  if (state.kind === 'signedIn') {
    return (
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        <span className="text-text-muted flex items-center gap-1 font-mono text-xs tracking-wide uppercase">
          <CheckCircle className="text-success size-3 shrink-0" strokeWidth={1.5} />
          signed in
        </span>
        {state.account && (
          <span className="text-text-muted max-w-32 truncate font-mono text-xs normal-case">
            {state.account}
          </span>
        )}
      </span>
    );
  }

  // notSignedIn — loginMethod is guaranteed non-null here (deriveAgentAuthRowState
  // only reaches this branch when one exists).
  return (
    <>
      <button
        type="button"
        onClick={() => setDialogOpen(true)}
        className="text-accent flex shrink-0 items-center gap-1 text-xs transition-opacity hover:opacity-80"
      >
        <LogIn className="size-3" strokeWidth={1.5} />
        Sign in to {agent.name}
      </button>
      {loginMethod && (
        <AgentSignInDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          providerId={agent.id}
          methodId={loginMethod.id}
          providerName={agent.name}
          onSuccess={() => {
            markSignedIn();
            setDialogOpen(false);
          }}
        />
      )}
    </>
  );
}
