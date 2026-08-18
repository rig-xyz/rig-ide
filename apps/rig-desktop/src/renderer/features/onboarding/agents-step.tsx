import { useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Loader2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { AgentAuthTrailing } from '@renderer/features/agents/agent-auth-trailing';
import { useAgentIdentities, useRunnableAgents } from '@renderer/features/chat/use-runnable-agents';
import { toast } from '@renderer/lib/hooks/use-toast';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';
import { AgentIcon } from '@renderer/lib/ui/agent-icon';
import { Button } from '@renderer/lib/ui/button';
import { RigMark } from '@renderer/lib/ui/rig-mark';
import { cn } from '@renderer/lib/utils';
import { useClipboard } from '@renderer/lib/hooks/use-clipboard';
import type { AgentPayload, InstallMethod, InstallOption } from '@shared/core/agents/agent-payload';
import { RIG_WEBSITE_URL } from '@shared/urls';
import { CATALOG_FOOTNOTE_AGENT_IDS, deriveCatalogFootnote } from './catalog-footnote';
import { hasCliLogin, hasInstalledAgent, onboardingAgents, preferredInstallOptions } from './onboarding-state';

/** Same query key `useRunnableAgents` already reads (`rpc.agents.list()`) — reusing its hook here means the harness picker and this step share one cache entry instead of two independent fetches of the same data. */
const AGENTS_QUERY_KEY = ['rig', 'agents', 'list'];

/** `rpc.agents.install`'s failure union carries a `.message` on most variants (a real command failure) but not all (`unknown-dependency`/`no-install-command`/`not-detected-after-install` only ever carry an `.id`) — read structurally (`unknown` in, so this never fights the union's own type checking) rather than assuming every variant has one, so `toast`'s description degrades to nothing rather than crashing the app it's trying to report an error FROM. */
function installErrorMessage(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return undefined;
}

/**
 * Step 1 — agents, always shown first (round H2's explicit order: "an
 * agent can be dispatched to set up everything else"). Carries the whole
 * brand moment in its own header (the mark + heading) — there's no
 * separate welcome splash to port (see `onboarding.tsx`'s header comment).
 *
 * Found agents → a ready row per installed agent + Continue. None → guided
 * install for claude/codex specifically (`onboardingAgents`'s recommended
 * narrowing) with copyable commands and a real Install button
 * (`rpc.agents.install`, the same call the Settings → Agents page would
 * make — this app already has that main-process machinery, just no
 * onboarding-facing renderer view over it before this). Skip is a real,
 * equally-weighted button next to (disabled) Continue — "visible, not
 * shameful," per the brief.
 */
export function AgentsStep({ onComplete }: { onComplete: () => void }) {
  const queryClient = useQueryClient();
  // D5 fix: `isLoading` gates the "no agents found" guided-install UI below
  // — before this, `data` being `undefined` while the probe was still in
  // flight collapsed to `agents = []`, which reads identically to a
  // genuine "nothing found" and briefly flashed the install cards at
  // someone who actually has agents, every time this step mounts.
  const { data, isLoading: agentsLoading } = useRunnableAgents();
  const agents: AgentPayload[] = data ?? [];
  const ready = hasInstalledAgent(agents);
  const installedAgents = agents.filter((agent) => agent.status === 'available');
  const candidates = onboardingAgents(agents);

  // Catalog-breadth card (Dylan's concern): this step only ever shows a
  // couple of rows, so someone whose harness isn't among them has no signal
  // the ~35-plugin registry covers it too. `identities` is the same instant,
  // unprobed metadata source `useAgentIdentities` already reads elsewhere —
  // its size is the real registry count, not a guess. Gated on there being
  // at least one genuine "other" to name, so the card never flashes "0 more
  // agents" for the instant before the query resolves.
  const identities = useAgentIdentities();
  const showCatalogCard = identities.size > CATALOG_FOOTNOTE_AGENT_IDS.length;

  const [installingId, setInstallingId] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const refetchAgents = () => queryClient.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });

  // C5 fix: both of these used to have no try/catch at all — a genuine
  // rejection (an IPC transport failure, an unexpected main-process
  // exception) skipped straight past the `setInstallingId(null)`/
  // `setChecking(false)` that follows, leaving the button stuck on
  // "Installing…"/"Checking…" forever with no explanation. `finally`
  // guarantees the busy state always clears; the `catch` (and, for
  // install, an in-band `!result.success`) surfaces what actually went
  // wrong instead of silently doing nothing.
  const install = async (id: string, name: string, method: InstallMethod) => {
    setInstallingId(id);
    try {
      const result = await rpc.agents.install(id, undefined, method);
      if (!result.success) {
        toast({
          title: `Couldn't install ${name}`,
          description: installErrorMessage(result.error),
          variant: 'destructive',
        });
        return;
      }
      void refetchAgents();
    } catch (error) {
      toast({
        title: `Couldn't install ${name}`,
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setInstallingId(null);
    }
  };

  const checkAgain = async () => {
    setChecking(true);
    try {
      await rpc.agents.probeAll();
      void refetchAgents();
    } catch (error) {
      toast({
        title: "Couldn't check for agents",
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-6 text-center">
      <button
        type="button"
        onClick={() => confirmOpenExternalLink(RIG_WEBSITE_URL)}
        aria-label="Open userig.xyz"
        className="text-text-primary hover:text-accent focus-visible:outline-accent rounded-control outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <RigMark size={28} />
      </button>
      <div className="flex flex-col gap-1.5">
        <h1 className="font-display text-text-primary text-xl">Set up your agent</h1>
        <p className="text-text-muted max-w-xs text-sm">
          Rig is where humans and agents work together. It works with the agents you already use.
          Sign in and use any agent you want.
        </p>
      </div>

      <div className="flex w-full flex-col gap-1.5 text-left">
        {agentsLoading ? (
          // D5 fix: the honest "still finding out" state — never the
          // install-cards branch, which used to render here for the split
          // second before the probe resolved, even for someone who
          // actually has agents installed.
          <div className="border-border-hairline text-text-muted flex items-center justify-center gap-2 rounded-control border px-3 py-6 text-sm">
            <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
            Checking installed agents…
          </div>
        ) : ready ? (
          installedAgents.map((agent) => (
            <div
              key={agent.id}
              className="border-border-hairline flex min-h-9 items-center gap-2 rounded-control border px-3 py-2"
            >
              <AgentIcon icon={agent.icon} size={16} />
              <span className="text-text-primary min-w-0 flex-1 truncate text-sm">{agent.name}</span>
              <AgentAuthTrailing agent={agent} />
            </div>
          ))
        ) : (
          candidates.map((agent) => (
            <InstallRow
              key={agent.id}
              agent={agent}
              installing={installingId === agent.id}
              onInstall={(method) => void install(agent.id, agent.name, method)}
            />
          ))
        )}

        {showCatalogCard && (
          // D9 fix: borderless, matching the MemberRow/InviteRow list-row convention.
          <div className="flex items-center gap-2.5 px-1 py-2 opacity-70">
            <div className="flex shrink-0 items-center gap-1">
              {CATALOG_FOOTNOTE_AGENT_IDS.map((id) => {
                const icon = identities.get(id)?.icon;
                return icon ? <AgentIcon key={id} icon={icon} size={16} /> : null;
              })}
            </div>
            <span className="text-text-muted text-xs">{deriveCatalogFootnote(identities.size)}</span>
          </div>
        )}
      </div>

      {!agentsLoading && !ready && (
        <Button variant="outline" size="sm" onClick={() => void checkAgain()} disabled={checking}>
          <RefreshCw className={cn('size-3.5', checking && 'animate-spin')} strokeWidth={1.5} />
          {checking ? 'Checking…' : 'Check again'}
        </Button>
      )}

      <div className="flex w-full flex-col items-center gap-3">
        {!agentsLoading && !ready && (
          <p className="text-text-muted text-xs">
            You can read and comment without an agent, and add one anytime.
          </p>
        )}
        <div className="flex w-full gap-2">
          {!agentsLoading && !ready && (
            <Button variant="outline" className="flex-1" onClick={onComplete}>
              Skip for now
            </Button>
          )}
          <Button className="flex-1" onClick={onComplete} disabled={!ready}>
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}

/** One agent's install offer: copyable command(s) + a real Install button, plus a static cli-login note once it's actually installed and re-probed as ready. */
function InstallRow({
  agent,
  installing,
  onInstall,
}: {
  agent: AgentPayload;
  installing: boolean;
  onInstall: (method: InstallMethod) => void;
}) {
  const options = preferredInstallOptions(agent.installOptions);
  if (options.length === 0) {
    // F fix: this used to silently vanish (`return null`) — the agent just
    // disappeared from the candidates list with no explanation. A quiet
    // fallback line at least says why there's nothing to install here.
    return (
      <div className="border-border-hairline flex items-center gap-2 rounded-control border p-3">
        <AgentIcon icon={agent.icon} size={16} />
        <span className="text-text-primary flex-1 text-sm font-medium">{agent.name}</span>
        <span className="text-text-muted text-xs">No install method available</span>
      </div>
    );
  }

  return (
    <div className="border-border-hairline flex flex-col gap-2 rounded-control border p-3">
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
        <p className="text-text-muted text-xs">
          {agent.name} may ask you to sign in the first time you use it.
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
      <code className="text-text-secondary min-w-0 flex-1 truncate font-mono text-xs">
        {option.command}
      </code>
      <button
        type="button"
        onClick={() => clipboard.copy(option.command)}
        // D8 fix (Rule 7): icon-only had no visible word — matches
        // `sign-in-step.tsx`'s `ManualLink` icon+"Copy…" pattern.
        className="text-text-muted hover:text-text-primary flex shrink-0 items-center gap-1 text-xs"
      >
        {clipboard.copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        {clipboard.copied ? 'Copied' : 'Copy'}
      </button>
      <Button size="xs" onClick={onInstall} disabled={installing}>
        {installing ? <Loader2 className="size-3 animate-spin" /> : 'Install'}
      </Button>
    </div>
  );
}
