import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Monitor, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { AgentAuthTrailing } from '@renderer/features/agents/agent-auth-trailing';
import { useAgentIdentities, type AgentIdentity } from '@renderer/features/chat/use-runnable-agents';
import { useRigSignIn } from '@renderer/features/rig-account/use-rig-sign-in';
import { deriveCliVersionRow } from '@renderer/features/shell/cli-versions';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';
import { AgentIcon } from '@renderer/lib/ui/agent-icon';
import { Button } from '@renderer/lib/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@renderer/lib/ui/dialog';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { cn } from '@renderer/lib/utils';
import type { AgentPayload, DependencyStatus } from '@shared/core/agents/agent-payload';
import { PRODUCT_NAME } from '@shared/app-identity';
import { RIG_WEBSITE_URL } from '@shared/urls';

type ThemePreference = 'dark' | 'light' | 'system';

/**
 * Polish round: the Settings modal — a portal-based, design-system dialog
 * (`lib/ui/dialog.tsx`), quiet sections as label+rows rather than an
 * emdash-style settings app with its own nav/tabs. v1 scope, four
 * sections, every row doing real work (see the report for what emdash's
 * own 10-tab settings surface offered that deliberately isn't here):
 *
 * - Appearance: the theme control (now genuinely 3-way — System included).
 * - Account: identity + the sign-in/out flow (same `rpc.rig.auth`/
 *   `rpc.rig.account` calls `UserPill` already makes, same query keys so
 *   the two share a cache).
 * - Agents: installed/status rows, reusing `agents-step.tsx`'s row shape
 *   and the same "instant identities" pattern (`useAgentIdentities`) it
 *   established, so this never flashes icon-less while a probe runs.
 * - About: app version (`rpc.app.getAppVersion`, already existed) + the
 *   userig.xyz link (`confirmOpenExternalLink`, the same confirm-first
 *   pattern onboarding's own agents step already uses for the same URL).
 */
export function SettingsModal({
  open,
  onOpenChange,
  themePreference,
  onSetThemePreference,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  themePreference: ThemePreference;
  onSetThemePreference: (next: ThemePreference) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <div className="flex shrink-0 items-center justify-between px-4 py-3">
          <DialogTitle>Settings</DialogTitle>
          <DialogClose />
        </div>
        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-4 pb-4">
          <Section label="Appearance">
            <AppearanceSection preference={themePreference} onSetPreference={onSetThemePreference} />
          </Section>
          <Section label="Account">
            <AccountSection />
          </Section>
          <Section label="Agents">
            <AgentsSection />
          </Section>
          <Section label="About">
            <AboutSection />
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-text-muted font-mono text-xs tracking-wide uppercase">{label}</p>
      {children}
    </div>
  );
}

const THEME_OPTIONS: { id: ThemePreference; label: string; icon: typeof Monitor }[] = [
  { id: 'system', label: 'System', icon: Monitor },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
];

function AppearanceSection({
  preference,
  onSetPreference,
}: {
  preference: ThemePreference;
  onSetPreference: (next: ThemePreference) => void;
}) {
  return (
    <div className="flex gap-1.5">
      {THEME_OPTIONS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => onSetPreference(id)}
          aria-pressed={preference === id}
          className={cn(
            'border-border-hairline rounded-control flex flex-1 flex-col items-center gap-1.5 border px-2 py-2.5 text-xs transition-colors',
            preference === id
              ? 'bg-bg-2 text-text-primary'
              : 'text-text-muted hover:bg-bg-2 hover:text-text-primary'
          )}
        >
          <Icon className="size-4" strokeWidth={1.5} />
          {label}
        </button>
      ))}
    </div>
  );
}

