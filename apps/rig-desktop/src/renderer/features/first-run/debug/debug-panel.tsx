import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bug, ChevronDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { cn } from '@renderer/lib/utils';
import type { FirstRunStepId } from '@shared/rig/first-run';
import type { FirstRunPlan } from '../first-run-state';
import {
  AGENT_STATES,
  FIRST_RUN_CASES,
  nextConnectorState,
  SIM_TOOLS,
  RIG_STATES,
  replayFirstRun,
  stopSimulating,
  type FirstRunSimulation,
} from './first-run-debug';

/**
 * The debug harness inside the first run: every kind of arrival and every
 * Set up state one click away, simulated. "Real" goes back to what this Mac
 * actually has. Shown in dev builds and with Settings › Advanced › Debug mode.
 */
export function FirstRunDebugPanel({
  step,
  plan,
  simulation,
  real,
}: {
  step: FirstRunStepId;
  plan: FirstRunPlan | null;
  /** What the flow sees now: the harness's, or the one a replay with Rig Alpha off gets. */
  simulation: FirstRunSimulation | null;
  /** "Real" is offered: with Rig Alpha off, a replay only simulates. */
  real: boolean;
}) {
  const [open, setOpen] = useState(true);
  const base: FirstRunSimulation = simulation ?? FIRST_RUN_CASES[0]!.simulation;
  const setUp = (patch: Partial<FirstRunSimulation>) =>
    void replayFirstRun({ ...base, ...patch }, 'setup');
  const caseId = simulation
    ? FIRST_RUN_CASES.find(
        (c) =>
          c.simulation.rig === simulation.rig &&
          c.simulation.agent === simulation.agent &&
          c.simulation.user === simulation.user
      )?.id
    : undefined;

  return (
    <div
      className="absolute right-3 bottom-3 z-30 w-[300px] rounded-card border border-border-hairline bg-bg-1 text-xs shadow-float [-webkit-app-region:no-drag]"
      data-testid="first-run-debug"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="first-run-debug-toggle"
        className="flex w-full items-center gap-2 px-3 py-2 text-text-secondary"
      >
        <Bug className="size-3.5" strokeWidth={1.8} />
        <span className="font-medium text-text-primary">First run</span>
        <span className="truncate text-text-muted">
          {simulation ? 'simulated' : 'real'} · {step}
          {plan ? ` · ${plan.returning ? 'returning' : 'new'}` : ''}
        </span>
        <ChevronDown
          className={cn('ml-auto size-3.5 transition-transform', !open && '-rotate-90')}
        />
      </button>
      {open && (
        <div className="flex flex-col gap-2.5 border-t border-border-hairline px-3 pt-2.5 pb-3">
          <Group label="Arrive as">
            {FIRST_RUN_CASES.map((c) => (
              <Chip
                key={c.id}
                on={caseId === c.id}
                onClick={() => void replayFirstRun(c.simulation)}
                testId={`first-run-debug-case-${c.id}`}
              >
                {c.label}
              </Chip>
            ))}
          </Group>
          <Group label="Rig">
            {RIG_STATES.map((s) => (
              <Chip
                key={s.id}
                on={simulation?.rig === s.id}
                onClick={() => setUp({ rig: s.id })}
                testId={`first-run-debug-rig-${s.id}`}
              >
                {s.label}
              </Chip>
            ))}
          </Group>
          <Group label="Agent">
            {AGENT_STATES.map((s) => (
              <Chip
                key={s.id}
                on={simulation?.agent === s.id}
                onClick={() => setUp({ agent: s.id })}
                testId={`first-run-debug-agent-${s.id}`}
              >
                {s.label}
              </Chip>
            ))}
          </Group>
          <Group label="User">
            {(['new', 'existing'] as const).map((user) => (
              <Chip
                key={user}
                on={simulation?.user === user}
                onClick={() => void replayFirstRun({ ...base, user })}
                testId={`first-run-debug-user-${user}`}
              >
                {user === 'new' ? 'New' : 'Existing'}
              </Chip>
            ))}
          </Group>
          <Group label="Connectors">
            {SIM_TOOLS.map(({ connector }) => {
              const state = base.connectors[connector];
              return (
                <Chip
                  key={connector}
                  on={simulation !== null && state !== undefined}
                  onClick={() =>
                    void replayFirstRun(
                      { ...base, connectors: nextConnectorState(base.connectors, connector) },
                      'connect'
                    )
                  }
                  testId={`first-run-debug-connector-${connector}`}
                >
                  {connector}
                  {state === 'needs_auth' ? ' · re-auth' : ''}
                </Chip>
              );
            })}
            <Chip
              onClick={() => void replayFirstRun({ ...base, connectors: {} }, 'connect')}
              testId="first-run-debug-connectors-none"
            >
              none
            </Chip>
          </Group>
          <div className="flex gap-1.5 pt-0.5">
            {real && (
              <Chip on={!simulation} onClick={stopSimulating} testId="first-run-debug-real">
                Real
              </Chip>
            )}
            <Chip onClick={() => void replayFirstRun(simulation)} testId="first-run-debug-replay">
              Replay
            </Chip>
          </div>
          <LocalSignIn />
        </div>
      )}
    </div>
  );
}

