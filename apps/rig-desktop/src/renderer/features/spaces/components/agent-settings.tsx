import {
  Check,
  ChevronDown,
  Eye,
  FilePen,
  ListChecks,
  Shield,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { AgentConfig, AgentConfigChange } from '@main/rig/spaces/dispatch';
import { decideModeSelect, isDangerousMode, shouldPersistMode } from '@renderer/features/chat/permission-mode';
import { Popover } from '@renderer/lib/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import type { AgentKind, SessionCard } from '../types';
import { AGENT_NAME } from './identity';

/**
 * Your agent's settings in a space, where you see it work: the model, its
 * permission mode, and how full its context is. The choices come from the
 * agent's own session (the same ones the rig chat's pickers offer) and are
 * only fetched when you open a menu. A change applies from its next turn.
 */

export type AgentSettingsApi = {
  load: (agent: AgentKind) => Promise<AgentConfig | { error: string }>;
  change: (agent: AgentKind, change: AgentConfigChange) => Promise<AgentConfig | { error: string }>;
  /** Makes a pick your default for this agent everywhere (new chats and spaces). */
  remember?: (agent: AgentKind, change: AgentConfigChange) => void;
};

/** An icon per permission mode, so the ladder reads at a glance. Unknown modes get a plain shield. */
const MODE_ICON: Record<string, LucideIcon> = {
  default: ShieldCheck,
  acceptEdits: FilePen,
  plan: ListChecks,
  auto: Sparkles,
  dontAsk: Sparkles,
  'read-only': Eye,
  bypassPermissions: ShieldOff,
  'agent-full-access': ShieldOff,
};

/** A description worth showing: not just the raw model id restated. */
function usefulDescription(description: string | undefined): string | undefined {
  if (!description) return undefined;
  return /\s/.test(description.trim()) ? description : undefined;
}

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
  const [armedId, setArmedId] = useState<string | null>(null);
  const [everywhere, setEverywhere] = useState(false);
  useEffect(() => {
    if (!open) setArmedId(null);
  }, [open]);
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

  const choose = async (value: string) => {
    // Escalating into a mode that acts without asking takes a second click.
    if (dimension === 'mode') {
      const decision = decideModeSelect(value, armedId);
      if (decision.kind === 'confirm') {
        setArmedId(value);
        return;
      }
    }
    setArmedId(null);
    setBusy(true);
    const change = { [dimension]: value };
    const next = await api.change(agent, change);
    setBusy(false);
    if ('error' in next) {
      setError(next.error);
      return;
    }
    // A mode that acts without asking is never made the default.
    if (everywhere && api.remember && (dimension !== 'mode' || shouldPersistMode(value))) api.remember(agent, change);
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
                dimension === 'mode' && 'hover:bg-warning/15 hover:text-warning',
                dimension === 'effort' && 'hover:bg-bg-3'
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
      <Popover
        anchor={ref}
        open={open}
        onClose={() => setOpen(false)}
        align="left"
        minWidth={300}
        estimatedWidth={300}
        role="dialog"
        className="rounded-card overflow-x-hidden py-0"
      >
        <div className="flex w-full flex-col" data-testid={`agent-setting-menu-${dimension}`}>
          <div className="flex items-baseline justify-between px-3 pt-2.5 pb-1">
            <span className="text-xs font-medium text-text-secondary">{DIMENSION_TITLE[dimension]}</span>
            <span className="text-2xs text-text-muted">from the next turn</span>
          </div>
          <div className="flex flex-col px-1 pb-1">
            {busy && !group && <p className="px-2 py-2 text-xs text-text-muted">Loading…</p>}
            {error && <p className="px-2 py-2 text-xs text-danger">{error}</p>}
            {group?.options.map((option) => {
              const selected = option.id === group.selected;
              const Icon = dimension === 'mode' ? (MODE_ICON[option.id] ?? Shield) : null;
              const dangerous = dimension === 'mode' && isDangerousMode(option.id);
              const armed = armedId === option.id;
              const description = armed ? 'Acts without asking. Click again to confirm.' : usefulDescription(option.description);
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void choose(option.id)}
                  title={option.description}
                  className={cn(
                    'flex w-full min-w-0 items-center gap-2.5 rounded-control px-2 py-1.5 text-left transition-colors disabled:opacity-60',
                    armed ? 'bg-warning/10' : 'hover:bg-bg-2'
                  )}
                >
                  {Icon && (
                    <Icon className={cn('size-3.5 shrink-0', dangerous ? 'text-warning' : 'text-text-muted')} strokeWidth={1.5} />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={cn('truncate text-sm', dangerous ? 'text-warning' : 'text-text-primary')}>
                      {option.name}
                    </span>
                    {description && (
                      <span className={cn('truncate text-xs', armed ? 'text-warning' : 'text-text-muted')}>{description}</span>
                    )}
                  </span>
                  <Check className={cn('size-3.5 shrink-0 text-accent', !selected && 'invisible')} strokeWidth={2} />
                </button>
              );
            })}
            {group === null && config && !busy && (
              <p className="px-2 py-2 text-xs text-text-muted">This agent doesn't offer this setting.</p>
            )}
          </div>
          {api.remember && (
            <label className="border-border-hairline flex cursor-pointer items-center gap-2 border-t px-3 py-2 text-xs text-text-secondary hover:text-text-primary">
              <input
                type="checkbox"
                checked={everywhere}
                onChange={(e) => setEverywhere(e.target.checked)}
                className="accent-accent size-3.5 shrink-0"
              />
              Use as my default for {AGENT_NAME[agent]} everywhere
            </label>
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
  prefetch = false,
}: {
  agent: AgentKind;
  /** The model the run reported, shown before the agent's own list is loaded. */
  model: string | null;
  usage?: SessionCard['usage'];
  /** Model only (for the space panel rows). */
  compact?: boolean;
  /** The composer pill's look: plain text, tinted on hover, no context ring. */
  tinted?: boolean;
  /** Fetch the choices right away (you're about to ask this agent); otherwise on first hover. */
  prefetch?: boolean;
}) {
  const api = useContext(AgentSettingsContext);
  const [config, setConfig] = useState<AgentConfig | null>(null);
  // The choices are fetched once per agent and shared (the Room caches
  // them), so menus open with their options already there.
  const warm = () => {
    if (!api || config) return;
    void api.load(agent).then((loaded) => {
      if (!('error' in loaded)) setConfig(loaded);
    });
  };
  useEffect(() => {
    if (prefetch) warm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefetch, agent, api]);
  if (!api) return usage ? <ContextRing usage={usage} /> : null;
  const nameOf = (dimension: Dimension, fallback: string) => {
    const group = config?.[dimension];
    return group?.options.find((o) => o.id === group.selected)?.name ?? fallback;
  };
  return (
    <span className="flex items-center gap-0.5" data-testid="agent-settings" onMouseEnter={warm} onFocus={warm}>
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
        <SettingPill
          agent={agent}
          dimension="effort"
          label={nameOf('effort', 'Effort')}
          config={config}
          setConfig={setConfig}
          tinted={tinted}
        />
      )}
      {!compact && !tinted && usage && <ContextRing usage={usage} />}
    </span>
  );
}