function AccountSection() {
  const queryClient = useQueryClient();
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);

  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ['rig', 'auth', 'status'],
    queryFn: () => rpc.rig.auth.status(),
  });
  const signedIn = status?.signedIn ?? false;

  const meQuery = useQuery({
    queryKey: ['rig', 'account', 'me'],
    queryFn: () => rpc.rig.account.me(),
    enabled: signedIn,
  });

  const { phase, signIn } = useRigSignIn();

  if (statusLoading) {
    return <p className="text-text-muted text-xs">Loading…</p>;
  }

  if (!signedIn) {
    return (
      <Button size="sm" onClick={() => void signIn()} disabled={phase !== 'idle'}>
        {phase === 'idle' ? 'Sign in to Rig' : 'Waiting for sign-in…'}
      </Button>
    );
  }

  const user = meQuery.data?.success ? meQuery.data.data : null;
  const label = user?.name || user?.email || null;
  const showEmailRow = Boolean(user?.email) && user?.email !== label;

  const doSignOut = async () => {
    const result = await rpc.rig.auth.logout();
    if (!result.success) {
      toast({ title: 'Could not sign out', description: result.error.message, variant: 'destructive' });
      return;
    }
    setConfirmingSignOut(false);
    void queryClient.invalidateQueries({ queryKey: ['rig', 'auth', 'status'] });
    void queryClient.invalidateQueries({ queryKey: ['rig', 'account'] });
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2.5">
        <IdentityAvatar name={label} avatarUrl={user?.avatarUrl ?? null} sizeClassName="size-8" textClassName="text-xs" />
        <div className="min-w-0 flex-1">
          <p className="text-text-primary truncate text-sm font-medium">{label ?? 'Signed in to Rig'}</p>
          {showEmailRow && <p className="text-text-muted truncate text-xs">{user?.email}</p>}
        </div>
      </div>
      {confirmingSignOut ? (
        <div className="flex items-center gap-1.5">
          <p className="text-text-muted flex-1 text-xs">Sign out everywhere on this machine?</p>
          <Button variant="ghost" size="xs" onClick={() => setConfirmingSignOut(false)}>
            Cancel
          </Button>
          <Button variant="destructive" size="xs" onClick={() => void doSignOut()}>
            Sign out
          </Button>
        </div>
      ) : (
        <Button variant="outline" size="sm" className="self-start" onClick={() => setConfirmingSignOut(true)}>
          Sign out
        </Button>
      )}
    </div>
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

/**
 * Round: the full ~35-agent catalog used to render every entry inline,
 * installed and not, in whatever order `useAgentIdentities()` happened to
 * hold — installed/auth-capable rows (the ones actually worth looking at)
 * got buried under a long tail of "not installed" ones. Now: installed
 * agents first (unconditionally shown — this is still where the sign-in
 * rows live), the rest collapsed behind a muted "+N more available"
 * expander, same spirit as onboarding's catalog footnote card but genuinely
 * interactive here (that one's a static count; this expands in place, per
 * the round's own instruction) since this section has the room and the
 * reason to show the full list on request.
 */
function AgentsSection() {
  const identities = useAgentIdentities();
  const { data } = useQuery({
    queryKey: ['rig', 'agents', 'list'],
    queryFn: () => rpc.agents.list() as Promise<AgentPayload[]>,
    staleTime: 60_000,
  });
  const [expanded, setExpanded] = useState(false);
  // Full payloads (not just status) so an installed row can also read
  // `capabilities.auth` for the sign-in trailing content below.
  const agentById = new Map((data ?? []).map((agent) => [agent.id, agent]));

  if (identities.size === 0) {
    return <p className="text-text-muted text-xs">No agents found.</p>;
  }

  const rows: AgentListRow[] = [...identities.entries()].map(([id, identity]) => ({
    id,
    icon: identity.icon,
    name: identity.name,
    agent: agentById.get(id),
  }));
  const installedRows = rows.filter((row) => row.agent?.status === 'available');
  const restRows = rows.filter((row) => row.agent?.status !== 'available');

  return (
    <div className="flex flex-col gap-1.5">
      {installedRows.map((row) => (
        <AgentRow key={row.id} row={row} />
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
            +{restRows.length} more available
          </button>
        ))}
    </div>
  );
}

/**
 * App version + one COMPARISON row each for rig and tapd: bundled vs the
 * user's own PATH install (`rpc.rig.bundledCli.getVersionReport` — manifest
 * read + a cached `--version` probe of the local binary; see
 * `main/rig/bundled-cli.ts`). Dylan's ask: the rows exist to answer "do my
 * bundled and local installations conflict?" — matching versions collapse
 * to one quiet value, a mismatch shows both in the warning tone, and the
 * source the app actually runs (shim-first: bundled wins when present)
 * carries a muted "in use" marker. Rows fill in async; the modal never
 * waits on the probes.
 */
function AboutSection() {
  const { data: appVersion } = useQuery({
    queryKey: ['rig', 'app', 'version'],
    queryFn: () => rpc.app.getAppVersion(),
  });
  const { data: report } = useQuery({
    queryKey: ['rig', 'bundledCli', 'versionReport'],
    queryFn: () => rpc.rig.bundledCli.getVersionReport(),
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-text-secondary text-sm">{PRODUCT_NAME}</p>
        <p className="text-text-muted font-mono text-xs">{appVersion ?? '…'}</p>
      </div>
      <CliVersionLine name="rig" sources={report?.rig} />
      <CliVersionLine name="tapd" sources={report?.tapd} />
      <button
        type="button"
        onClick={() => confirmOpenExternalLink(RIG_WEBSITE_URL)}
        className="text-text-muted hover:text-text-primary flex items-center gap-1 self-start text-xs transition-colors"
      >
        userig.xyz
        <ExternalLink className="size-3" strokeWidth={1.5} />
      </button>
    </div>
  );
}

/**
 * One tool's bundled-vs-local row. The "in use" marker renders only when
 * BOTH installs exist — with a single install it's trivially the one that
 * runs, and the annotation would just repeat the source label.
 *
 * Round: multi-install awareness. Below the comparison value, up to two
 * more quiet mono lines, right-aligned like the row itself: the local
 * install's own resolved path (self-diagnosing a name collision or stale
 * install — never shown for a bundled-only row, which has no local path to
 * name) and, only when the PATH disagrees with itself, the muted
 * "N installs found" note. Neither is a colored rail or a warning — the
 * warning tone stays reserved for the version-conflict label above.
 */
function CliVersionLine({
  name,
  sources,
}: {
  name: string;
  sources:
    | {
        bundled: string | null;
        local: string | null;
        localPath: string | null;
        multipleInstalls: { count: number; usingPath: string } | null;
      }
    | undefined;
}) {
  const row = sources ? deriveCliVersionRow(sources) : null;
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-text-muted text-xs">{name}</p>
      {row === null ? (
        <p className="text-text-muted font-mono text-xs">checking…</p>
      ) : (
        <div className="flex min-w-0 flex-col items-end gap-0.5">
          <p
            className={cn(
              'min-w-0 truncate text-right font-mono text-xs',
              row.tone === 'warning' ? 'text-warning' : 'text-text-muted'
            )}
          >
            {row.label}
            {(row.kind === 'equal' || row.kind === 'conflict') && (
              <span className="text-text-muted"> · in use: {row.inUse}</span>
            )}
          </p>
          {row.localPath && (
            <p className="text-text-muted min-w-0 max-w-full truncate text-right font-mono text-xs">
              {row.localPath}
            </p>
          )}
          {row.multipleInstallsNote && (
            <p className="text-text-muted min-w-0 max-w-full truncate text-right text-xs">
              {row.multipleInstallsNote}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
