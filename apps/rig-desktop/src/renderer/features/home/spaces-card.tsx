import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FolderSearch, LogOut, MoreHorizontal, Pencil, Star, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  getReadMarkersVersion,
  readSpaceMarker,
  subscribeReadMarkers,
  writeLastSeen,
  writeOpenedAt,
} from '@renderer/features/spaces/room-read-marker';
import { useSpaceNotifications } from '@renderer/features/notifications/use-notifications';
import { directPhrase } from '@shared/rig/notifications';
import { NeedsConnection } from '@renderer/features/shell/needs-connection';
import { rpc } from '@renderer/lib/ipc';
import { markJustAttachedSyncing } from '@renderer/lib/just-attached';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { Popover } from '@renderer/lib/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import type { SpaceSetup } from '@shared/rig/space-setup';
import { deriveDeleteRigMode, deriveRigMenuLabel } from '@shared/rig/delete-rig';
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
  countNeedsApproval,
  deriveSpaceAttention,
  withNotifications,
  deriveSpaceStatusLine,
  filterSpaceRows,
  readPinnedSpaceIds,
  SPACE_FILTER_LABELS,
  sortSpaceRowsByActivity,
  spaceStatusLineTone,
  writePinnedSpaceIds,
  type SpaceAttention,
  type SpaceRowFilter,
} from './space-status-state';
import { SpaceStatusTile } from './space-status-tile';
import { FloatingCard } from './floating-card';

const SHOWN_CAP = 6;
const FACES_MAX = 3;

