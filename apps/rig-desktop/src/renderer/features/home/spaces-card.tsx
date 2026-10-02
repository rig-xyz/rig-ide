import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FolderInput, FolderSearch, LogOut, MoreHorizontal, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  getReadMarkersVersion,
  readSpaceMarker,
  subscribeReadMarkers,
  writeLastSeen,
  writeOpenedAt,
} from '@renderer/features/spaces/room-read-marker';
import { useNotificationSummary, useSpaceNotifications } from '@renderer/features/notifications/use-notifications';
import { directPhrase, type RigNotificationSpaceSummary } from '@shared/rig/notifications';
import { newGroupId, type HomeGroup } from '@shared/rig/home-layout';
import { NeedsConnection } from '@renderer/features/shell/needs-connection';
import { requestRoomTheme } from '@renderer/features/spaces/room-theme-request';
import { useSyncHealth } from '@renderer/features/spaces/use-sync-health';
import { rpc } from '@renderer/lib/ipc';
import { markJustAttachedSyncing } from '@renderer/lib/just-attached';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { Popover } from '@renderer/lib/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import type { RigRecentTheme } from '@shared/rig/recent-themes';
import type { SpaceSetup } from '@shared/rig/space-setup';
import { deriveDeleteRigMode, deriveRigMenuLabel } from '@shared/rig/delete-rig';
import { describeSyncHealth } from '@shared/rig/sync-health';
import type { RigSpaceStatus } from '@shared/rig/space-status';
import { DeleteRigDialog } from './delete-rig-dialog';
import { NEEDS_CONNECTION_TOOLTIP } from './home-connection';
import {
  canAutoJoin,
  deriveRelayOnlyRowStatus,
  NOT_SET_UP_TOOLTIP,
  SPACE_NOT_SET_UP_TOOLTIP,
  type HomeRigRow,
} from './home-sections';
import { RenameRigDialog } from './rename-rig-dialog';
import {
  baselineMarker,
  deriveSpaceAttention,
  withNotifications,
  deriveSpaceRowLine,
  filterSpaceRows,
  lastActivityAt,
  readPinnedSpaceIds,
  SPACE_FILTER_LABELS,
  sortSpaceRowsByActivity,
  spaceIsActive,
  spaceNeedsApproval,
  writePinnedSpaceIds,
  type SpaceAttention,
  type SpaceRowFilter,
} from './space-status-state';
import { SpaceStatusTile } from './space-status-tile';
import { FloatingCard } from './floating-card';
import {
  buildSpaceSections,
  groupOfSpace,
  nextGroupName,
  type SpaceSection,
  type SpaceSignals,
} from './space-sections';
import {
  GroupBothOffer,
  insideSubmenu,
  MenuCheckRow,
  NewGroupButton,
  QuietFold,
  SectionHeader,
  SpacesViewMenu,
  SubmenuItem,
} from './spaces-card-sections';
import { useHomeLayout } from './use-home-layout';

const FACES_MAX = 3;

/**
 * The Spaces floating card (design doc "9a" — "spaces first"): a
 * filter/pin-aware list of every space this account is a member of, in
 * sections ("Many spaces on Home" v1: the person's own groups, or by state,
 * or one list; `space-sections.ts`), arranged from the header's ⋯ and kept
 * on their account (`use-home-layout.ts`). Each
 * row leading with its own live `SpaceStatusTile`, `# name`, the muted
 * status line in words, and member faces on the right. Sourced from the
 * SAME `HomeRigRow[]` Home already builds (`buildHomeRigRows`, filtered to
 * `isSpace`) so a space's local-vs-relay-only distinction and its existing
 * open/download/locate/rename/hide/delete actions carry over unchanged —
 * only the row's own look and its live status are new here.
 */
