import { Bug, ChevronDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cn } from '@renderer/lib/utils';
import type { FirstRunStepId } from '@shared/rig/first-run';
import { FIRST_RUN_CONNECTORS } from '../env';
import type { FirstRunPlan } from '../first-run-state';
import {
  AGENT_STATES,
  FIRST_RUN_CASES,
  RIG_STATES,
  replayFirstRun,
  stopSimulating,
  useFirstRunDebug,
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
}: {
  step: FirstRunStepId;
  plan: FirstRunPlan | null;
}) {
  const { simulation } = useFirstRunDebug();
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
            {FIRST_RUN_CONNECTORS.map((connector) => {
              const on = base.connectors.includes(connector);
              return (
                <Chip
                  key={connector}
                  on={simulation !== null && on}
                  onClick={() =>
                    void replayFirstRun(
                      {
                        ...base,
                        connectors: on
                          ? base.connectors.filter((c) => c !== connector)
                          : [...base.connectors, connector],
                      },
                      step
                    )
                  }
                >
                  {connector}
                </Chip>
              );
            })}
          </Group>
          <div className="flex gap-1.5 pt-0.5">
            <Chip on={!simulation} onClick={stopSimulating} testId="first-run-debug-real">
              Real
            </Chip>
            <Chip onClick={() => void replayFirstRun(simulation)} testId="first-run-debug-replay">
              Replay
            </Chip>
          </div>
        </div>
      )}
    </div>
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
