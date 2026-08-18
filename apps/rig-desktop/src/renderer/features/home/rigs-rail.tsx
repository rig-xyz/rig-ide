import {
  ArrowDownAZ,
  Check,
  ChevronDown,
  Clock,
  CloudOff,
  Download,
  FolderOpen,
  FolderSearch,
  LayoutList,
  MoreHorizontal,
  Plus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { deriveTabTitle } from '@renderer/features/chat/session-list';
import { relativeTime } from '@renderer/features/chat/session-history';
import type { AgentIdentity } from '@renderer/features/chat/use-runnable-agents';
import { useAnchorRect } from '@renderer/lib/hooks/use-anchor-rect';
import { AgentIcon } from '@renderer/lib/ui/agent-icon';
import { events, rpc } from '@renderer/lib/ipc';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import {
  DEFAULT_RIGS_RAIL_VIEW,
  rigSettingsChangedChannel,
  type RigsRailFilter,
  type RigsRailSort,
  type RigsRailView,
} from '@shared/rig/settings';
import {
  deriveRelayOnlyRowStatus,
  filterHomeRigRows,
  localRecencyKey,
  NOT_SET_UP_TOOLTIP,
  sortHomeRigRows,
  type HomeRigRow,
  type HomeRigSession,
} from './home-sections';
import { defaultJoinDir } from './join-flow';

/**
 * Round: HOME RESTRUCTURE — the left region ("YOUR RIGS", the action
 * zone). Replaces the old separate CONTINUE + RIGS sections with ONE
 * rig-centric list: each rig row carries its own recent sessions inline
 * as quiet sub-rows (harness icon + title + relative time), most-recent
 * rig first by default (`buildHomeRigRows`'s own ordering, `'recent'`
 * sort). Shared-not-set-up rigs sit in the SAME list (not a separate
 * section) with the existing Locate…/Download actions.
 *
 * Polish round: "Open a folder…" moved off the list end (it read as one
 * more row among rigs, not a distinct action) into a small text+icon
 * button right-aligned with the section label — Codex/Claude Desktop's
 * quiet header-action placement.
 *
 * Round 2 (Dylan — "very busy still," calm/scannable at 15+ rigs): a
 * compact filter/sort control sits under the header (`RigsFilterSortMenu`,
 * persisted via `rpc.rig.settings` — same `useState`+`events.on(
 * rigSettingsChangedChannel)` pattern `lastHarnessByRig` readers already
 * use). An honest one-line state replaces the list when a real filter
 * matches nothing — distinct from the true empty state (`home.tsx`'s own
 * `showEmptyState`, zero rigs anywhere), which never reaches this
 * component at all.
 */
export function RigsRail({
  rows,
  identities,
  onOpenPath,
  onOpenSession,
  onOpenFolder,
  onCreateRig,
  highlightBindingId,
}: {
  rows: readonly HomeRigRow[];
  identities: Map<string, AgentIdentity>;
  onOpenPath: (path: string) => void;
  onOpenSession: (path: string, sessionId: string) => void;
  onOpenFolder: () => void;
  onCreateRig: () => void;
  /**
   * Home restructure — pulse round: a rig-name link clicked in
   * `BriefingSpine` (WHAT'S NEW / ACROSS YOUR RIGS) that has no local match
   * scrolls its row into view here and briefly flashes it — same mechanism
   * `file-tree.tsx`'s `revealPath`/`useRevealHighlight` uses for a
   * breadcrumb folder click, just against this flat row list instead of a
   * recursive tree.
   */
  highlightBindingId?: string | null;
}) {
  const [view, setView] = useRigsRailView();
  const visibleRows = sortHomeRigRows(filterHomeRigRows(rows, view.filter), view.sort);

  return (
    <div className="lg:bg-bg-1 lg:rounded-card flex w-full flex-col gap-3 text-left lg:p-3">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between px-1">
          <p className="text-text-muted font-mono text-xs tracking-wide uppercase">Your rigs</p>
          <div className="-mr-1 flex items-center">
            <button
              type="button"
              onClick={onCreateRig}
              className="text-text-muted hover:text-text-primary rounded-control flex items-center gap-1 px-1.5 py-0.5 text-xs transition-colors"
            >
              <Plus className="size-3 shrink-0" strokeWidth={1.5} />
              New rig
            </button>
            <button
              type="button"
              onClick={onOpenFolder}
              className="text-text-muted hover:text-text-primary rounded-control flex items-center gap-1 px-1.5 py-0.5 text-xs transition-colors"
            >
              <FolderOpen className="size-3 shrink-0" strokeWidth={1.5} />
              Open
            </button>
          </div>
        </div>
        {rows.length > 0 && <RigsFilterSortMenu view={view} onChange={setView} />}
      </div>
      {visibleRows.length === 0 && rows.length > 0 ? (
        <p className="text-text-muted px-1 text-xs">No rigs match this filter.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {visibleRows.map((row) =>
            row.kind === 'local' ? (
              <LocalRigRow
                key={row.bindingId}
                row={row}
                identities={identities}
                onOpenPath={onOpenPath}
                onOpenSession={onOpenSession}
                isHighlightTarget={row.bindingId === highlightBindingId}
              />
            ) : (
              <RelayOnlyRigRow
                key={row.bindingId}
                row={row}
                onOpenPath={onOpenPath}
                isHighlightTarget={row.bindingId === highlightBindingId}
              />
            )
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Reads/writes the rigs rail's filter/sort preference the same way
 * `chat-panel.tsx` reads `lastHarnessByRig`: an initial `rpc.rig.settings.get()`
 * plus a live `rigSettingsChangedChannel` subscription (so a change from
 * another window — or Settings, if this is ever surfaced there — reflects
 * immediately), defaulting to `DEFAULT_RIGS_RAIL_VIEW` until the first read
 * resolves rather than flashing something else first.
 */
function useRigsRailView(): [RigsRailView, (next: RigsRailView) => void] {
  const [view, setLocalView] = useState<RigsRailView>(DEFAULT_RIGS_RAIL_VIEW);

  useEffect(() => {
    let alive = true;
    rpc.rig.settings
      .get()
      .then((settings) => {
        if (alive) setLocalView(settings.rigsRailView);
      })
      .catch(() => {});
    const off = events.on(rigSettingsChangedChannel, (settings) => setLocalView(settings.rigsRailView));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const setView = (next: RigsRailView) => {
    setLocalView(next);
    void rpc.rig.settings.set({ rigsRailView: next });
  };

  return [view, setView];
}

const FILTER_LABELS: Record<RigsRailFilter, string> = {
  all: 'All',
  local: 'Local',
  shared: 'Shared',
  notSetUp: 'Not set up',
};
const SORT_LABELS: Record<RigsRailSort, string> = {
  recent: 'Recent activity',
  name: 'Name',
};
/**
 * One icon language: the same glyphs the rows themselves carry (a row's
 * leading glyph says what KIND of rig it is — folder = here, Users =
 * someone else's shared with you, CloudOff = yours but not on this Mac).
 * Every option carries one so no label floats out of alignment.
 */
const FILTER_ICONS: Record<RigsRailFilter, LucideIcon> = {
  all: LayoutList,
  local: FolderOpen,
  shared: Users,
  notSetUp: CloudOff,
};
const SORT_ICONS: Record<RigsRailSort, LucideIcon> = {
  recent: Clock,
  name: ArrowDownAZ,
};

/**
 * The one quiet control for both filter and sort — a single dropdown
 * (Dylan's "I like the three dots," and "your judgment on which stays
 * calmest with 15+ rigs": two separate pill rows would add MORE lines to
 * an already-dense list, working against the round's own "breathing room"
 * goal, so one compact trigger wins). Trigger reads the current choice
 * ("All · Recent activity"); the menu lists Filter then Sort as two
 * labeled groups of selectable rows, current choice checked — same
 * `useAnchorRect` + portal + outside-pointerdown/Escape convention every
 * other dropdown here uses (`RelayOnlyActionsMenu`, `RigSwitcher`).
 */
function RigsFilterSortMenu({
  view,
  onChange,
}: {
  view: RigsRailView;
  onChange: (next: RigsRailView) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const rect = useAnchorRect(open, triggerRef, { gap: 4, estimatedHeight: 220, estimatedWidth: 180 });

  useEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(false);
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="text-text-muted hover:text-text-primary hover:border-border-strong border-border-hairline bg-bg-2 rounded-chip ml-1 flex w-fit items-center gap-1 border px-2 py-0.5 font-mono text-xs transition-colors"
      >
        {FILTER_LABELS[view.filter]} · {SORT_LABELS[view.sort]}
        <ChevronDown className="size-3 shrink-0" strokeWidth={1.5} />
      </button>
      {open &&
        rect &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{
              position: 'fixed',
              width: Math.max(rect.width, 180),
              maxHeight: rect.maxHeight,
              overflowY: 'auto',
              ...(rect.placement === 'below' ? { top: rect.top } : { bottom: rect.bottom }),
              ...(rect.align === 'left' ? { left: rect.left } : { right: rect.right }),
            }}
            className="border-border-hairline bg-bg-1 rounded-control shadow-soft z-50 border py-1"
          >
            <p className="text-text-muted px-2.5 pt-1 pb-0.5 font-mono text-xs tracking-wide uppercase">
              Filter
            </p>
            {(Object.keys(FILTER_LABELS) as RigsRailFilter[]).map((filter) => (
              <MenuOptionRow
                key={filter}
                label={FILTER_LABELS[filter]}
                icon={FILTER_ICONS[filter]}
                checked={view.filter === filter}
                onSelect={() => {
                  onChange({ ...view, filter });
                  setOpen(false);
                }}
              />
            ))}
            <p className="text-text-muted border-border-hairline mt-1 border-t px-2.5 pt-1.5 pb-0.5 font-mono text-xs tracking-wide uppercase">
              Sort
            </p>
            {(Object.keys(SORT_LABELS) as RigsRailSort[]).map((sort) => (
              <MenuOptionRow
                key={sort}
                label={SORT_LABELS[sort]}
                icon={SORT_ICONS[sort]}
                checked={view.sort === sort}
                onSelect={() => {
                  onChange({ ...view, sort });
                  setOpen(false);
                }}
              />
            ))}
          </div>,
          document.body
        )}
    </>
  );
}

function MenuOptionRow({
  label,
  checked,
  onSelect,
  icon: Icon,
}: {
  label: string;
  checked: boolean;
  onSelect: () => void;
  /**
   * The same glyph the matching ROWS carry (folder = local, CloudOff =
   * not set up, Users = shared) so the filter vocabulary and the list's
   * own vocabulary are one language — Dylan's ask. Sort rows pass none.
   */
  icon?: LucideIcon;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      onMouseDown={(event) => {
        event.preventDefault();
        onSelect();
      }}
      className="hover:bg-bg-2 text-text-primary flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm"
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {checked && <Check className="size-3" strokeWidth={1.5} />}
      </span>
      {Icon && <Icon className="text-text-muted size-3.5 shrink-0" strokeWidth={1.5} />}
      {label}
    </button>
  );
}

/** Matches `file-tree.tsx`'s own reveal-highlight timing (`useRevealHighlight`) — same affordance, different list shape. */
const HIGHLIGHT_MS = 1400;

/**
 * Scrolls a just-linked-to row into view once and flags it for a brief
 * highlight — the rigs-rail half of a WHAT'S NEW/ACROSS YOUR RIGS rig-name
 * click that has no local match (`briefing-spine.tsx`). Deliberately a
 * small local twin of `file-tree.tsx`'s `useRevealHighlight` rather than a
 * shared export: same shape, but keyed to a flat row list (not a recursive
 * tree) and a `<div>` root (not a `<button>`) — sharing one generic hook
 * across both would cost more in indirection than the ~15 duplicated lines
 * save.
 */
function useRowHighlight(isTarget: boolean): { ref: React.RefObject<HTMLDivElement | null>; flashing: boolean } {
  const ref = useRef<HTMLDivElement | null>(null);
  const [flashing, setFlashing] = useState(false);

  useEffect(() => {
    if (!isTarget) return;
    ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFlashing(true);
    const timer = window.setTimeout(() => setFlashing(false), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
    // Fires once per highlight — `isTarget` flips true only when this exact
    // row becomes the target of a fresh rig-name click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTarget]);

  return { ref, flashing };
}

/**
 * A local rig. Round 2 (Dylan: drop the path, show last-activity — "what is
 * most useful are the sessions and the last edited time... so users know
 * when something changed"): the subtext line is now `localRecencyKey`
 * (freshest of `lastOpenedAt`/newest session `updatedAt`) formatted as
 * relative time, never the path — the path moves to a native `title`
 * tooltip on the row itself (a reference detail, not something worth a
 * permanent line once activity time is more useful there).
 *
 * Breathing-room round: `py-1.5`→`py-2` on the row, a real `gap-1` between
 * session sub-rows (was a near-invisible `gap-0.5`), and the sub-rows now
 * hang off a quiet left border (`ml-[7px] border-l pl-[19px]`, aligned
 * under the row's own icon) rather than a bare `pl-6` indent — a visible
 * connector, not just whitespace, so "this rig, then its sessions" reads
 * as one group at a glance instead of two stacked lines that happen to be
 * near each other.
 */
function LocalRigRow({
  row,
  identities,
  onOpenPath,
  onOpenSession,
  isHighlightTarget,
}: {
  row: Extract<HomeRigRow, { kind: 'local' }>;
  identities: Map<string, AgentIdentity>;
  onOpenPath: (path: string) => void;
  onOpenSession: (path: string, sessionId: string) => void;
  isHighlightTarget: boolean;
}) {
  const { ref, flashing } = useRowHighlight(isHighlightTarget);
  const lastActivity = localRecencyKey(row);
  return (
    <div ref={ref} className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => onOpenPath(row.path)}
        title={row.path}
        className={cn(
          'flex items-center gap-2 rounded-control px-2 py-2 text-left transition-colors',
          flashing ? 'bg-accent-subtle' : 'hover:bg-bg-2'
        )}
      >
        <FolderOpen className="text-text-muted size-3.5 shrink-0" strokeWidth={1.5} />
        <span className="min-w-0 flex-1">
          <span className="text-text-primary block truncate text-sm">{row.name ?? row.path.split('/').pop()}</span>
          <span className="text-text-muted block truncate font-mono text-xs">
            {relativeTime(lastActivity, Date.now())}
          </span>
        </span>
      </button>
      {row.sessions.length > 0 && (
        <div className="ml-[7px] flex flex-col gap-1 border-l border-border-hairline pl-[19px]">
          {row.sessions.map((session) => (
            <SessionSubRow
              key={session.id}
              session={session}
              identities={identities}
              onOpen={() => onOpenSession(row.path, session.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SessionSubRow({
  session,
  identities,
  onOpen,
}: {
  session: HomeRigSession;
  identities: Map<string, AgentIdentity>;
  onOpen: () => void;
}) {
  const icon = identities.get(session.providerId)?.icon;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="hover:bg-bg-2 flex items-center gap-1.5 rounded-control px-2 py-1 text-left transition-colors"
    >
      {icon && <AgentIcon icon={icon} size={12} className="shrink-0" />}
      <span className="text-text-secondary min-w-0 flex-1 truncate text-[12px]">
        {deriveTabTitle(session.title)}
      </span>
      <span className="text-text-muted shrink-0 font-mono text-xs">
        {relativeTime(session.updatedAt, Date.now())}
      </span>
    </button>
  );
}

/**
 * A relay-only row's rendering. A row with no known local path
 * (`row.localPath === null` — from `rig_rigs`, existence-verified, no
 * filesystem scan) never shows a path line at all. A quiet `⋯` trigger
 * replaces it (`RelayOnlyActionsMenu`) — declutter round: the two setup
 * actions used to sit inline as a permanently-visible second row under
 * every not-yet-set-up rig; now they're one hover/focus-revealed trigger,
 * same slot the "Open" button occupies for a row WITH a known local path,
 * opening a small menu with the same two actions:
 *
 * - "Download…" (any member, `canAutoJoin`) — the native picker, opened
 *   with a suggested destination visible only inside the dialog itself,
 *   then `rig attach` into whatever the user actually picked.
 * - "Locate…" (any role) — "I already have this on my machine": the native
 *   picker, then `rpc.rig.join.locate` reads and verifies the picked
 *   folder's OWN `.rig/tap-binding.local.json` before anything is recorded.
 *
 * A row WITH a known local path shows the real path and "Open" — the one
 * case where a path line is honest, because it was actually found. The
 * pending ("checking…") state gets neither — see `RigsRail`'s own D7 note.
 *
 * Status-icon round 2 (Dylan — explicit ask: REPLACES the leading folder
 * glyph, not additive beside the name): `deriveRelayOnlyRowStatus`'s
 * `notSetUp` case swaps the row's own leading icon for `CloudOff` — one
 * icon, muted, never accent, doing the whole job "not here" needs to do —
 * every other status (checking, a known local path) keeps the ordinary
 * `FolderOpen` local rows use too, since those rows genuinely aren't in the
 * "not here" state. `NOT_SET_UP_TOOLTIP` rides along on the same icon. The
 * "shared with you" claim, where it's actually true, stays as real subtext
 * — an owned-but-not-set-up row shows just name + icon, nothing else.
 */
function RelayOnlyRigRow({
  row,
  onOpenPath,
  isHighlightTarget,
}: {
  row: Extract<HomeRigRow, { kind: 'relayOnly' }>;
  onOpenPath: (path: string) => void;
  isHighlightTarget: boolean;
}) {
  const status = deriveRelayOnlyRowStatus(row);
  // Owned here, not by `RelayOnlyActionsMenu`, so a failed Download/Locate
  // stays visible as its own line below the row after the menu (and the
  // trigger's hover/focus reveal) closes back up.
  const [error, setError] = useState<string | null>(null);
  const { ref, flashing } = useRowHighlight(isHighlightTarget);

  return (
    <div
      ref={ref}
      className={cn(
        'group flex flex-col gap-1 rounded-control px-2 py-2 transition-colors',
        flashing ? 'bg-accent-subtle' : 'hover:bg-bg-2'
      )}
    >
      <div className="flex items-center gap-2">
        {status.kind === 'notSetUp' ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  tabIndex={0}
                  aria-label={NOT_SET_UP_TOOLTIP}
                  className="text-text-muted inline-flex size-3.5 shrink-0 items-center justify-center"
                >
                  {status.sharedSubtext ? (
                    <Users className="size-3.5" strokeWidth={1.5} />
                  ) : (
                    <CloudOff className="size-3.5" strokeWidth={1.5} />
                  )}
                </span>
              }
            />
            <TooltipContent side="top">{NOT_SET_UP_TOOLTIP}</TooltipContent>
          </Tooltip>
        ) : (
          <FolderOpen className="text-text-muted size-3.5 shrink-0" strokeWidth={1.5} />
        )}
        <span className="min-w-0 flex-1">
          <span className="text-text-primary block truncate text-sm">{row.name}</span>
          {row.disambiguator && (
            <span className="text-text-muted block truncate font-mono text-xs">{row.disambiguator}</span>
          )}
          {status.kind === 'checking' ? (
            // D7 fix: the honest third state — never a guess at "shared
            // with you" (which used to render for the split second before
            // `resolveLocalPaths` had actually answered) or Download/
            // Locate offered before the app knows there's really nothing
            // to just re-open.
            <span className="text-text-muted block truncate font-mono text-xs">checking…</span>
          ) : status.kind === 'localPath' ? (
            <span className="text-text-muted block truncate font-mono text-xs">{status.path}</span>
          ) : (
            status.sharedSubtext && (
              // The leading glyph already carries Users for a shared row —
              // no second copy here.
              <span className="text-text-muted block truncate text-xs">{status.sharedSubtext}</span>
            )
          )}
        </span>
        {status.kind === 'localPath' ? (
          <button
            type="button"
            onClick={() => onOpenPath(status.path)}
            className="text-accent flex shrink-0 items-center gap-1 text-xs transition-opacity hover:opacity-80"
          >
            Open
          </button>
        ) : (
          status.kind === 'notSetUp' && (
            <RelayOnlyActionsMenu
              row={row}
              onOpenPath={onOpenPath}
              onError={setError}
            />
          )
        )}
      </div>
      {error && <p className="text-danger pl-6 text-xs">{error}</p>}
    </div>
  );
}

/**
 * The `⋯` trigger for a relay-only row without a known local path — quiet
 * by default (`opacity-0`), revealed on row hover (`group-hover`, the
 * parent row carries `group`) or when the trigger itself has keyboard
 * focus (`focus-visible:opacity-100`, so Tab still reaches it even with the
 * mouse elsewhere — declutter never means unreachable). Same portal
 * positioning primitive every other dropdown in this app uses
 * (`useAnchorRect`, see `harness-picker.tsx`), with the simpler
 * outside-pointerdown/Escape dismiss `user-pill.tsx`'s account popover uses
 * — a flat action list needs no arrow-key highlight state.
 */
function RelayOnlyActionsMenu({
  row,
  onOpenPath,
  onError,
}: {
  row: Extract<HomeRigRow, { kind: 'relayOnly' }>;
  onOpenPath: (path: string) => void;
  onError: (message: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [locating, setLocating] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const busy = downloading || locating;
  const rect = useAnchorRect(open, triggerRef, { gap: 4, estimatedHeight: 76, estimatedWidth: 140 });

  useEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(false);
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const download = async () => {
    setOpen(false);
    setDownloading(true);
    onError(null);
    try {
      const picked = await rpc.app.openSelectDirectoryDialog({
        title: 'Choose a folder',
        message: `Where should "${row.name}" be set up?`,
        // A starting suggestion only, seen nowhere but inside the dialog
        // the user controls — never displayed as page text.
        defaultPath: defaultJoinDir(row.name),
      });
      if (!picked) return;
      const result = await rpc.rig.join.attach({ bindingId: row.bindingId, targetDir: picked });
      if (!result.success) {
        onError(result.error.message);
        return;
      }
      onOpenPath(result.data.localPath);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Couldn't open the folder picker.");
    } finally {
      setDownloading(false);
    }
  };

  const locate = async () => {
    setOpen(false);
    setLocating(true);
    onError(null);
    try {
      const picked = await rpc.app.openSelectDirectoryDialog({
        title: 'Locate this rig',
        message: `Pick the folder where "${row.name}" already lives`,
      });
      if (!picked) return;
      const result = await rpc.rig.join.locate({ bindingId: row.bindingId, dir: picked });
      if (!result.success) {
        onError(result.error.message);
        return;
      }
      onOpenPath(result.data.localPath);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Couldn't open the folder picker.");
    } finally {
      setLocating(false);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Set up "${row.name}"`}
        className={`text-text-muted hover:text-text-primary focus-visible:outline-accent rounded-control flex shrink-0 items-center justify-center p-1 transition-opacity focus-visible:outline-2 focus-visible:outline-offset-2 ${
          busy
            ? 'pointer-events-none opacity-100'
            : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
        }`}
      >
        {busy ? (
          <span className="text-text-muted text-xs">{downloading ? 'Downloading…' : 'Locating…'}</span>
        ) : (
          <MoreHorizontal className="size-3.5" strokeWidth={1.5} />
        )}
      </button>
      {open &&
        rect &&
        createPortal(
          <div
            role="menu"
            style={{
              position: 'fixed',
              width: Math.max(rect.width, 140),
              maxHeight: rect.maxHeight,
              overflowY: 'auto',
              ...(rect.placement === 'below' ? { top: rect.top } : { bottom: rect.bottom }),
              ...(rect.align === 'left' ? { left: rect.left } : { right: rect.right }),
            }}
            className="border-border-hairline bg-bg-1 rounded-control shadow-soft z-50 border py-1"
          >
            {row.canAutoJoin && (
              <button
                type="button"
                role="menuitem"
                onMouseDown={(event) => {
                  // Keeps focus on the trigger — a plain click here would
                  // blur it first and close the menu before this fires.
                  event.preventDefault();
                  void download();
                }}
                className="hover:bg-bg-2 text-text-primary flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm"
              >
                <Download className="size-3.5 shrink-0" strokeWidth={1.5} />
                Download…
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onMouseDown={(event) => {
                event.preventDefault();
                void locate();
              }}
              className="hover:bg-bg-2 text-text-primary flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm"
            >
              <FolderSearch className="size-3.5 shrink-0" strokeWidth={1.5} />
              Locate…
            </button>
          </div>,
          document.body
        )}
    </>
  );
}
