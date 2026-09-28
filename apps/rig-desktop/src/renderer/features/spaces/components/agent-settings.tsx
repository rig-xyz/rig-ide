import { ChevronDown } from 'lucide-react';
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react';
import type { AgentConfig, AgentConfigChange, AgentConfigChoice } from '@main/rig/spaces/dispatch';
import { decideModeSelect, isDangerousMode, shouldPersistMode } from '@renderer/features/chat/permission-mode';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { ROOM_SEES_LABEL, ROOM_SEES_LEVELS, ROOM_SEES_TOOLTIP, type RoomSees } from '@shared/spaces/room-sees';
import type { AgentKind, SessionCard } from '../types';
import { AGENT_NAME } from './identity';

/**
 * Your agent's settings in a space: its model, its permission mode, its
 * effort, and how full its context is. No menus or cards: every setting is
 * a short line of pills, the current one filled, that opens in place (in
 * the space panel, your agent's row expands; in the composer's pill, the
 * setting you click turns into its choices). Descriptions are tooltips. The
 * choices come from the agent's own session (the same ones the rig chat's
 * pickers offer); a pick applies from its next turn.
 */

export type AgentSettingsApi = {
  load: (agent: AgentKind) => Promise<AgentConfig | { error: string }>;
  change: (agent: AgentKind, change: AgentConfigChange) => Promise<AgentConfig | { error: string }>;
  /** Makes a pick your default for this agent everywhere (new chats and spaces). */
  remember?: (agent: AgentKind, change: AgentConfigChange) => void;
  /** Calls back with the agent's new settings when they change from elsewhere (its own `rig_update_settings`). */
  watch?: (agent: AgentKind, onChange: (config: AgentConfig) => void) => () => void;
  /** "Room sees" in this space: how much of your agents' work other members see. Kept on this computer. */
  roomSees?: {
    load: () => Promise<RoomSees>;
    change: (level: RoomSees) => Promise<boolean>;
    /** Calls back with the level whenever the saved settings change (the pill, or your agent's `rig_update_settings`). */
    watch?: (onChange: (level: RoomSees) => void) => () => void;
  };
};

/** Provided by the Room (it knows the space and can reach the app); absent in the scripted demo. */
export const AgentSettingsContext = createContext<AgentSettingsApi | null>(null);

type Dimension = 'model' | 'mode' | 'effort';
/** A row of choices: one of the agent's own settings, or the space's "Room sees". */
type ChoiceDimension = Dimension | 'roomSees';
type Option = { id: string; name: string; description?: string };

const DIMENSION_TITLE: Record<ChoiceDimension, string> = {
  model: 'Model',
  mode: 'Permissions',
  effort: 'Effort',
  roomSees: 'Chat sees',
};

/** "Room sees" as a row of choices; the one description is every choice's tooltip. */
function roomSeesChoice(level: RoomSees): AgentConfigChoice {
  return {
    selected: level,
    options: ROOM_SEES_LEVELS.map((id) => ({ id, name: ROOM_SEES_LABEL[id], description: ROOM_SEES_TOOLTIP })),
  };
}

function isDefaultOption(dimension: ChoiceDimension, option: Option): boolean {
  return dimension === 'model' && (option.id === 'default' || /^default\b/i.test(option.name));
}

/**
 * What an option is called. The adapter's "Default (recommended)" model is
 * named by what it resolves to ("Opus 4.7 (1M)", from its own description),
 * so the pill and the list say the model, not the policy.
 */
export function optionLabel(dimension: ChoiceDimension, option: Option): string {
  if (isDefaultOption(dimension, option)) {
    const resolved = option.description
      ?.split(' · ')[0]
      ?.replace(/\s+with 1M context$/i, ' (1M)')
      .trim();
    return resolved || 'Default';
  }
  return option.name;
}

/** "claude-opus-4-7" → "Opus 4.7", "claude-fable-5-1[1m]" → "Fable 5.1 (1M)"; other ids as they are. */
export function prettyModelId(id: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(\[1m\])?$/i.exec(id);
  if (!match) return id;
  const [, family, major, minor, oneM] = match;
  const name = `${family!.charAt(0).toUpperCase()}${family!.slice(1)} ${major}${minor ? `.${minor}` : ''}`;
  return oneM ? `${name} (1M)` : name;
}

/**
 * The option a setting is on. The agent can be set to a model it no longer
 * lists (a remembered default from an older CLI): that still shows, by its
 * readable name, marked as no longer offered, rather than as nothing.
 */
