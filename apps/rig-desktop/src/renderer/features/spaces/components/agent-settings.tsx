import { Check, ChevronDown } from 'lucide-react';
import { createContext, useContext, useRef, useState } from 'react';
import type { AgentConfig, AgentConfigChange } from '@main/rig/spaces/dispatch';
import { Popover } from '@renderer/lib/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import type { AgentKind, SessionCard } from '../types';

/**
 * Your agent's settings in a space, where you see it work: the model, its
 * permission mode, and how full its context is. The choices come from the
 * agent's own session (the same ones the rig chat's pickers offer) and are
 * only fetched when you open a menu. A change applies from its next turn.
 */

export type AgentSettingsApi = {
  load: (agent: AgentKind) => Promise<AgentConfig | { error: string }>;
  change: (agent: AgentKind, change: AgentConfigChange) => Promise<AgentConfig | { error: string }>;
};

/** Provided by the Room (it knows the space and can reach the app); absent in the scripted demo. */
export const AgentSettingsContext = createContext<AgentSettingsApi | null>(null);

type Dimension = 'model' | 'mode' | 'effort';

const DIMENSION_TITLE: Record<Dimension, string> = {
  model: 'Model',
  mode: 'Permissions',
  effort: 'Effort',
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** How full the context window is, as a small ring; details on hover. */
export function ContextRing({ usage }: { usage: NonNullable<SessionCard['usage']> }) {
  const fraction = Math.min(1, usage.used / usage.size);
  const r = 5.5;
  const circumference = 2 * Math.PI * r;
  const high = fraction > 0.85;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="flex size-6 items-center justify-center" aria-label={`Context ${Math.round(fraction * 100)}% used`}>
            <svg viewBox="0 0 14 14" className="size-3.5 -rotate-90">
              <circle cx="7" cy="7" r={r} fill="none" strokeWidth="2" className="stroke-bg-3" />
              <circle
                cx="7"
                cy="7"
                r={r}
                fill="none"
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray={`${fraction * circumference} ${circumference}`}
                className={high ? 'stroke-danger' : 'stroke-text-muted'}
              />
            </svg>
          </span>
        }
      />
      <TooltipContent side="bottom">
        Context {formatTokens(usage.used)} of {formatTokens(usage.size)} ({Math.round(fraction * 100)}%)
        {usage.costUsd !== null && ` · $${usage.costUsd.toFixed(2)} this turn`}
        {high && ' · Claude will compact soon'}
      </TooltipContent>
    </Tooltip>
  );
}

function SettingPill({
  agent,
  dimension,
  label,
  config,
  setConfig,
  tinted = false,
}: {
  agent: AgentKind;
  dimension: Dimension;
  label: string;
  config: AgentConfig | null;
  setConfig: (config: AgentConfig) => void;
  /** Plain text at rest, each setting its own tint on hover (inside the composer's pill). */
  tinted?: boolean;
}) {
  const api = useContext(AgentSettingsContext);
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!api) return null;

  const openMenu = async () => {
    setOpen(true);
    setError(null);
    if (config) return;
    setBusy(true);
    const loaded = await api.load(agent);
    setBusy(false);
    if ('error' in loaded) setError(loaded.error);
    else setConfig(loaded);
  };

  const pick = async (value: string) => {
    setBusy(true);
    const next = await api.change(agent, { [dimension]: value });
    setBusy(false);
    if ('error' in next) {
      setError(next.error);
      return;
    }
    setConfig(next);
    setOpen(false);
  };

  const group = config?.[dimension] ?? null;
  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={() => void openMenu()}
        aria-haspopup="menu"
        aria-expanded={open}
        title={DIMENSION_TITLE[dimension]}
        className={cn(
          'group/setting flex h-6 max-w-40 items-center gap-1 rounded-chip px-2 text-xs transition-colors',
          tinted
            ? cn(
                'text-text-primary',
                dimension === 'model' && 'hover:bg-accent/15 hover:text-accent',
                dimension !== 'model' && 'hover:bg-warning/15 hover:text-warning'
              )
            : 'hover:bg-bg-2 text-text-muted hover:text-text-primary'
        )}
        data-testid={`agent-setting-${dimension}`}
      >
        <span className="truncate">{label}</span>
        <ChevronDown
          className={cn('size-3 shrink-0', tinted && 'opacity-40 transition-opacity group-hover/setting:opacity-100')}
          strokeWidth={1.5}
        />
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} align="right" minWidth={240} role="dialog">
        <div className="flex max-w-80 flex-col p-1" data-testid={`agent-setting-menu-${dimension}`}>
          <p className="px-2 pt-1 pb-1.5 text-2xs text-text-muted">
            {DIMENSION_TITLE[dimension]} · applies from the next turn
          </p>
          {busy && !group && <p className="px-2 py-1.5 text-xs text-text-muted">Loading…</p>}
          {error && <p className="px-2 py-1.5 text-xs text-danger">{error}</p>}
          {group?.options.map((option) => {
            const selected = option.id === group.selected;
            return (
              <button
                key={option.id}
                type="button"
                disabled={busy}
                onClick={() => void pick(option.id)}
                className="hover:bg-bg-2 flex w-full items-start gap-2 rounded-control px-2 py-1.5 text-left transition-colors disabled:opacity-60"
              >
                <Check className={cn('mt-0.5 size-3.5 shrink-0', selected ? 'text-accent' : 'invisible')} strokeWidth={1.5} />
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm text-text-primary">{option.name}</span>
                  {option.description && <span className="text-xs text-text-muted">{option.description}</span>}
                </span>
              </button>
            );
          })}
          {group === null && config && !busy && (
            <p className="px-2 py-1.5 text-xs text-text-muted">This agent doesn't offer this setting.</p>
          )}
        </div>
      </Popover>
    </>
  );
}

/**
 * The pills: model and permissions (plus effort when the agent has one),
 * then the context ring. Before the menus are opened they show what the
 * run itself reported (its model); after, the agent's own names.
 */
export function AgentSettings({
  agent,
  model,
  usage,
  compact = false,
  tinted = false,
}: {
  agent: AgentKind;
  /** The model the run reported, shown before the agent's own list is loaded. */
  model: string | null;
  usage?: SessionCard['usage'];
  /** Model only (for the space panel rows). */
  compact?: boolean;
  /** The composer pill's look: plain text, tinted on hover, no context ring. */
  tinted?: boolean;
}) {
  const api = useContext(AgentSettingsContext);
  const [config, setConfig] = useState<AgentConfig | null>(null);
  if (!api) return usage ? <ContextRing usage={usage} /> : null;
  const nameOf = (dimension: Dimension, fallback: string) => {
    const group = config?.[dimension];
    return group?.options.find((o) => o.id === group.selected)?.name ?? fallback;
  };
  return (
    <span className="flex items-center gap-0.5" data-testid="agent-settings">
      <SettingPill
        agent={agent}
        dimension="model"
        label={nameOf('model', model ?? 'Model')}
        config={config}
        setConfig={setConfig}
        tinted={tinted}
      />
      {!compact && (
        <SettingPill
          agent={agent}
          dimension="mode"
          label={nameOf('mode', 'Permissions')}
          config={config}
          setConfig={setConfig}
          tinted={tinted}
        />
      )}
      {!compact && config?.effort && (
        <SettingPill agent={agent} dimension="effort" label={nameOf('effort', 'Effort')} config={config} setConfig={setConfig} />
      )}
      {!compact && !tinted && usage && <ContextRing usage={usage} />}
    </span>
  );
}