/**
 * The Spaces floating card (design doc "9a" — "spaces first"): a
 * filter/pin-aware list of every space this account is a member of, each
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
  const [showAll, setShowAll] = useState(false);
  // No "+ New" of its own: Home's "New space" pill floats right above this
  // card (`new-space-cta.tsx`) and is the one create/join entry point.
  const { pinned, toggle: togglePinned } = useSpacePins();
  const liveAttention = useSpaceAttention(rows, statusByBinding, selfUserId);
  // Offline: no live status at all — each row is idle as of its last local activity.
  const attentionByBinding: Map<string, SpaceAttention> = offline
    ? new Map(rows.map((r) => [r.bindingId, { kind: 'idle', lastActivityAt: offlineActivity?.get(r.bindingId) ?? null }]))
    : liveAttention;

  const now = Date.now();
  const filtered = filterSpaceRows(rows, filter, {
    statusByBinding,
    pinnedIds: pinned,
    selfUserId,
  });
  const sorted = sortSpaceRowsByActivity(
    // `sortSpaceRowsByActivity` needs a non-null `name` for its final
    // alphabetical tiebreak — a space almost always has one (required at
    // creation), so "Untitled space" only ever shows for an old/odd row.
    filtered.map((r) => ({ ...r, name: r.name ?? 'Untitled space' })),
    statusByBinding,
    attentionByBinding,
    selfUserId,
    now,
    offlineActivity
  );
  const visible = showAll ? sorted : sorted.slice(0, SHOWN_CAP);
  const needsYouCount = countNeedsApproval(rows, statusByBinding, selfUserId);

  return (
    <FloatingCard
      storageKey="rig-home-spaces-collapsed"
      title="Spaces"
      count={rows.length + settingUp.length}
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
      {rows.length === 0 ? (
        settingUp.length === 0 && (
          <p className="text-text-muted px-1 text-xs">{emptyHint ?? 'A space for your team and your agents.'}</p>
        )
      ) : visible.length === 0 ? (
        <p className="text-text-muted px-1 text-xs">No spaces match this filter.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {visible.map((row) => (
            <SpaceRow
              key={row.bindingId}
              row={row}
              status={statusByBinding.get(row.bindingId)}
              attention={attentionByBinding.get(row.bindingId) ?? { kind: 'idle', lastActivityAt: null }}
              onOpenPath={onOpenPath}
              pinned={pinned.has(row.bindingId)}
              onTogglePinned={() => togglePinned(row.bindingId)}
              isHighlighted={row.bindingId === highlightBindingId}
              offline={offline}
            />
          ))}
        </div>
      )}
      {!showAll && sorted.length > SHOWN_CAP && (
        <div className="flex items-center justify-between px-1">
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="text-text-muted hover:text-text-primary text-xs transition-colors"
          >
            Show all {sorted.length}
          </button>
          <span className="text-text-muted text-xs">Sorted by activity</span>
        </div>
      )}
    </FloatingCard>
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
  onOpenPath,
  pinned,
  onTogglePinned,
  isHighlighted,
  offline,
}: {
  row: HomeRigRow;
  status: RigSpaceStatus | undefined;
  attention: SpaceAttention;
  onOpenPath: (path: string) => void;
  pinned: boolean;
  onTogglePinned: () => void;
  isHighlighted: boolean;
  offline: boolean;
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
  const statusLine = deriveSpaceStatusLine(status, shown, Date.now());
  const dimmed = notifications.level === 'nothing';
  const path = row.kind === 'local' ? row.path : null;
  const relayStatus = row.kind === 'relayOnly' ? deriveRelayOnlyRowStatus(row) : null;
  const openablePath = path ?? (relayStatus?.kind === 'localPath' ? relayStatus.path : null);
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

  return (
    <div
      className={cn(
        'group flex items-center gap-2.5 rounded-control px-2 py-2 transition-colors',
        isHighlighted ? 'bg-accent-subtle' : 'hover:bg-bg-2'
      )}
      data-testid="space-row"
      data-offline={offline || undefined}
    >
      <SpaceStatusTile
        attention={shown}
        seed={row.bindingId}
        className={cn(offline && 'opacity-50')}
      />
      <button
        type="button"
        onClick={() => (openablePath ? onOpenPath(openablePath) : downloadable ? void download() : undefined)}
        disabled={busy || (!openablePath && !downloadable)}
        aria-busy={busy || undefined}
        className="flex min-w-0 flex-1 flex-col items-start text-left disabled:cursor-default"
      >
        <span className="flex min-w-0 items-center gap-1">
          <span className="text-text-muted font-mono text-sm">#</span>
          <span className={cn('truncate text-sm', dimmed ? 'text-text-muted' : 'text-text-primary')}>
            {row.name}
          </span>
          {pinned && <Star className="text-text-muted size-3 shrink-0 fill-current" strokeWidth={1.5} />}
          {relayStatus?.kind === 'notSetUp' && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span aria-label={notSetUpTooltip} tabIndex={0} className="text-text-muted inline-flex">
                    <FolderSearch className="size-3 shrink-0" strokeWidth={1.5} />
                  </span>
                }
              />
              <TooltipContent side="top">{notSetUpTooltip}</TooltipContent>
            </Tooltip>
          )}
        </span>
        {error ? (
          <span className="text-danger max-w-full truncate text-xs" title={error}>
            {error}
          </span>
        ) : (
          <span
            className={cn(
              // `max-w-full`: the column is `items-start`, so without it a long
              // line ("Hugo mentioned you · 4 new messages") outgrows the row
              // instead of truncating.
              'max-w-full truncate text-xs',
              subtext === statusLine ? LINE_TONE[spaceStatusLineTone(shown)] : 'text-text-muted'
            )}
            data-testid="space-status-line"
          >
            {subtext}
          </span>
        )}
      </button>
      <Faces bindingId={row.bindingId} />
      <SpaceRowMenu
        row={row}
        pinned={pinned}
        onTogglePinned={onTogglePinned}
        busy={busy}
        onDownload={() => void download()}
        onLocate={() => void locate()}
        offline={offline}
      />
    </div>
  );
}

function SpaceRowMenu({
  row,
  pinned,
  onTogglePinned,
  busy,
  onDownload,
  onLocate,
  offline,
}: {
  row: HomeRigRow;
  pinned: boolean;
  onTogglePinned: () => void;
  busy: boolean;
  onDownload: () => void;
  onLocate: () => void;
  offline: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
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
      <Popover anchor={triggerRef} open={open} onClose={() => setOpen(false)} role="menu" gap={4} estimatedWidth={170} minWidth={170}>
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
