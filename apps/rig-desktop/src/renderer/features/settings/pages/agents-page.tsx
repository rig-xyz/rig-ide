import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { AgentAuthTrailing } from '@renderer/features/agents/agent-auth-trailing';
import { AgentSignInDialog } from '@renderer/features/agents/agent-sign-in-dialog';
import { useAgentAuthProbe } from '@renderer/features/agents/use-agent-auth-probe';
import { useAgentIdentities, type AgentIdentity } from '@renderer/features/chat/use-runnable-agents';
import { events, rpc } from '@renderer/lib/ipc';
import { AgentIcon } from '@renderer/lib/ui/agent-icon';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/lib/utils';
import type { AgentPayload, DependencyStatus } from '@shared/core/agents/agent-payload';
import { agentUpdateNotice } from '@shared/core/agents/agent-update-notice';
import { agentInstallationStatusUpdatedChannel } from '@shared/events/appEvents';
import { settingsRow } from '../settings-pages';
import { SettingsBlock, SettingsRow, SettingsRows, SettingsSwitch } from '../settings-row';

/** Settings › Agents: the agents on this computer, then whether they ask before acting on comments. */
export function AgentsPage() {
  const list = settingsRow('agents-list')!;
  return (
    <SettingsRows>
      <SettingsBlock id={list.id}>
        <AgentsSection />
      </SettingsBlock>
      <AskBeforeActingRow />
    </SettingsRows>
  );
}

/**
 * The provider's own "Always allow" is session-scoped, and every `@mention`
 * in a comment thread spawns a fresh headless session
 * (`main/rig/comment-agent.ts`), so this is the real, persistent switch.
 * It is `autoApproveAgentActions` shown the other way round: ON here means
 * agents ask (`autoApproveAgentActions === false`, the default). With it
 * off, `comment-agent.ts`'s `publishPermissions` resolves every pending
 * permission request from a comment-thread agent at once, without posting
 * a card (`main/rig/comment-agent-auto-approve.ts`). The permission card's
 * own "Always allow" link (`comments-margin.tsx`) turns asking off; this row
 * is the other way in, and the only way back. Comment text arrives from
 * collaborators and is untrusted input to whatever the agent does with it.
 */
function AskBeforeActingRow() {
  const row = settingsRow('ask-before-acting')!;
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['rig', 'settings', 'autoApproveAgentActions'],
    queryFn: () => rpc.rig.settings.get(),
  });
  const asks = !(data?.autoApproveAgentActions ?? false);

  const toggle = () => {
    // Asking now means auto-approve goes on, and the other way round.
    void rpc.rig.settings.set({ autoApproveAgentActions: asks }).then(() => {
      void queryClient.invalidateQueries({ queryKey: ['rig', 'settings', 'autoApproveAgentActions'] });
    });
  };

  return (
    <SettingsRow
      id={row.id}
      label={row.label}
      description={row.description}
      htmlFor="ask-before-acting"
      control={<SettingsSwitch id="ask-before-acting" label={row.label} checked={asks} onToggle={toggle} />}
    />
  );
}

function agentStatusLabel(status: DependencyStatus | undefined): string {
  if (status === 'available') return 'installed';
  if (status === 'missing') return 'not installed';
  if (status === 'error') return 'error';
  return '';
}

/** One agent identity, paired with whatever `rpc.agents.list()` knows about it (undefined for a catalog entry that hasn't ever been probed). */
type AgentListRow = { id: string; icon: AgentIdentity['icon']; name: string; agent: AgentPayload | undefined };

function AgentRow({ row }: { row: AgentListRow }) {
  // D9 fix: borderless, matching the MemberRow/InviteRow list-row
  // convention (rig-share-button.tsx / invites-bell.tsx) — a per-row card
  // border read as heavier chrome than a plain settings list needs; the
  // list's own `gap-1.5` (in `AgentsSection`) already separates rows.
  return (
    <div className="flex min-h-9 items-center gap-2 px-1 py-1.5">
      <AgentIcon icon={row.icon} size={16} />
      <span className="text-text-primary min-w-0 flex-1 truncate text-sm">{row.name}</span>
      {row.agent?.status === 'available' ? (
        <AgentAuthTrailing agent={row.agent} />
      ) : (
        <span className="text-text-muted shrink-0 font-mono text-xs tracking-wide uppercase">
          {agentStatusLabel(row.agent?.status)}
        </span>
      )}
    </div>
  );
}