export function SpacesCard({
  rows,
  settingUp = [],
  onOpenSetup,
  statusByBinding,
  selfUserId,
  topicByBinding,
  openOnTopic = false,
  onOpenPath,
  highlightBindingId,
  offline = false,
  offlineActivity,
  emptyHint,
}: {
  rows: readonly HomeRigRow[];
  /** New spaces still being set up (or that failed to), listed first until they're real rows. */
  settingUp?: readonly SpaceSetup[];
  /** Opens a setting-up space's Room. */
  onOpenSetup?: (id: string) => void;
  statusByBinding: ReadonlyMap<string, RigSpaceStatus>;
  selfUserId: string | null;
  /** Each space's most active Room theme of the last 24h; its name leads the row's status line. */
  topicByBinding?: ReadonlyMap<string, RigRecentTheme>;
  /** Room themes is on: opening a row with a topic opens its Room on that theme. */
  openOnTopic?: boolean;
  onOpenPath: (path: string) => void;
  highlightBindingId?: string | null;
  /**
   * The relay is out of reach: rows come from this computer, show no live
   * status, and actions that need the relay are disabled.
   */
  offline?: boolean;
  /** Offline only: each space's last activity from local data (`offlineLastActivity`). */
  offlineActivity?: ReadonlyMap<string, number | null>;
  /** Replaces the empty card's line (e.g. while the list is still loading). */
  emptyHint?: string;
}) {
  const [filter, setFilter] = useState<SpaceRowFilter>('all');
  const [quietOpen, setQuietOpen] = useState(false);
  // Groups made here since Home opened stay on screen while still empty, so they can be filled.
  const [madeHere, setMadeHere] = useState<ReadonlySet<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragItem | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const [offer, setOffer] = useState<[string, string] | null>(null);
  // No "+ New" of its own: Home's "New space" pill floats right above this
  // card (`new-space-cta.tsx`) and is the one create/join entry point.
  const { pinned, toggle: togglePinned } = useSpacePins();
  const { layout, dispatch } = useHomeLayout();
  const summary = useNotificationSummary();
  const liveAttention = useSpaceAttention(rows, statusByBinding, selfUserId);
  // Offline: no live status at all — each row is idle as of its last local activity.
  const attentionByBinding: Map<string, SpaceAttention> = offline
    ? new Map(rows.map((r) => [r.bindingId, { kind: 'idle', lastActivityAt: offlineActivity?.get(r.bindingId) ?? null }]))
    : liveAttention;

  const now = Date.now();
  // `sortSpaceRowsByActivity` needs a non-null `name` for its final
  // alphabetical tiebreak — a space almost always has one (required at
  // creation), so "Untitled space" only ever shows for an old/odd row.
  const named = rows.map((r) => ({ ...r, name: r.name ?? 'Untitled space' }));
  const signals = spaceSignalsOf(named, {
    statusByBinding,
    selfUserId,
    summarySpaces: summary.spaces,
    localActivity: offlineActivity,
    offline,
  });
  const needsYouIds = new Set([...signals].filter(([, s]) => s.needsYou).map(([id]) => id));
  const filterCtx = { statusByBinding, pinnedIds: pinned, selfUserId, needsYouIds };
  const filtered = filterSpaceRows(named, filter, filterCtx);
  const recentOrder = new Map(
    sortSpaceRowsByActivity(filtered, statusByBinding, attentionByBinding, selfUserId, now, offlineActivity).map(
      (r, i) => [r.bindingId, i]
    )
  );
  const view = buildSpaceSections({ rows: filtered, layout, signals, pinned, recentOrder, now, keepVisible: madeHere });
  const needsYouCount = filterSpaceRows(named, 'needsYou', filterCtx).length;
  const nameOf = new Map(named.map((r) => [r.bindingId, r.name]));
  const customGroups = layout.groupBy === 'custom';
  const highlightFolded = view.folded.some((r) => r.bindingId === highlightBindingId);
  const anyShown = view.sections.some((s) => s.visible && s.rows.length > 0) || view.folded.length > 0;

  const makeGroup = (spaces: string[] = []) => {
    const id = newGroupId();
    dispatch({ type: 'createGroup', id, name: nextGroupName(layout), spaces });
    setMadeHere((prev) => new Set(prev).add(id));
    setRenamingId(id);
  };
  const moveTo = (bindingId: string, groupId: string | null) => dispatch({ type: 'moveSpace', bindingId, groupId });
  const endDrag = () => {
    setDrag(null);
    setDropKey(null);
  };

  /** Drop targets: a group or Ungrouped takes a dragged space; a group's header takes a dragged group. */
  const dropProps = (section: SpaceSection<HomeRigRow & { name: string }>) => {
    if (!customGroups || section.kind === 'state' || section.kind === 'all') return {};
    const accepts = (d: DragItem | null) =>
      d?.kind === 'space' ? d.groupId !== (section.groupId ?? null) : d?.kind === 'group' && section.kind === 'group' && d.id !== section.groupId;
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!accepts(drag)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (dropKey !== section.key) setDropKey(section.key);
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null) && dropKey === section.key) setDropKey(null);
      },
      onDrop: (e: React.DragEvent) => {
        if (!drag || !accepts(drag)) return;
        e.preventDefault();
        if (drag.kind === 'space') moveTo(drag.bindingId, section.groupId ?? null);
        else dispatch({ type: 'reorderGroup', id: drag.id, toIndex: layout.groups.findIndex((g) => g.id === section.groupId) });
        endDrag();
      },
    };
  };

  const renderRow = (row: HomeRigRow & { name: string }) => {
    const groupId = groupOfSpace(layout, row.bindingId);
    return (
      <SpaceRow
        key={row.bindingId}
        row={row}
        status={statusByBinding.get(row.bindingId)}
        attention={attentionByBinding.get(row.bindingId) ?? { kind: 'idle', lastActivityAt: null }}
        topic={offline ? undefined : topicByBinding?.get(row.bindingId)}
        openOnTopic={openOnTopic}
        onOpenPath={onOpenPath}
        pinned={pinned.has(row.bindingId)}
        onTogglePinned={() => togglePinned(row.bindingId)}
        isHighlighted={row.bindingId === highlightBindingId}
        offline={offline}
        grouping={
          customGroups
            ? {
                groups: layout.groups,
                groupId,
                onMove: (to) => moveTo(row.bindingId, to),
                onNewGroup: () => makeGroup([row.bindingId]),
                dragging: drag?.kind === 'space' && drag.bindingId === row.bindingId,
                onDragStart: () => setDrag({ kind: 'space', bindingId: row.bindingId, groupId }),
                onDragEnd: endDrag,
                // One ungrouped space dropped on another: offer to group the two.
                acceptsPair: drag?.kind === 'space' && drag.groupId === null && groupId === null && drag.bindingId !== row.bindingId,
                onPairDrop: () => {
                  if (drag?.kind === 'space') setOffer([drag.bindingId, row.bindingId]);
                  endDrag();
                },
              }
            : undefined
        }
      />
    );
  };

  return (
    <FloatingCard
      storageKey="rig-home-spaces-collapsed"
      title="Spaces"
      count={rows.length + settingUp.length}
      headerAction={rows.length > 0 ? <SpacesViewMenu layout={layout} dispatch={dispatch} /> : undefined}
    >
      {settingUp.length > 0 && (
        <div className="flex flex-col gap-1">
          {settingUp.map((setup) => (
            <SettingUpRow key={setup.id} setup={setup} onOpen={() => onOpenSetup?.(setup.id)} />
          ))}
        </div>
      )}
      {rows.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-0.5">
          {(Object.keys(SPACE_FILTER_LABELS) as SpaceRowFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                'rounded-chip border px-2 py-0.5 text-xs transition-colors',
                filter === f
                  ? 'bg-accent-subtle text-accent border-transparent'
                  : 'border-border-hairline text-text-muted hover:text-text-primary hover:border-border-strong'
              )}
            >
              {SPACE_FILTER_LABELS[f]}
              {f === 'needsYou' && needsYouCount > 0 && ` · ${needsYouCount}`}
            </button>
          ))}
        </div>
      )}
      {offer && nameOf.has(offer[0]) && nameOf.has(offer[1]) && (
        <GroupBothOffer
          names={[nameOf.get(offer[0])!, nameOf.get(offer[1])!]}
          onAccept={() => {
            makeGroup(offer);
            setOffer(null);
          }}
          onDismiss={() => setOffer(null)}
        />
      )}
      {rows.length === 0 ? (
        settingUp.length === 0 && (
          <p className="text-text-muted px-1 text-xs">{emptyHint ?? 'A space for your team and your agents.'}</p>
        )
      ) : !anyShown && !view.sections.some((s) => s.visible && s.kind === 'group') ? (
        <p className="text-text-muted px-1 text-xs">No spaces match this filter.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {view.sections.map((section) => {
            // While a grouped space is dragged, Ungrouped shows even when empty, as a place to drop it.
            const dropHere = section.kind === 'ungrouped' && drag?.kind === 'space' && drag.groupId !== null;
            if (!section.visible && !dropHere) return null;
            const hasHighlight = section.rows.some((r) => r.bindingId === highlightBindingId);
            const collapsed = section.collapsed && !hasHighlight;
            const group = section.kind === 'group' ? section.groupId! : null;
            return (
              <div
                key={section.key}
                className={cn('flex flex-col gap-1 rounded-control', dropKey === section.key && 'bg-accent-subtle')}
                data-testid="space-section"
                data-section={section.key}
                data-kind={section.kind}
                {...dropProps(section)}
              >
                {section.title !== null && (
                  <SectionHeader
                    title={section.title}
                    count={section.rows.length}
                    collapsed={collapsed}
                    onToggle={() =>
                      group
                        ? dispatch({ type: 'setGroupCollapsed', id: group, collapsed: !section.collapsed })
                        : dispatch({ type: 'setSectionCollapsed', key: section.key, collapsed: !section.collapsed })
                    }
                    group={
                      group
                        ? {
                            renaming: renamingId === group,
                            onRenameStart: () => setRenamingId(group),
                            onRenameDone: (name) => {
                              setRenamingId(null);
                              if (name !== null) dispatch({ type: 'renameGroup', id: group, name });
                            },
                            onDelete: () => dispatch({ type: 'deleteGroup', id: group }),
                            onDragStart: () => setDrag({ kind: 'group', id: group }),
                            onDragEnd: endDrag,
                          }
                        : undefined
                    }
                  />
                )}
                {!collapsed && section.rows.map(renderRow)}
              </div>
            );
          })}
          {view.folded.length > 0 && (
            <>
              <QuietFold
                count={view.folded.length}
                open={quietOpen || highlightFolded}
                onToggle={() => setQuietOpen((o) => !o)}
              />
              {(quietOpen || highlightFolded) && view.folded.map(renderRow)}
            </>
          )}
        </div>
      )}
      {rows.length > 0 && customGroups && <NewGroupButton onClick={() => makeGroup()} />}
    </FloatingCard>
  );
}

