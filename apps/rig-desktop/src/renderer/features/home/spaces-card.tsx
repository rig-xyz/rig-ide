import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FolderSearch, LogOut, MoreHorizontal, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { markJustAttachedSyncing } from '@renderer/lib/just-attached';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { Popover } from '@renderer/lib/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { deriveDeleteRigMode, deriveRigMenuLabel } from '@shared/rig/delete-rig';
import type { RigSpaceStatus } from '@shared/rig/space-status';
import { DeleteRigDialog } from './delete-rig-dialog';
import {
  canAutoJoin,
  deriveRelayOnlyRowStatus,
  NOT_SET_UP_TOOLTIP,
  type HomeRigRow,
} from './home-sections';
import { RenameRigDialog } from './rename-rig-dialog';
import {
  countNeedsApproval,
  deriveSpaceStatusLine,
  filterSpaceRows,
  readPinnedSpaceIds,
  SPACE_FILTER_LABELS,
  sortSpaceRowsByActivity,
  writePinnedSpaceIds,
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
  statusByBinding,
  selfUserId,
  onOpenPath,
  onCreateSpace,
  highlightBindingId,
}: {
  rows: readonly HomeRigRow[];
  statusByBinding: ReadonlyMap<string, RigSpaceStatus>;
  selfUserId: string | null;
  onOpenPath: (path: string) => void;
  onCreateSpace: (name: string) => Promise<string | null>;
  highlightBindingId?: string | null;
}) {
  const [filter, setFilter] = useState<SpaceRowFilter>('all');
  const [showAll, setShowAll] = useState(false);
  const [naming, setNaming] = useState(false);
  const { pinned, toggle: togglePinned } = useSpacePins();

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
    selfUserId,
    now
  );
  const visible = showAll ? sorted : sorted.slice(0, SHOWN_CAP);
  const needsYouCount = countNeedsApproval(rows, statusByBinding, selfUserId);

  return (
    <FloatingCard
      storageKey="rig-home-spaces-collapsed"
      title="Spaces"
      count={rows.length}
      headerAction={
        <button
          type="button"
          onClick={() => setNaming(true)}
          className="bg-bg-2 text-text-muted hover:text-text-primary flex items-center gap-1 rounded-chip px-2 py-0.5 text-xs transition-colors"
        >
          <Plus className="size-3 shrink-0" strokeWidth={1.5} />
          New
        </button>
      }
    >
      {naming && (
        <NameSpaceInline
          onCreate={onCreateSpace}
          onDone={() => setNaming(false)}
        />
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
        <p className="text-text-muted px-1 text-xs">A room for your team and your agents.</p>
      ) : visible.length === 0 ? (
        <p className="text-text-muted px-1 text-xs">No spaces match this filter.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {visible.map((row) => (
            <SpaceRow
              key={row.bindingId}
              row={row}
              status={statusByBinding.get(row.bindingId)}
              onOpenPath={onOpenPath}
              pinned={pinned.has(row.bindingId)}
              onTogglePinned={() => togglePinned(row.bindingId)}
              isHighlighted={row.bindingId === highlightBindingId}
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

/** The inline "#name" compose row — ported from the pre-restructure `rigs-rail.tsx`'s own `SpacesGroup`, unchanged in behavior. */
function NameSpaceInline({
  onCreate,
  onDone,
}: {
  onCreate: (name: string) => Promise<string | null>;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = name.trim().replace(/^#+/, '');
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    const failure = await onCreate(trimmed);
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    onDone();
  };

  return (
    <div className="flex flex-col gap-1 px-0.5">
      <label className="border-border-hairline bg-bg-0 focus-within:border-accent flex h-8 items-center gap-1 rounded-control border px-2 transition-colors">
        <span className="font-mono text-sm text-text-muted">#</span>
        <input
          autoFocus
          value={name}
          disabled={busy}
          placeholder="growth-q3"
          aria-label="Space name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
            if (e.key === 'Escape') onDone();
          }}
          className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
        />
        {busy && <span className="text-2xs text-text-muted font-mono">creating…</span>}
      </label>
      {error && <p className="text-danger text-xs">{error}</p>}
    </div>
  );
}

function useSpaceMembers(bindingId: string) {
  const query = useQuery({
    queryKey: ['rig', 'spacesConnection', 'listMembers', bindingId],
    queryFn: () => rpc.rig.spacesConnection.listMembers({ bindingId }),
    staleTime: 60_000,
  });
  return query.data?.success ? query.data.data : [];
}

/** Exported for `across-your-spaces.tsx`'s own cards — same member-faces look, same query (react-query dedupes). */
export function Faces({ bindingId }: { bindingId: string }) {
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
  onOpenPath,
  pinned,
  onTogglePinned,
  isHighlighted,
}: {
  row: HomeRigRow;
  status: RigSpaceStatus | undefined;
  onOpenPath: (path: string) => void;
  pinned: boolean;
  onTogglePinned: () => void;
  isHighlighted: boolean;
}) {
  const statusLine = deriveSpaceStatusLine(status, Date.now());
  const path = row.kind === 'local' ? row.path : null;
  const relayStatus = row.kind === 'relayOnly' ? deriveRelayOnlyRowStatus(row) : null;
  const openablePath = path ?? (relayStatus?.kind === 'localPath' ? relayStatus.path : null);

  return (
    <div
      className={cn(
        'group flex items-center gap-2.5 rounded-control px-2 py-2 transition-colors',
        isHighlighted ? 'bg-accent-subtle' : 'hover:bg-bg-2'
      )}
    >
      <SpaceStatusTile status={status} />
      <button
        type="button"
        onClick={() => (openablePath ? onOpenPath(openablePath) : undefined)}
        disabled={!openablePath}
        title={openablePath ?? undefined}
        className="flex min-w-0 flex-1 flex-col items-start text-left disabled:cursor-default"
      >
        <span className="flex min-w-0 items-center gap-1">
          <span className="text-text-muted font-mono text-sm">#</span>
          <span className="text-text-primary truncate text-sm">{row.name}</span>
          {pinned && <Star className="text-text-muted size-3 shrink-0 fill-current" strokeWidth={1.5} />}
          {relayStatus?.kind === 'notSetUp' && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span aria-label={NOT_SET_UP_TOOLTIP} tabIndex={0} className="text-text-muted inline-flex">
                    <FolderSearch className="size-3 shrink-0" strokeWidth={1.5} />
                  </span>
                }
              />
              <TooltipContent side="top">{NOT_SET_UP_TOOLTIP}</TooltipContent>
            </Tooltip>
          )}
        </span>
        <span className="text-text-muted truncate text-xs">
          {relayStatus?.kind === 'checking' ? 'checking…' : statusLine}
        </span>
      </button>
      <Faces bindingId={row.bindingId} />
      <SpaceRowMenu row={row} pinned={pinned} onTogglePinned={onTogglePinned} onOpenPath={onOpenPath} />
    </div>
  );
}

function SpaceRowMenu({
  row,
  pinned,
  onTogglePinned,
  onOpenPath,
}: {
  row: HomeRigRow;
  pinned: boolean;
  onTogglePinned: () => void;
  onOpenPath: (path: string) => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const deleteMode = deriveDeleteRigMode(row.role);
  const path = row.kind === 'local' ? row.path : null;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['rig', 'recent', 'list'] });
    void queryClient.invalidateQueries({ queryKey: ['rig', 'account', 'workspaces'] });
  };

  const download = async () => {
    if (row.kind !== 'relayOnly') return;
    setOpen(false);
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
    setOpen(false);
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
          busy ? 'pointer-events-none opacity-50' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
        )}
      >
        <MoreHorizontal className="size-3.5" strokeWidth={1.5} />
      </button>
      <Popover anchor={triggerRef} open={open} onClose={() => setOpen(false)} role="menu" gap={4} estimatedWidth={170} minWidth={170}>
        {row.kind === 'relayOnly' && canAutoJoin(row.role) && (
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => void download()}
            className="hover:bg-bg-2 flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-text-primary"
          >
            <Download className="size-3.5 shrink-0" strokeWidth={1.5} />
            Download
          </button>
        )}
        {row.kind === 'relayOnly' && (
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => void locate()}
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
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          onClick={() => {
            setOpen(false);
            setDeleteOpen(true);
          }}
          className="hover:bg-danger/10 text-danger flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm"
        >
          {deleteMode === 'leave' ? (
            <LogOut className="size-3.5 shrink-0" strokeWidth={1.5} />
          ) : (
            <Trash2 className="size-3.5 shrink-0" strokeWidth={1.5} />
          )}
          {deriveRigMenuLabel(deleteMode)}
        </button>
      </Popover>
      {error && <p className="text-danger absolute -bottom-4 left-10 text-xs">{error}</p>}
    </>
  );
}