/** Settings' own plain, sentence-case status pill — same shape as the "N new" chip `agent-rows.tsx` already uses in the Room panel, never the mono/uppercase label the onboarding-borrowed `AgentAuthTrailing`/`agentStatusLabel` pair renders. */
function Pill({ tone = 'muted', children }: { tone?: 'muted' | 'success' | 'warning'; children: ReactNode }) {
  return (
    <span
      data-testid="agent-status-pill"
      className={cn(
        'bg-bg-2 shrink-0 rounded-chip px-2 py-0.5 text-xs',
        tone === 'success' && 'text-success',
        tone === 'warning' && 'text-danger',
        tone === 'muted' && 'text-text-secondary'
      )}
    >
      {children}
    </span>
  );
}

function notAvailableLabel(status: DependencyStatus | undefined): string {
  if (status === 'missing') return 'Not installed';
  if (status === 'error') return 'Error';
  return 'Checking…';
}

/**
 * Claude/Codex's own trailing pill: same underlying auth state
 * `AgentAuthTrailing` reads (`useAgentAuthProbe`, so the same probe, cache
 * and `AgentSignInDialog` flow — this only changes what it looks like),
 * as a plain "Signed in"/"Sign in" pill instead of that component's mono
 * uppercase "SIGNED IN" text. Kept local to Settings rather than changed
 * in `agent-auth-trailing.tsx` itself, which onboarding's agents-step.tsx
 * also renders and isn't part of this round.
 */