type DragItem = { kind: 'space'; bindingId: string; groupId: string | null } | { kind: 'group'; id: string };

/** Each space's needs-you / live / last-activity signals, for grouping by state and folding quiet spaces. */
function spaceSignalsOf(
  rows: readonly HomeRigRow[],
  ctx: {
    statusByBinding: ReadonlyMap<string, RigSpaceStatus>;
    selfUserId: string | null;
    summarySpaces: readonly RigNotificationSpaceSummary[];
    localActivity?: ReadonlyMap<string, number | null>;
    offline: boolean;
  }
): Map<string, SpaceSignals> {
  const notifications = new Map(ctx.summarySpaces.map((s) => [s.bindingId, s]));
  // The relay sends status for a capped number of spaces: once any has
  // loaded, a space without one goes by this computer's activity alone.
  const statusLoaded = ctx.offline || ctx.statusByBinding.size > 0;
  return new Map(
    rows.map((row) => {
      const status = ctx.statusByBinding.get(row.bindingId);
      const n = notifications.get(row.bindingId);
      const relayAt = lastActivityAt(status);
      const localAt = ctx.localActivity?.get(row.bindingId) ?? null;
      return [
        row.bindingId,
        {
          needsYou:
            spaceNeedsApproval(status, ctx.selfUserId) || (n !== undefined && n.level !== 'nothing' && n.directUnread > 0),
          live: spaceIsActive(status),
          lastActivityAt: relayAt === null && localAt === null ? null : Math.max(relayAt ?? 0, localAt ?? 0),
          known: statusLoaded,
        },
      ];
    })
  );
}

