import { useQuery } from '@tanstack/react-query';
import { ChevronRight, EyeOff, FileText, Globe, MessageSquare, Rows3, Terminal, X, Plus } from 'lucide-react';
import { Reorder, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import {
  activeTab,
  type ArtefactTab,
  type ArtefactTabsState,
} from '@renderer/features/artifact/artefact-tabs';
import { SessionTabLabel } from '@renderer/features/chat/session/session-tab-label';
import { AGENT_NAME } from '@renderer/features/spaces/components/identity';
import {
  describeAgentTileState,
  deriveAgentTileState,
} from '@renderer/features/spaces/components/space-rail-status';
import { useRoomStatus } from '@renderer/features/spaces/room-status-store';
import { rpc } from '@renderer/lib/ipc';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { viewCountFor, viewMetaPath, type ViewManifest } from '@shared/rig/views';
import {
  roomRowStatus,
  ownerRefreshOf,
  runningEntries,
  viewRowStatus,
  type AgentEntry,
  type Matrix,
  type RunningEntryData,
} from './space-status';
import { hideTab, orderTabs, showTab, withViewTitle, type TabPrefs } from './tab-prefs';
import { ViewIcon } from './view-icon';
import { useSpaceStanding } from './use-space-standing';

/**
 * A space's tabs, down the left (spike, Rig Alpha; row C of the "Rig Space Window" design). The
 * Room is the first tab; every view, file, page and session open in the space follows. One of them
 * fills the centre at a time. Under the tabs, what keeps running here without anyone asking: the
 * views that refresh themselves, as their own `view.json` says.
 *
 * It replaces the tab strip on top of the pane and the Room-beside-everything split, so a choice
 * made in a view never moves the conversation: the Room's row shows the session is on it instead.
 */
export function SpaceTabsRail({
  bindingId,
  state,
  roomActive,
  underBar,
  views,
  unseenViews,
  onOpenRoom,
  onActivateTab,
  onCloseTab,
  rootId,
  prefs,
  onPrefs,
  onOpenView,
  onNewSideChat,
}: {
  bindingId: string;
  state: ArtefactTabsState;
  /** The Room fills the centre (no tab does). */
  roomActive: boolean;
  /** The window's bar floats over the panes here, so the rail clears it itself. */
  underBar: boolean;
  views: readonly ViewManifest[];
  /** Views that appeared since the member last looked at them. */
  unseenViews: ReadonlySet<string>;
  onOpenRoom: () => void;
  onActivateTab: (index: number) => void;
  onCloseTab: (index: number) => void;
  /** The space's files, where renaming a tab writes the view's title. */
  rootId: string | null;
  /** How this person arranged the tabs: their order, and the ones they hid. */
  prefs: TabPrefs;
  onPrefs: (change: (prefs: TabPrefs) => TabPrefs) => void;
  /** Brings a hidden view's tab back and shows it. */
  onOpenView: (name: string) => void;
  /** Opens a new side chat (a private session beside the Room) as a tab. Absent: no "+" row. */
  onNewSideChat?: () => void;
}) {
  const { spaceState, working, justScheduled, now } = useSpaceStanding(bindingId, views);
  const current = roomActive ? null : activeTab(state);
  const info = (name: string) => views.find((view) => view.name === name);
  // The space's agents that are doing something or just did, read off the live Room.
  const room = useRoomStatus(bindingId);
  const me = useQuery({ queryKey: ['rig', 'account', 'me'], queryFn: () => rpc.rig.account.me() });
  const selfUserId = me.data?.success ? me.data.data.id : undefined;
  const runs = room ? Object.values(room.sessionMetaByRun) : [];
  const agents: AgentEntry[] = (room?.agents ?? []).flatMap(({ agent, owner }) => {
    const ownerMember = room?.members.find((member) => member.id === owner);
    const state = deriveAgentTileState(
      runs.filter((run) => run.owner === owner && run.agent === agent),
      room!,
      Date.now()
    );
    if (state.kind !== 'live') return [];
    const theirs = ownerMember && owner !== selfUserId ? ownerMember.name : undefined;
    const name = theirs ? `${theirs}'s ${AGENT_NAME[agent]}` : AGENT_NAME[agent];
    return [
      {
        key: `${owner}:${agent}`,
        agent,
        mine: owner === selfUserId,
        state: state.state,
        label: describeAgentTileState(state, name, theirs),
      },
    ];
  });
  const entries = runningEntries({
    views,
    state: spaceState,
    agents,
    agentName: AGENT_NAME,
    viewTurns: working,
    justScheduled,
    members: room?.members,
    now,
  });
  // For a view another member's app keeps fresh: who that is, and their last refresh of it, as the
  // Room's runs tell it (when the run last reported, and why it failed, once its log is here).
  const ownerOf = (name: string) => {
    const work = spaceState?.views.find((w) => w.view === name);
    if (!work || work.runsHere !== false) return { runsAsName: null, ownerRefresh: null };
    return {
      runsAsName: room?.members.find((member) => member.id === work.runsAs)?.name ?? null,
      ownerRefresh: ownerRefreshOf({
        view: name,
        runsAs: work.runsAs,
        runs: runs.map((run) => {
          const log = room?.sessionEventsByRun[run.id] ?? [];
          const ended = [...log].reverse().find((event) => event.kind === 'turn_ended');
          const reason = ended?.payload.reason;
          return {
            ...run,
            lastWordAt: log.reduce((latest, event) => Math.max(latest, event.at ?? 0), 0),
            reason: typeof reason === 'string' ? reason : null,
          };
        }),
      }),
    };
  };
  const roomStatus = roomRowStatus({ runs: spaceState?.runs ?? [], viewTurns: working, views });
  const stateRuns = spaceState?.runs ?? [];
  const viewerId = selfUserId ?? null;

  // The person's own arrangement: view tabs in their order, hidden ones out of the list.
  const reduced = useReducedMotion();
  const dragging = useRef(false);
  const viewsRef = useRef<HTMLDivElement>(null);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const openViews = state.tabs.flatMap((tab) => (tab.kind === 'view' ? [tab.name] : []));
  const viewOrder = orderTabs(openViews, prefs.order, (name) => info(name)?.order ?? null);
  const hidden = prefs.hidden.filter(
    (name) => !openViews.includes(name) && views.some((view) => view.name === name)
  );
  // A new title shows at once; the view's file catches up a moment later.
  const [renamed, setRenamed] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    setRenamed((current) => {
      const kept = [...current].filter(
        ([name, title]) => views.find((view) => view.name === name)?.title !== title
      );
      return kept.length === current.size ? current : new Map(kept);
    });
  }, [views]);
  const rename = async (name: string, title: string) => {
    if (!rootId) return;
    const relativePath = viewMetaPath(name);
    const read = await rpc.rig.files.read({ rootId, relativePath, maxBytes: 16_000 });
    if (read.success && read.data.truncated) return;
    const next = withViewTitle(read.success ? read.data.content : null, title);
    if (!next) return;
    setRenamed((current) => new Map(current).set(name, JSON.parse(next).title as string));
    const wrote = await rpc.rig.files.write({ rootId, relativePath, content: next });
    if (!wrote.success)
      setRenamed((current) => {
        const map = new Map(current);
        map.delete(name);
        return map;
      });
  };

  const row = (tab: ArtefactTab, index: number) => {
          // The rail moves between pages: the Room, views, sessions. A file or a web page is not one;
          // it opens beside the Room and has its tab there.
          if (tab.kind !== 'view' && tab.kind !== 'session') return null;
          const manifest = tab.kind === 'view' ? info(tab.name) : undefined;
          const status =
            tab.kind === 'view' && manifest
              ? viewRowStatus({
                  manifest,
                  work: spaceState?.views.find((work) => work.view === manifest.name),
                  runs: stateRuns,
                  turnRunning: working.includes(manifest.name),
                  unseen: unseenViews.has(manifest.name),
                  justScheduled: justScheduled.has(manifest.name),
                  viewerId,
                  ...ownerOf(manifest.name),
                  now,
                })
              : null;
          return (
            <RailRow
              key={tabKey(tab)}
              active={tab === current}
              // A view being worked on right now shows the status grid in place of its icon.
              icon={
                status?.matrix ? (
                  <DotMatrix state={status.matrix.state} tone={status.matrix.tone} size="sm" />
                ) : (
                  tabIcon(tab, manifest)
                )
              }
              title={
                tab.kind === 'session' ? (
                  // (The label is a mark, a title and a status grid: laid out in one line here.)
                  <span className="flex min-w-0 items-center gap-1.5">
                    <SessionTabLabel sessionId={tab.sessionId} />
                  </span>
                ) : tab.kind === 'view' ? (
                  (renamed.get(tab.name) ?? manifest?.title ?? tab.name)
                ) : (
                  tabTitle(tab)
                )
              }
              sub={status ? status.text : tab.kind === 'view' ? '' : tabSub(tab)}
              fresh={status?.fresh}
              tone={status?.tone}
              tooltip={status?.tooltip}
              arrived={status?.arrived}
              badge={
                tab.kind !== 'view' || tab === current
                  ? null
                  : unseenViews.has(tab.name)
                    ? 'new'
                    : viewBadge(manifest, viewerId)
              }
              onSelect={() => {
                if (!dragging.current) onActivateTab(index);
              }}
              onClose={() => {
                // Closing a view's tab hides it; it waits under "hidden" at the foot of the list.
                if (tab.kind === 'view') onPrefs((current) => hideTab(current, tab.name));
                onCloseTab(index);
              }}
              closeLabel={tab.kind === 'view' ? 'Hide tab' : 'Close tab'}
              onRename={
                tab.kind === 'view' && rootId
                  ? (title: string) => void rename(tab.name, title)
                  : undefined
              }
            />
          );
  };

  return (
    <nav
      aria-label="Tabs"
      data-testid="space-tabs-rail"
      className={cn(
        'flex w-[236px] shrink-0 flex-col bg-bg-0 px-2.5 pb-3',
        underBar ? 'pt-[52px]' : 'pt-3'
      )}
    >
      <div className="flex justify-between px-2.5 pb-2 font-mono text-kicker tracking-wider text-text-muted uppercase">
        <span>Tabs</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        <RailRow
          active={roomActive}
          icon={<MessageSquare className="size-3.5" strokeWidth={1.7} />}
          title="Room"
          sub={roomStatus.text}
          tone={roomStatus.tone}
          live={roomStatus.matrix}
          onSelect={onOpenRoom}
        />
        <Reorder.Group
          ref={viewsRef}
          as="div"
          axis="y"
          values={viewOrder}
          onReorder={(names: string[]) => onPrefs((current) => ({ ...current, order: names }))}
          className="flex flex-col gap-0.5"
        >
          {viewOrder.map((name) => {
            const index = state.tabs.findIndex((tab) => tab.kind === 'view' && tab.name === name);
            const tab = state.tabs[index];
            if (!tab) return null;
            return (
              <Reorder.Item
                key={name}
                as="div"
                value={name}
                data-testid="space-tab-view"
                data-view={name}
                // A drag ends with a release over the row: that release is not a press on the tab.
                // A tab moves among the view tabs only: it cannot be carried over the Room's row.
                dragConstraints={viewsRef}
                dragElastic={0.06}
                onDragStart={() => (dragging.current = true)}
                onDragEnd={() => window.setTimeout(() => (dragging.current = false), 0)}
                whileDrag={
                  reduced
                    ? undefined
                    : { scale: 1.02, boxShadow: '0 8px 24px -8px rgba(0,0,0,0.5)', zIndex: 1 }
                }
                transition={{ type: 'spring', duration: 0.3, bounce: 0.12 }}
                className="relative rounded-lg bg-bg-0"
              >
                {row(tab, index)}
              </Reorder.Item>
            );
          })}
        </Reorder.Group>
        {state.tabs.map((tab, index) => (tab.kind === 'session' ? row(tab, index) : null))}
        {/* A chat of your own beside the Room: only you see it, and it starts from what the Room
            was talking about. */}
        {onNewSideChat && (
          <button
            type="button"
            onClick={onNewSideChat}
            data-testid="space-tabs-new-side-chat"
            title="A private chat beside the Room. Only you see it; it starts from the Room's recent conversation."
            className="group/side mt-1 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-text-muted transition-[color,background-color,transform] duration-150 ease-out outline-none hover:bg-bg-2/60 hover:text-text-secondary focus-visible:ring-2 focus-visible:ring-accent/60 active:scale-[0.98]"
          >
            <span className="flex size-5 shrink-0 items-center justify-center">
              <Plus
                className="size-3.5 transition-transform duration-200 ease-out group-hover/side:rotate-90"
                strokeWidth={1.75}
              />
            </span>
            Side chat
          </button>
        )}
        {hidden.length > 0 && (
          <div className="mt-1 flex flex-col gap-0.5">
            <button
              type="button"
              onClick={() => setHiddenOpen((open) => !open)}
              aria-expanded={hiddenOpen}
              data-testid="space-tabs-hidden"
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-2xs text-text-muted transition-colors duration-150 hover:bg-bg-2/60 hover:text-text-secondary"
            >
              <ChevronRight
                className={cn(
                  'size-3 transition-transform duration-150 ease-out',
                  hiddenOpen && 'rotate-90'
                )}
                strokeWidth={1.7}
              />
              {hidden.length} hidden
            </button>
            {hiddenOpen &&
              hidden.map((name) => (
                <button
                  key={name}
                  type="button"
                  title="Show this tab again"
                  data-testid="space-tab-hidden"
                  onClick={() => {
                    onPrefs((current) => showTab(current, name));
                    onOpenView(name);
                  }}
                  className="group flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-text-muted transition-colors duration-150 hover:bg-bg-2/60 hover:text-text-primary"
                >
                  <span className="flex size-6 shrink-0 items-center justify-center">
                    <EyeOff className="size-3.5" strokeWidth={1.7} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {info(name)?.title ?? name}
                  </span>
                  <span className="text-2xs opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                    Show
                  </span>
                </button>
              ))}
          </div>
        )}
      </div>
      {entries.length > 0 && (
        <div
          data-testid="space-rail-now"
          className="mt-2 flex flex-col gap-2.5 border-t border-border-hairline px-1.5 pt-3 pb-0.5"
        >
          <ul className="flex flex-col gap-2.5">
            {entries.map((entry) => (
              <RunningEntry key={entry.key} entry={entry} bindingId={bindingId} />
            ))}
          </ul>
        </div>
      )}
    </nav>
  );
}