function currentOption(dimension: ChoiceDimension, group: AgentConfigChoice): (Option & { stale?: boolean }) | null {
  if (!group.selected) return null;
  const listed = group.options.find((o) => o.id === group.selected);
  if (listed) return listed;
  return {
    id: group.selected,
    name: dimension === 'model' ? prettyModelId(group.selected) : group.selected,
    description: 'No longer offered by this agent; pick another to switch.',
    stale: true,
  };
}

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
          <span className="flex size-5 items-center justify-center" aria-label={`Context ${Math.round(fraction * 100)}% used`}>
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

/**
 * A setting's choices as one line of small pills (scrolls sideways if it
 * must), the current one filled. A permission mode that acts without asking
 * takes a second click: the first turns its pill into "Confirm?".
 */
function ChoiceChips({
  dimension,
  group,
  busy,
  onPick,
  revealOnHover = false,
}: {
  dimension: ChoiceDimension;
  group: AgentConfigChoice;
  busy: boolean;
  onPick: (value: string) => void;
  /** Show only the current pick; hovering (or focusing) slides the other choices out to its right. */
  revealOnHover?: boolean;
}) {
  const [armedId, setArmedId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(!revealOnHover);
  const leaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (leaveRef.current) clearTimeout(leaveRef.current);
  }, []);
  const show = () => {
    if (leaveRef.current) clearTimeout(leaveRef.current);
    setRevealed(true);
  };
  const hide = () => {
    if (!revealOnHover) return;
    if (leaveRef.current) clearTimeout(leaveRef.current);
    // Forgiving: a short grace before folding. Leaving also cancels a pending confirm.
    leaveRef.current = setTimeout(() => {
      setArmedId(null);
      setRevealed(false);
    }, 280);
  };

  const chip = (option: Option & { stale?: boolean }) => {
    const selected = option.id === group.selected;
    const dangerous = dimension === 'mode' && isDangerousMode(option.id);
    const armed = armedId === option.id;
    return (
      <button
        key={option.id}
        type="button"
        role="radio"
        aria-checked={selected}
        disabled={busy}
        title={option.description}
        onClick={() => {
          // Re-picking the current choice just folds the inline choices (composer); in the panel it's a no-op.
          if (selected) {
            if (!revealOnHover) onPick(option.id);
            return;
          }
          if (dimension === 'mode' && decideModeSelect(option.id, armedId).kind === 'confirm') {
            setArmedId(option.id);
            return;
          }
          setArmedId(null);
          onPick(option.id);
        }}
        className={cn(
          'h-6 shrink-0 rounded-full px-2.5 text-xs whitespace-nowrap transition-colors disabled:opacity-60',
          selected
            ? 'bg-text-primary/[0.1] text-text-primary'
            : dangerous
              ? 'text-warning hover:bg-warning/10'
              : 'text-text-muted hover:bg-text-primary/[0.06] hover:text-text-primary',
          armed && 'bg-warning/15 text-warning',
          'stale' in option && option.stale && 'italic'
        )}
      >
        {armed ? 'Confirm?' : optionLabel(dimension, option)}
      </button>
    );
  };
  const current = currentOption(dimension, group);
  const others = group.options.filter((o) => o.id !== group.selected);

  if (!revealOnHover) {
    return (
      <span
        className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
        role="radiogroup"
        aria-label={DIMENSION_TITLE[dimension]}
        data-testid={`agent-choices-${dimension}`}
      >
        {current?.stale && chip(current)}
        {group.options.map(chip)}
      </span>
    );
  }
  // The current pick first; the rest slide out to its right on hover.
  return (
    <span
      className="flex min-w-0 items-center gap-1"
      role="radiogroup"
      aria-label={DIMENSION_TITLE[dimension]}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hide();
      }}
      data-testid={`agent-choices-${dimension}`}
      data-revealed={revealed || armedId !== null}
    >
      {current && chip(current)}
      <span
        className={cn(
          'flex min-w-0 items-center gap-1 overflow-x-auto transition-[max-width,opacity] duration-300 ease-out [scrollbar-width:none] motion-reduce:transition-none',
          revealed || armedId !== null ? 'max-w-[40rem] opacity-100' : 'pointer-events-none max-w-0 opacity-0'
        )}
      >
        {others.map(chip)}
      </span>
    </span>
  );
}