/**
 * A new space still being set up in the background (instant new space):
 * the dot matrix's "starting" ripple and "Setting up…", or why it
 * couldn't be. Clicking opens its Room, where Retry and "Remove it" are.
 */
function SettingUpRow({ setup, onOpen }: { setup: SpaceSetup; onOpen: () => void }) {
  const failed = setup.status === 'failed';
  return (
    <button
      type="button"
      onClick={onOpen}
      className="hover:bg-bg-2 flex items-center gap-2.5 rounded-control px-2 py-2 text-left transition-colors"
      data-testid="space-setup-row"
      data-status={setup.status}
    >
      {/* Same tile as a live row's `SpaceStatusTile`. */}
      <span className="bg-bg-2 inline-flex shrink-0 items-center justify-center rounded-control p-1.5" aria-hidden>
        <DotMatrix state={failed ? 'failed' : 'starting'} size="md" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col items-start">
        <span className="flex min-w-0 items-center gap-1">
          <span className="text-text-muted font-mono text-sm">#</span>
          <span className="text-text-primary truncate text-sm">{setup.name}</span>
        </span>
        <span className={cn('truncate text-xs', failed ? 'text-danger' : 'text-text-muted')}>
          {failed ? 'Couldn’t finish setting up' : 'Setting up…'}
        </span>
      </span>
    </button>
  );
}