/** One thing running in the space: the status grid the Room uses, then what it is and where it stands. */
function RunningEntry({ entry, bindingId }: { entry: RunningEntryData; bindingId: string }) {
  // "Run now" on what runs next: the same pass, started by the person. One press at a time.
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const runNow = entry.runNow
    ? async () => {
        setStarting(true);
        setProblem(null);
        const result = await rpc.rig.spacesDispatch
          .runViewNow({ bindingId, view: entry.runNow! })
          .catch(() => null);
        setStarting(false);
        if (!result?.success) setProblem(result?.error ?? "Couldn't start it. Try again in a moment.");
      }
    : null;
  // "Accept" on a schedule another member set or changed: from then on it runs like the person's own.
  const accept = entry.accept
    ? async () => {
        setStarting(true);
        setProblem(null);
        const result = await rpc.rig.spacesDispatch
          .acceptViewSchedule({ bindingId, view: entry.accept! })
          .catch(() => null);
        setStarting(false);
        if (!result?.success) setProblem(result?.error ?? "Couldn't accept it. Try again in a moment.");
      }
    : null;
  return (
    <li
      title={entry.tooltip}
      className={cn('group/now flex items-start gap-2.5 px-1', entry.arrived && 'card-pop-in')}
    >
      <span className="mt-1 flex w-3.5 shrink-0 justify-center">
        <DotMatrix state={starting && !entry.accept ? 'starting' : entry.matrix} tone={entry.matrixTone} size="sm" />
      </span>
      <div className="min-w-0 flex-1 text-meta leading-snug text-text-secondary">
        <div className="truncate">{entry.label}</div>
        {/* The time, then Run now as a quiet action on the same line: words, not a boxed button. */}
        <div className="flex items-baseline gap-1.5 text-2xs">
          {(problem ?? entry.sub) && (
            <span className={cn('min-w-0 truncate', problem ? 'text-danger' : subClass(entry.subTone))}>
              {problem ?? entry.sub}
            </span>
          )}
          {runNow && (
            <>
              <span className="text-text-muted/60" aria-hidden>
                ·
              </span>
              <button
                type="button"
                disabled={starting}
                onClick={() => void runNow()}
                data-testid="space-rail-run-now"
                className="shrink-0 rounded-[4px] font-medium text-text-secondary outline-none transition-colors duration-150 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/60 disabled:text-text-muted"
              >
                {starting ? 'Starting…' : 'Run now'}
              </button>
            </>
          )}
          {accept && (
            <>
              <span className="text-text-muted/60" aria-hidden>
                ·
              </span>
              <button
                type="button"
                disabled={starting}
                onClick={() => void accept()}
                data-testid="space-rail-accept-schedule"
                className="shrink-0 rounded-[4px] font-medium text-text-secondary outline-none transition-colors duration-150 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/60 disabled:text-text-muted"
              >
                Accept
              </button>
            </>
          )}
        </div>
      </div>
    </li>
  );
}