/** Loads (once, via the Room's cache) and changes one agent's settings. */
function useAgentConfig(agent: AgentKind) {
  const api = useContext(AgentSettingsContext);
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => api?.watch?.(agent, setConfig), [api, agent]);
  const warm = () => {
    if (!api || config) return;
    void api.load(agent).then((loaded) => {
      if ('error' in loaded) setError(loaded.error);
      else {
        setError(null);
        setConfig(loaded);
      }
    });
  };
  const pick = async (dimension: Dimension, value: string, everywhere = false): Promise<boolean> => {
    if (!api) return false;
    setBusy(true);
    const change = { [dimension]: value };
    const next = await api.change(agent, change);
    setBusy(false);
    if ('error' in next) {
      setError(next.error);
      return false;
    }
    // A mode that acts without asking is never made the default.
    if (everywhere && api.remember && (dimension !== 'mode' || shouldPersistMode(value))) api.remember(agent, change);
    setConfig(next);
    return true;
  };
  const label = (dimension: Dimension): string | null => {
    const group = config?.[dimension];
    const option = group ? currentOption(dimension, group) : null;
    return option ? optionLabel(dimension, option) : null;
  };
  const retry = () => {
    setError(null);
    setConfig(null);
    if (!api) return;
    void api.load(agent).then((loaded) => {
      if ('error' in loaded) setError(loaded.error);
      else setConfig(loaded);
    });
  };
  return { api, config, error, busy, warm, pick, label, retry };
}

/**
 * The model / permissions / effort inside the composer's agent pill. Each is
 * plain text with a faint chevron (tinted on hover); clicking one turns that
 * spot into its choices, in the pill, and a pick folds it back.
 */