/**
 * Each row's "what you missed" (`deriveSpaceAttention`), read against the
 * Room's own per-space read markers — re-read whenever one changes, so
 * coming back from a space shows it cleared. A space this device has no
 * marker for yet gets one set to "now" (`baselineMarker`): what happened
 * before Home first saw it isn't news.
 */
function useSpaceAttention(
  rows: readonly HomeRigRow[],
  statusByBinding: ReadonlyMap<string, RigSpaceStatus>,
  selfUserId: string | null
): Map<string, SpaceAttention> {
  useSyncExternalStore(subscribeReadMarkers, getReadMarkersVersion);
  useEffect(() => {
    for (const status of statusByBinding.values()) {
      const baseline = baselineMarker(status, readSpaceMarker(status.bindingId), Date.now());
      if (baseline?.lastSeenSeq !== undefined) writeLastSeen(status.bindingId, baseline.lastSeenSeq);
      if (baseline?.openedAt !== undefined) writeOpenedAt(status.bindingId, baseline.openedAt);
    }
  }, [statusByBinding]);
  return new Map(
    rows.map((row) => [
      row.bindingId,
      deriveSpaceAttention(statusByBinding.get(row.bindingId), readSpaceMarker(row.bindingId), selfUserId),
    ])
  );
}

const LINE_TONE = {
  danger: 'text-danger',
  secondary: 'text-text-secondary',
  muted: 'text-text-muted',
} as const;

/** Pinned spaces — purely local display state (design doc: "pin with ★ remembered locally"). */
function useSpacePins(): { pinned: ReadonlySet<string>; toggle: (bindingId: string) => void } {
  const [pinned, setPinned] = useState<Set<string>>(() => readPinnedSpaceIds());
  const toggle = (bindingId: string) => {
    setPinned((current) => {
      const next = new Set(current);
      if (next.has(bindingId)) next.delete(bindingId);
      else next.add(bindingId);
      writePinnedSpaceIds(next);
      return next;
    });
  };
  return { pinned, toggle };
}

function useSpaceMembers(bindingId: string) {
  const query = useQuery({
    queryKey: ['rig', 'spacesConnection', 'listMembers', bindingId],
    queryFn: () => rpc.rig.spacesConnection.listMembers({ bindingId }),
    staleTime: 60_000,
  });
  return query.data?.success ? query.data.data : [];
}

/** A space's member faces (first few, then "+N"). */
function Faces({ bindingId }: { bindingId: string }) {
  const members = useSpaceMembers(bindingId);
  if (members.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center">
      {members.slice(0, FACES_MAX).map((m, i) => (
        <IdentityAvatar
          key={m.userId}
          name={m.name ?? m.email}
          avatarUrl={m.avatarUrl}
          sizeClassName="size-5"
          textClassName="text-2xs"
          className={cn('ring-bg-1 ring-1', i > 0 && '-ml-1.5')}
        />
      ))}
      {members.length > FACES_MAX && (
        <span className="bg-bg-2 text-text-muted ring-bg-1 text-2xs -ml-1.5 flex size-5 shrink-0 items-center justify-center rounded-full ring-1">
          +{members.length - FACES_MAX}
        </span>
      )}
    </span>
  );
}