const LAST_DEV_USER = 'rig.firstRun.devUser';

/**
 * Dev builds against a local relay only (main refuses anything else): sign
 * this profile in as one of the local database's people, in one click, so
 * nobody mints tokens by hand.
 */
function LocalSignIn() {
  const queryClient = useQueryClient();
  const available = useQuery({ queryKey: ['rig', 'dev', 'available'], queryFn: () => rpc.rig.dev.available() });
  const relay = available.data?.success ? available.data.data.relay : null;
  const users = useQuery({
    queryKey: ['rig', 'dev', 'users'],
    queryFn: () => rpc.rig.dev.users(),
    enabled: relay !== null,
  });
  const [picked, setPicked] = useState<string | null>(() => {
    try {
      return localStorage.getItem(LAST_DEV_USER);
    } catch {
      return null;
    }
  });
  const [said, setSaid] = useState<string | null>(null);
  if (relay === null) return null;
  const list = users.data?.success ? users.data.data : [];
  const userId = picked && list.some((u) => u.id === picked) ? picked : (list[0]?.id ?? '');

  const signIn = async () => {
    setSaid('Signing in…');
    const r = await rpc.rig.dev.signIn({ userId }).catch(() => null);
    if (!r?.success) {
      setSaid(r ? r.error.message : "Couldn't sign in.");
      return;
    }
    try {
      localStorage.setItem(LAST_DEV_USER, userId);
    } catch {
      // Remembering the pick is a convenience.
    }
    setSaid(`Signed in as ${list.find((u) => u.id === userId)?.label ?? userId}.`);
    // Everything Rig shows is someone else's now: ask it all again.
    void queryClient.invalidateQueries({ queryKey: ['rig'] });
  };

  return (
    <Group label={`Local relay · ${relay.replace(/^https?:\/\//, '')}`}>
      {users.data && !users.data.success ? (
        <span className="text-text-muted">{users.data.error.message}</span>
      ) : (
        <div className="flex w-full items-center gap-1.5">
          <select
            className="min-w-0 flex-1 rounded-chip border border-border-hairline bg-bg-1 px-1.5 py-0.5 text-text-secondary"
            value={userId}
            onChange={(e) => setPicked(e.target.value)}
            aria-label="Local user"
          >
            {list.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label} · {u.id}
              </option>
            ))}
          </select>
          <Chip onClick={() => void signIn()} testId="first-run-debug-local-sign-in">
            Sign in to local relay
          </Chip>
        </div>
      )}
      {said && <span className="w-full text-text-muted">{said}</span>}
    </Group>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-2xs tracking-[0.08em] text-text-muted uppercase">
        {label}
      </span>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  );
}

function Chip({
  on,
  onClick,
  testId,
  children,
}: {
  on?: boolean;
  onClick: () => void;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-pressed={on}
      className={cn(
        'rounded-chip border px-2 py-0.5 transition-colors',
        on
          ? 'border-accent text-accent bg-accent-subtle'
          : 'border-border-hairline text-text-secondary hover:text-text-primary hover:border-border-strong'
      )}
    >
      {children}
    </button>
  );
}