function subClass(tone: 'bad' | 'warn' | undefined): string {
  return tone === 'bad' ? 'text-danger' : tone === 'warn' ? 'text-warning' : 'text-text-muted';
}

/** How many of the view's items wait on the person looking. */
function viewBadge(view: ViewManifest | undefined, viewerId: string | null): string | null {
  const count = view ? viewCountFor(view, viewerId) : 0;
  return count > 0 ? String(count) : null;
}

function tabKey(tab: ArtefactTab): string {
  if (tab.kind === 'view') return `view:${tab.name}`;
  if (tab.kind === 'session') return `session:${tab.sessionId}`;
  if (tab.kind === 'page') return `page:${tab.url}`;
  return tab.kind === 'focus' ? 'focus' : `file:${tab.path}`;
}

function tabIcon(tab: ArtefactTab, view: ViewManifest | undefined) {
  if (tab.kind === 'view') return <ViewIcon view={view} className="size-3.5" strokeWidth={1.7} />;
  const Icon =
    tab.kind === 'session'
        ? Terminal
        : tab.kind === 'page'
          ? Globe
          : tab.kind === 'focus'
            ? Rows3
            : FileText;
  return <Icon className="size-3.5" strokeWidth={1.7} />;
}

function tabTitle(tab: ArtefactTab): string {
  if (tab.kind === 'page') return tab.title;
  if (tab.kind === 'focus') return 'Focus';
  if (tab.kind === 'file') return tab.path.split('/').pop() ?? tab.path;
  return '';
}