function SpaceRow({
  row,
  status,
  attention: baseAttention,
  topic,
  openOnTopic,
  onOpenPath,
  pinned,
  onTogglePinned,
  isHighlighted,
  offline,
  grouping,
}: {
  row: HomeRigRow;
  status: RigSpaceStatus | undefined;
  attention: SpaceAttention;
  topic?: RigRecentTheme;
  openOnTopic: boolean;
  onOpenPath: (path: string) => void;
  pinned: boolean;
  onTogglePinned: () => void;
  isHighlighted: boolean;
  offline: boolean;
  /** Custom groups only: drag the row to a group, or move it from its menu. */
  grouping?: RowGrouping;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Notifications fold into the row's own dice and line ("Hugo mentioned
  // you"), not a badge of their own; a muted space reads quiet and dimmed.
  const notifications = useSpaceNotifications(row.bindingId);
  const shown = withNotifications(
    baseAttention,
    status,
    notifications,
    notifications.latestDirect ? { phrase: directPhrase(notifications.latestDirect) } : null
  );
  // One line, the highest rung of the ladder wins (`deriveSpaceRowLine`); the
  // topic leads only new or today's activity. Rung 1, sync, is `syncLine` below.
  const line = deriveSpaceRowLine({ status, attention: shown, topic: topic?.name, now: Date.now() });
  const statusLine = line.text;
  const dimmed = notifications.level === 'nothing';
  const path = row.kind === 'local' ? row.path : null;
  const relayStatus = row.kind === 'relayOnly' ? deriveRelayOnlyRowStatus(row) : null;
  const openablePath = path ?? (relayStatus?.kind === 'localPath' ? relayStatus.path : null);
  // Not syncing on this computer (starting, paused, stopped, failing): the
  // status line says so, with the fix. Any row with a folder here, whether
  // opened through the app or only found for its binding.
  const sync = useSyncHealth(openablePath);
  const syncNotice = describeSyncHealth(sync.health);
  // Lane J: a joined-but-not-downloaded space is no dead end — clicking the
  // row downloads it (the menu's "Download") and opens it. An unrecognized
  // role can't auto-join, so that row still only offers ⋯ → Locate.
  const canDownload = row.kind === 'relayOnly' && relayStatus?.kind === 'notSetUp' && canAutoJoin(row.role);
  // Downloading needs the relay: offline, the row stays but can't be clicked.
  const downloadable = canDownload && !offline;

  const download = async () => {
    if (row.kind !== 'relayOnly') return;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.rig.join.attach({ bindingId: row.bindingId, name: row.name });
      if (!result.success) {
        setError(result.error.message);
        return;
      }
      markJustAttachedSyncing(result.data.localPath, result.data.syncing);
      onOpenPath(result.data.localPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set up the space locally.');
    } finally {
      setBusy(false);
    }
  };

  const locate = async () => {
    if (row.kind !== 'relayOnly') return;
    setBusy(true);
    setError(null);
    try {
      const picked = await rpc.app.openSelectDirectoryDialog({
        title: 'Locate this space',
        message: `Pick the folder where "${row.name}" already lives`,
      });
      if (!picked) return;
      const result = await rpc.rig.join.locate({ bindingId: row.bindingId, dir: picked });
      if (!result.success) {
        setError(result.error.message);
        return;
      }
      onOpenPath(result.data.localPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't open the folder picker.");
    } finally {
      setBusy(false);
    }
  };

  const notSetUpTooltip =
    canDownload && offline ? NEEDS_CONNECTION_TOOLTIP : downloadable ? SPACE_NOT_SET_UP_TOOLTIP : NOT_SET_UP_TOOLTIP;

  const subtext = busy
    ? 'Downloading…'
    : relayStatus?.kind === 'checking'
      ? 'checking…'
      : statusLine;
  // Rung 1: the sync state takes the line over the row's activity; a
  // download or the "checking…" beat still come first.
  const syncLine = subtext === statusLine ? syncNotice : null;

  return (
    <div
      className={cn(
        'group flex items-center gap-2.5 rounded-control px-2 py-2',
        isHighlighted ? 'bg-accent-subtle transition-colors' : 'glass-hover',
        grouping?.dragging && 'opacity-50'
      )}
      data-testid="space-row"
      data-binding-id={row.bindingId}
      data-offline={offline || undefined}
      draggable={grouping ? true : undefined}
      onDragStart={
        grouping
          ? (e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', row.name ?? row.bindingId);
              grouping.onDragStart();
            }
          : undefined
      }
      onDragEnd={grouping?.onDragEnd}
      onDragOver={
        grouping?.acceptsPair
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = 'move';
            }
          : undefined
      }
      onDrop={
        grouping?.acceptsPair
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              grouping.onPairDrop();
            }
          : undefined
      }
    >
      <SpaceStatusTile
        attention={shown}
        seed={row.bindingId}
        className={cn(offline && 'opacity-50')}
      />
      {/* The name button stretches over the whole column (its `before:`
          layer), so clicking the status line opens the row too; only the
          line's own action sits above it. */}
      <div className="relative flex min-w-0 flex-1 flex-col items-start">
        <button
          type="button"
          onClick={() => {
            if (!openablePath && !downloadable) return;
            if (topic && openOnTopic) requestRoomTheme(row.bindingId, topic.themeId);
            if (openablePath) onOpenPath(openablePath);
            else void download();
          }}
          disabled={busy || (!openablePath && !downloadable)}
          aria-busy={busy || undefined}
          className="flex max-w-full min-w-0 items-center gap-1 text-left before:absolute before:inset-0 before:content-[''] disabled:cursor-default"
          data-testid="space-row-name"
        >
          <span className="text-text-muted font-mono text-sm">#</span>
          <span className={cn('truncate text-sm', dimmed ? 'text-text-muted' : 'text-text-primary')}>
            {row.name}
          </span>
          {pinned && <Star className="text-text-muted size-3 shrink-0 fill-current" strokeWidth={1.5} />}
          {relayStatus?.kind === 'notSetUp' && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span aria-label={notSetUpTooltip} tabIndex={0} className="text-text-muted relative inline-flex">
                    <FolderSearch className="size-3 shrink-0" strokeWidth={1.5} />
                  </span>
                }
              />
              <TooltipContent side="top">{notSetUpTooltip}</TooltipContent>
            </Tooltip>
          )}
        </button>
        {error ? (
          <span className="text-danger max-w-full truncate text-xs" title={error}>
            {error}
          </span>
        ) : syncLine ? (
          <span
            role="status"
            title={syncLine.detail ? `${syncLine.text}\n${syncLine.detail}` : syncLine.text}
            className={cn(
              'flex max-w-full min-w-0 items-center gap-1 text-xs',
              sync.health?.state === 'starting'
                ? 'text-text-muted'
                : syncLine.tone === 'bad'
                  ? 'text-danger'
                  : 'text-warning'
            )}
            data-testid="space-status-line"
            data-sync-state={sync.health?.state}
          >
            <span className="min-w-0 truncate">{syncLine.line}</span>
            {syncLine.action && (
              <>
                <span aria-hidden className="shrink-0">
                  ·
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void sync.start();
                  }}
                  className="focus-visible:outline-accent relative shrink-0 rounded-control font-medium underline-offset-2 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                  data-testid="sync-health-action"
                >
                  {syncLine.action}
                </button>
              </>
            )}
          </span>
        ) : (
          <span
            className={cn(
              // `max-w-full`: the column is `items-start`, so without it a long
              // line ("Hugo mentioned you · 4 new messages") outgrows the row
              // instead of truncating.
              'max-w-full truncate text-xs',
              subtext === statusLine ? LINE_TONE[line.tone] : 'text-text-muted'
            )}
            data-testid="space-status-line"
          >
            {subtext}
          </span>
        )}
      </div>
      <Faces bindingId={row.bindingId} />
      <SpaceRowMenu
        row={row}
        pinned={pinned}
        onTogglePinned={onTogglePinned}
        busy={busy}
        onDownload={() => void download()}
        onLocate={() => void locate()}
        offline={offline}
        grouping={grouping}
      />
    </div>
  );
}