function PrimaryAgentStatus({ agent }: { agent: AgentPayload }) {
  const { loginMethod, state, markSignedIn } = useAgentAuthProbe(agent);
  const [dialogOpen, setDialogOpen] = useState(false);

  if (state.kind === 'noAuthSupport') return <Pill>Installed</Pill>;
  if (state.kind === 'probing') return <Pill>Checking…</Pill>;
  if (state.kind === 'signedIn') return <Pill tone="success">Signed in</Pill>;

  // notSignedIn — loginMethod is guaranteed non-null here (deriveAgentAuthRowState
  // only reaches this branch when one exists), same as AgentAuthTrailing's own.
  return (
    <>
      <button
        type="button"
        onClick={() => setDialogOpen(true)}
        className="bg-accent-subtle text-accent shrink-0 rounded-chip px-2 py-0.5 text-xs transition-opacity hover:opacity-80"
      >
        Sign in
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

/** Rig's own two harnesses — always shown, installed or not, so this reads as "here's what Rig runs" rather than a probe result. */
function PrimaryAgentRow({ row }: { row: AgentListRow }) {
  return (
    <>
      <div className="flex min-h-9 items-center gap-2 px-1 py-1.5" data-testid="primary-agent-row" data-agent-id={row.id}>
        <AgentIcon icon={row.icon} size={16} />
        <span className="text-text-primary min-w-0 flex-1 truncate text-sm">{row.name}</span>
        {row.agent?.status === 'available' ? (
          <PrimaryAgentStatus agent={row.agent} />
        ) : (
          <Pill tone={row.agent?.status === 'error' ? 'warning' : 'muted'}>{notAvailableLabel(row.agent?.status)}</Pill>
        )}
      </div>
      {row.agent?.status === 'available' && <AgentUpdateLine agent={row.agent} />}
    </>
  );
}

/**
 * "Update available" under an agent whose CLI is behind the latest release
 * (an old Codex makes the ChatGPT backend refuse current models). The Update
 * button runs the existing `agents.update` path, and only shows when that
 * path manages the copy in use; otherwise the line says where to update it.
 */
function AgentUpdateLine({ agent }: { agent: AgentPayload }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  const notice = agentUpdateNotice(agent.name, agent);
  if (notice.kind === 'none') return null;

  const update = async () => {
    setState('busy');
    const result = await rpc.agents.update(agent.id).catch(() => null);
    setState(result?.success ? 'idle' : 'failed');
    void queryClient.invalidateQueries({ queryKey: ['rig', 'agents', 'list'] });
  };

  return (
    <div className="flex items-center gap-2 pr-1 pb-1.5 pl-7" data-testid="agent-update-line" data-agent-id={agent.id}>
      <span className="text-text-secondary min-w-0 flex-1 text-xs">
        Update available: {notice.latest}. You have {notice.installed}.
        {notice.kind === 'elsewhere' && ` ${notice.hint}`}
        {state === 'failed' && " The update didn't finish. Try again."}
      </span>
      {notice.kind === 'update' && (
        <Button size="xs" variant="outline" disabled={state === 'busy'} onClick={() => void update()}>
          {state === 'busy' ? 'Updating…' : 'Update'}
        </Button>
      )}
    </div>
  );
}

const PRIMARY_AGENT_IDS = ['claude', 'codex'] as const;

/**
 * Round: the full ~35-agent catalog used to render every entry inline,
 * installed and not, in whatever order `useAgentIdentities()` happened to
 * hold — installed/auth-capable rows (the ones actually worth looking at)
 * got buried under a long tail of "not installed" ones.
 *
 * Settings cleanup round: Claude and Codex — the two harnesses Rig actually
 * runs — are the list now, always shown with their own logos and a plain
 * status pill (`PrimaryAgentRow`), installed or not. Everything else in the
 * catalog collapses behind a quiet "More agents" disclosure (same
 * expand-in-place behavior as the old "+N more available" it replaces,
 * just without the loud mono count) rather than crowding two agents most
 * people never touch above the two that matter.
 */
function AgentsSection() {
  const identities = useAgentIdentities();
  const { data } = useQuery({
    queryKey: ['rig', 'agents', 'list'],
    queryFn: () => rpc.agents.list() as Promise<AgentPayload[]>,
    staleTime: 60_000,
  });
  const [expanded, setExpanded] = useState(false);
  // The latest released version lands after the first snapshot (it's fetched
  // once the probe reports in), and an update changes the installed one.
  const queryClient = useQueryClient();
  useEffect(
    () =>
      events.on(agentInstallationStatusUpdatedChannel, (status) => {
        if ((PRIMARY_AGENT_IDS as readonly string[]).includes(status.id)) {
          void queryClient.invalidateQueries({ queryKey: ['rig', 'agents', 'list'] });
        }
      }),
    [queryClient]
  );
  // Full payloads (not just status) so an installed row can also read
  // `capabilities.auth` for the sign-in trailing content below.
  const agentById = new Map((data ?? []).map((agent) => [agent.id, agent]));

  if (identities.size === 0) {
    return <p className="text-text-muted text-xs">No agents found.</p>;
  }

  const primaryRows: AgentListRow[] = PRIMARY_AGENT_IDS.flatMap((id) => {
    const identity = identities.get(id);
    return identity ? [{ id, icon: identity.icon, name: identity.name, agent: agentById.get(id) }] : [];
  });
  const restRows: AgentListRow[] = [...identities.entries()]
    .filter(([id]) => !(PRIMARY_AGENT_IDS as readonly string[]).includes(id))
    .map(([id, identity]) => ({ id, icon: identity.icon, name: identity.name, agent: agentById.get(id) }));

  return (
    <div className="flex flex-col gap-1.5">
      {primaryRows.map((row) => (
        <PrimaryAgentRow key={row.id} row={row} />
      ))}
      {restRows.length > 0 &&
        (expanded ? (
          <>
            {restRows.map((row) => (
              <AgentRow key={row.id} row={row} />
            ))}
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="text-text-muted hover:text-text-primary self-start px-1 py-1 text-xs transition-colors"
            >
              Show less
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="text-text-muted hover:text-text-primary self-start px-1 py-1 text-xs transition-colors"
          >
            More agents
          </button>
        ))}
    </div>
  );
}