function tabSub(tab: ArtefactTab): string {
  if (tab.kind === 'file') return tab.path.split('/').slice(-2, -1)[0] ?? 'file';
  if (tab.kind === 'page') return 'page';
  if (tab.kind === 'session') return 'Only you see it';
  return 'your working set';
}

function RailRow({
  active,
  icon,
  title,
  sub,
  fresh,
  badge,
  tone,
  live,
  tooltip,
  arrived,
  onSelect,
  onClose,
  closeLabel = 'Close tab',
  onRename,
}: {
  active: boolean;
  icon: React.ReactNode;
  title: React.ReactNode;
  sub: string;
  /** How old what the row shows is ("3m"). It sits at the row's right edge when nothing waits on the person. */
  fresh?: string;
  badge?: string | null;
  /** The second line says something is wrong (a failed refresh) or off (stale data). */
  tone?: 'bad' | 'warn';
  /** Something is going on: the status grid shows at the right. */
  live?: Matrix;
  /** Sentences on how fresh the row is and when it runs next; each takes a line beside the row. */
  tooltip?: string;
  /** The row just appeared: it pops in. */
  arrived?: boolean;
  onSelect: () => void;
  onClose?: () => void;
  closeLabel?: string;
  /** A double-click on the title edits it in place; this takes the new one. */
  onRename?: (title: string) => void;
}) {
  // Renaming: the title becomes a field. Enter or clicking away keeps it, Escape leaves it.
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  const commit = () => {
    const next = draft?.trim() ?? '';
    setDraft(null);
    if (next && next !== (typeof title === 'string' ? title : '')) onRename?.(next);
  };
  // One slot at the right edge, so every row ends on the same line: the status grid while
  // something is going, else what waits on the person, else how fresh the row is. Close takes
  // the slot's place while the row is pointed at, so nothing moves.
  const trailing = live ? (
    <DotMatrix state={live.state} tone={live.tone} size="sm" />
  ) : badge ? (
    <span className="h-[18px] min-w-[18px] rounded-full bg-accent-subtle px-[5px] text-center text-2xs leading-[18px] font-semibold text-accent tabular-nums">
      {badge}
    </span>
  ) : fresh ? (
    <span className="text-2xs text-text-muted tabular-nums">{fresh}</span>
  ) : null;
  const lines = tooltip
    ? tooltip
        .split(/(?<=\.)\s+/)
        .map((line) => line.replace(/\.$/, ''))
        .filter(Boolean)
    : [];
  const Main = editing ? 'div' : 'button';
  const row = (
    <div
      className={cn(
        'group relative flex items-center rounded-lg border transition-colors duration-150',
        arrived && 'card-pop-in',
        active
          ? 'border-accent/30 bg-bg-2 text-text-primary'
          : 'border-transparent text-text-secondary hover:bg-bg-2/60 hover:text-text-primary'
      )}
    >
      <Main
        {...(editing
          ? {}
          : { type: 'button' as const, role: 'tab', 'aria-selected': active, onClick: onSelect })}
        onDoubleClick={
          onRename && typeof title === 'string' && !editing ? () => setDraft(title) : undefined
        }
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg py-[7px] pr-2.5 pl-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <span
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-[7px] transition-colors duration-150',
            active ? 'bg-accent-subtle text-accent' : 'bg-bg-1 text-text-muted'
          )}
        >
          {icon}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          {editing ? (
            <input
              autoFocus
              value={draft}
              maxLength={60}
              aria-label="Tab name"
              data-testid="space-tab-rename"
              onChange={(event) => setDraft(event.target.value)}
              onFocus={(event) => event.target.select()}
              onBlur={commit}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') commit();
                if (event.key === 'Escape') setDraft(null);
              }}
              className="-mx-1 w-[calc(100%+0.5rem)] rounded-[5px] bg-bg-0 px-1 text-sm leading-tight font-medium text-text-primary ring-1 ring-accent/60 outline-none"
            />
          ) : (
            <span className="truncate text-sm leading-tight font-medium">{title}</span>
          )}
          {sub && (
            <span className={cn('truncate text-2xs leading-tight', subClass(tone))}>{sub}</span>
          )}
        </span>
        {trailing && (
          <span
            className={cn(
              'flex min-w-5 shrink-0 items-center justify-end transition-opacity duration-150',
              onClose && 'group-focus-within:opacity-0 group-hover:opacity-0'
            )}
          >
            {trailing}
          </span>
        )}
      </Main>
      {onClose && !editing && (
        <button
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          title={closeLabel}
          // On its own backing, with a soft edge to its left, so it reads over a long title.
          className="absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center rounded-control bg-bg-3 text-text-secondary opacity-0 shadow-[-10px_0_10px_-2px_var(--bg-2)] transition-[opacity,background-color,color,transform] duration-150 ease-out group-hover:opacity-100 hover:text-text-primary hover:brightness-125 focus-visible:opacity-100 active:scale-[0.94]"
        >
          <X className="size-3.5" strokeWidth={2} />
        </button>
      )}
    </div>
  );
  if (lines.length === 0 || editing) return row;
  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipContent side="right" sideOffset={10} className="bg-bg-2 py-1.5 backdrop-blur-none">
        <span className="flex flex-col gap-0.5 text-left">
          {lines.map((line, index) => (
            <span key={line} className={index > 0 ? 'text-text-muted' : undefined}>
              {line}
            </span>
          ))}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