type RowGrouping = {
  groups: readonly HomeGroup[];
  /** The row's group, or null when ungrouped. */
  groupId: string | null;
  onMove: (groupId: string | null) => void;
  /** A new group holding just this space. */
  onNewGroup: () => void;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  /** Another ungrouped space is being dragged over this ungrouped one. */
  acceptsPair: boolean;
  onPairDrop: () => void;
};

function SpaceRowMenu({
  row,
  pinned,
  onTogglePinned,
  busy,
  onDownload,
  onLocate,
  offline,
  grouping,
}: {
  row: HomeRigRow;
  pinned: boolean;
  onTogglePinned: () => void;
  busy: boolean;
  onDownload: () => void;
  onLocate: () => void;
  offline: boolean;
  grouping?: RowGrouping;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const closeMenu = useCallback(() => {
    setOpen(false);
    setMoveOpen(false);
  }, []);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const deleteMode = deriveDeleteRigMode(row.role);
  const path = row.kind === 'local' ? row.path : null;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['rig', 'recent', 'list'] });
    void queryClient.invalidateQueries({ queryKey: ['rig', 'account', 'workspaces'] });
  };

  return (
    <>
      {path && (
        <RenameRigDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          bindingId={row.bindingId}
          path={path}
          currentName={row.name}
          onRenamed={refresh}
        />
      )}
      <DeleteRigDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        bindingId={row.bindingId}
        path={path}
        name={row.name}
        role={row.role}
        noun="space"
        onDeleted={refresh}
      />
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More actions for "${row.name ?? row.bindingId}"`}
        className={cn(
          'text-text-muted hover:text-text-primary focus-visible:outline-accent rounded-control flex shrink-0 items-center justify-center p-1 transition-opacity focus-visible:outline-2 focus-visible:outline-offset-2',
          // Out of the layout until the row is hovered or focused (or its
          // menu is open), so the faces sit flush right at rest.
          busy
            ? 'pointer-events-none opacity-50'
            : open
              ? 'flex'
              : 'hidden group-focus-within:flex group-hover:flex'
        )}
      >
        <MoreHorizontal className="size-3.5" strokeWidth={1.5} />
      </button>
      <Popover
        anchor={triggerRef}
        open={open}
        onClose={closeMenu}
        role="menu"
        gap={4}
        estimatedWidth={170}
        minWidth={170}
        keepOpenOn={insideSubmenu}
      >
        {row.kind === 'relayOnly' && canAutoJoin(row.role) && (
          <NeedsConnection blocked={offline} className="block w-full cursor-not-allowed">
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={offline}
              onClick={() => {
                setOpen(false);
                onDownload();
              }}
              className="hover:bg-bg-2 flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-text-primary disabled:pointer-events-none disabled:opacity-50"
            >
              <Download className="size-3.5 shrink-0" strokeWidth={1.5} />
              Download
            </button>
          </NeedsConnection>
        )}
        {row.kind === 'relayOnly' && (
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              setOpen(false);
              onLocate();
            }}
            className="hover:bg-bg-2 flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-text-primary"
          >
            <FolderSearch className="size-3.5 shrink-0" strokeWidth={1.5} />
            Locate…
          </button>
        )}
        {path && (
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              setOpen(false);
              setRenameOpen(true);
            }}
            className="hover:bg-bg-2 flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-text-primary"
          >
            <Pencil className="size-3.5 shrink-0" strokeWidth={1.5} />
            Rename…
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          onClick={() => {
            setOpen(false);
            onTogglePinned();
          }}
          className="hover:bg-bg-2 flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-text-primary"
        >
          <Star className={cn('size-3.5 shrink-0', pinned && 'fill-current')} strokeWidth={1.5} />
          {pinned ? 'Unpin' : 'Pin'}
        </button>
        {grouping && (
          <SubmenuItem
            label="Move to group…"
            open={moveOpen}
            onOpenChange={setMoveOpen}
            icon={<FolderInput className="size-3.5 shrink-0" strokeWidth={1.5} />}
          >
            <MenuCheckRow
              label="No group"
              checked={grouping.groupId === null}
              onSelect={() => {
                closeMenu();
                grouping.onMove(null);
              }}
            />
            {grouping.groups.map((g) => (
              <MenuCheckRow
                key={g.id}
                label={g.name}
                checked={grouping.groupId === g.id}
                onSelect={() => {
                  closeMenu();
                  grouping.onMove(g.id);
                }}
              />
            ))}
            <div className="border-border-hairline my-1 border-t" />
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                closeMenu();
                grouping.onNewGroup();
              }}
              className="hover:bg-bg-2 flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-text-primary"
            >
              <Plus className="size-3.5 shrink-0" strokeWidth={1.5} />
              New group
            </button>
          </SubmenuItem>
        )}
        <div className="border-border-hairline my-1 border-t" />
        <NeedsConnection blocked={offline} className="block w-full cursor-not-allowed">
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={offline}
            onClick={() => {
              setOpen(false);
              setDeleteOpen(true);
            }}
            className="hover:bg-danger/10 text-danger flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm disabled:pointer-events-none disabled:opacity-50"
          >
            {deleteMode === 'leave' ? (
              <LogOut className="size-3.5 shrink-0" strokeWidth={1.5} />
            ) : (
              <Trash2 className="size-3.5 shrink-0" strokeWidth={1.5} />
            )}
            {deriveRigMenuLabel(deleteMode, 'space')}
          </button>
        </NeedsConnection>
      </Popover>
    </>
  );
}