export function AgentSettings({
  agent,
  model,
  prefetch = false,
}: {
  agent: AgentKind;
  /** The model the run reported, shown before the agent's own list is loaded. */
  model: string | null;
  /** Fetch the choices right away (you're about to ask this agent). */
  prefetch?: boolean;
}) {
  const { api, config, busy, warm, pick, label } = useAgentConfig(agent);
  const [openDim, setOpenDim] = useState<Dimension | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (prefetch) warm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefetch, agent, api]);
  // Clicking anywhere else, or Esc, folds the choices back.
  useEffect(() => {
    if (!openDim) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpenDim(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenDim(null);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [openDim]);
  if (!api) return null;

  const tint: Record<Dimension, string> = {
    model: 'hover:bg-accent/15 hover:text-accent',
    mode: 'hover:bg-warning/15 hover:text-warning',
    effort: 'hover:bg-text-primary/[0.08]',
  };
  const dims: Dimension[] = ['model', 'mode', ...(config?.effort ? (['effort'] as const) : [])];
  const group = openDim ? config?.[openDim] : null;

  return (
    <span ref={rootRef} className="flex min-w-0 items-center gap-0.5" data-testid="agent-settings" onMouseEnter={warm} onFocus={warm}>
      {openDim && group ? (
        <ChoiceChips
          dimension={openDim}
          group={group}
          busy={busy}
          onPick={(value) =>
            value === group.selected ? setOpenDim(null) : void pick(openDim, value).then((ok) => ok && setOpenDim(null))
          }
        />
      ) : (
        dims.map((dimension) => (
          <button
            key={dimension}
            type="button"
            onClick={() => {
              warm();
              setOpenDim(dimension);
            }}
            title={DIMENSION_TITLE[dimension]}
            className={cn(
              'group/setting flex h-6 max-w-40 items-center gap-1 rounded-full px-2 text-xs text-text-primary transition-colors',
              tint[dimension]
            )}
            data-testid={`agent-setting-${dimension}`}
          >
            <span className="truncate">
              {label(dimension) ?? (dimension === 'model' ? (model ?? 'Model') : DIMENSION_TITLE[dimension])}
            </span>
            <ChevronDown className="size-3 shrink-0 opacity-40 transition-opacity group-hover/setting:opacity-100" strokeWidth={1.5} />
          </button>
        ))
      )}
    </span>
  );
}

/**
 * Your agent in the space panel. Its row says what it's set to
 * ("Opus 4.7 · Manual"); clicking it expands in place into one short row
 * per setting showing just the current pick (hover a setting and the other
 * choices slide out to its right), the context it has used, and "use as my
 * default everywhere". Clicking the row again folds it.
 */
export function AgentConfigRow({
  agent,
  avatar,
  busy: working,
  lastModel,
  usage,
}: {
  agent: AgentKind;
  avatar: ReactNode;
  busy: ReactNode;
  /** The model it last ran here, until its own list is loaded. */
  lastModel: string | null;
  usage: SessionCard['usage'];
}) {
  const { api, config, error, busy, warm, pick, label, retry } = useAgentConfig(agent);
  const [expanded, setExpanded] = useState(false);
  const [everywhere, setEverywhere] = useState(false);
  const [roomSees, setRoomSees] = useState<RoomSees | null>(null);
  const [roomSeesBusy, setRoomSeesBusy] = useState(false);
  useEffect(() => {
    if (!expanded || !api?.roomSees) return;
    let alive = true;
    void api.roomSees
      .load()
      .then((level) => alive && setRoomSees(level))
      .catch(() => {});
    const unwatch = api.roomSees.watch?.(setRoomSees);
    return () => {
      alive = false;
      unwatch?.();
    };
  }, [expanded, api]);
  const pickRoomSees = (value: string) => {
    if (!api?.roomSees || value === roomSees) return;
    const level = value as RoomSees;
    setRoomSeesBusy(true);
    void api.roomSees.change(level).then((changed) => {
      setRoomSeesBusy(false);
      if (changed) setRoomSees(level);
    });
  };

  const row = 'flex h-7 w-full shrink-0 items-center gap-2 rounded-control pr-2 pl-8 text-left transition-colors';
  if (!api) {
    return (
      <div className={row} data-testid="space-agent-row">
        {avatar}
        <span className="text-xs text-text-primary">{AGENT_NAME[agent]}</span>
        <span className="ml-auto flex items-center gap-1.5 text-2xs text-text-muted">{working}</span>
      </div>
    );
  }

  const summary = [label('model') ?? lastModel, label('mode')].filter(Boolean).join(' · ');
  const settingRow = (dimension: Dimension) => {
    const group = config?.[dimension];
    if (!group) return null;
    return (
      <div key={dimension} className="flex min-w-0 items-center gap-2">
        <span className="w-[4.5rem] shrink-0 text-2xs text-text-muted">{DIMENSION_TITLE[dimension]}</span>
        <ChoiceChips
          dimension={dimension}
          group={group}
          busy={busy}
          onPick={(value) => void pick(dimension, value, everywhere)}
          revealOnHover
        />
      </div>
    );
  };

  return (
    <div className="flex flex-col" data-testid="space-agent">
      <button
        type="button"
        onClick={() => {
          warm();
          setExpanded((v) => !v);
        }}
        onMouseEnter={warm}
        onFocus={warm}
        aria-expanded={expanded}
        className={cn(row, 'group/agent hover:bg-bg-2')}
        data-testid="space-agent-row"
      >
        {avatar}
        <span className="text-xs text-text-primary">{AGENT_NAME[agent]}</span>
        <span className="ml-auto flex min-w-0 items-center gap-1.5 text-2xs text-text-muted">
          {working}
          <span className="truncate">{summary}</span>
          <ChevronDown
            className={cn(
              'size-3 shrink-0 opacity-50 transition-[transform,opacity] duration-150 group-hover/agent:opacity-100',
              expanded && 'rotate-180'
            )}
            strokeWidth={1.5}
          />
        </span>
      </button>
      {expanded && (
        <div className="popover-in flex flex-col gap-1.5 py-1.5 pr-1 pl-8" data-testid="agent-config">
          {error && (
            <p className="flex items-center gap-2 text-xs text-text-muted">
              <span className="min-w-0 truncate">{error}</span>
              <button type="button" onClick={retry} className="shrink-0 text-accent hover:underline">
                Retry
              </button>
            </p>
          )}
          {!config && !error && <span className="h-6 animate-pulse rounded-full bg-text-primary/[0.05]" aria-hidden />}
          {settingRow('model')}
          {settingRow('mode')}
          {settingRow('effort')}
          {api.roomSees && roomSees && (
            <div className="flex min-w-0 items-center gap-2" data-testid="agent-room-sees">
              <span className="w-[4.5rem] shrink-0 text-2xs text-text-muted">{DIMENSION_TITLE.roomSees}</span>
              <ChoiceChips
                dimension="roomSees"
                group={roomSeesChoice(roomSees)}
                busy={roomSeesBusy}
                onPick={pickRoomSees}
                revealOnHover
              />
            </div>
          )}
          <div className="flex items-center gap-2 pt-0.5 text-2xs text-text-muted">
            {usage && (
              <span className="flex items-center gap-1">
                <ContextRing usage={usage} />
                {formatTokens(usage.used)} / {formatTokens(usage.size)}
              </span>
            )}
            {api.remember && (
              <label
                className="ml-auto flex cursor-pointer items-center gap-1.5 hover:text-text-primary"
                title={`Picks become your default for ${AGENT_NAME[agent]} in new chats and spaces`}
              >
                <input
                  type="checkbox"
                  checked={everywhere}
                  onChange={(e) => setEverywhere(e.target.checked)}
                  className="accent-accent size-3"
                />
                Set as default
              </label>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
