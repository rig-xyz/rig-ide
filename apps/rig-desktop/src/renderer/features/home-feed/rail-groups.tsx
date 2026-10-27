import { ChevronDown, Plus, X } from 'lucide-react';
import { Fragment, type ReactNode, useMemo, useState } from 'react';
import {
  buildSpaceSections,
  nextGroupName,
  type SpaceSignals,
} from '@renderer/features/home/space-sections';
import { useHomeLayout } from '@renderer/features/home/use-home-layout';
import { cn } from '@renderer/lib/utils';
import { type HomeLayout, newGroupId } from '@shared/rig/home-layout';
import type { RailSpace } from './model';

/**
 * The rail's spaces in your groups: the same groups as the Spaces card on
 * the current Home (`@shared/rig/home-layout`, kept on your account), so
 * both Homes show one arrangement. A group folds under its header; drag a
 * space onto a header to move it there; double-click a group's name to
 * rename it. Spaces only the Feed knows about (the preview's demo ones)
 * have no binding and sit in Ungrouped.
 */

export const SPACE_DRAG_TYPE = 'application/x-rig-space';

type Row = { bindingId: string; name: string; space: RailSpace };

export function SpaceGroups({
  spaces,
  collapsed,
  renderSpace,
}: {
  spaces: readonly RailSpace[];
  collapsed: boolean;
  renderSpace: (space: RailSpace) => ReactNode;
}) {
  const { layout, dispatch } = useHomeLayout();
  const [madeHere, setMadeHere] = useState<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);

  const view = useMemo(() => {
    const rows: Row[] = spaces.map((space) => ({
      bindingId: space.bindingId ?? space.id,
      name: space.name,
      space,
    }));
    const signals = new Map<string, SpaceSignals>(
      rows.map(({ bindingId, space }) => [
        bindingId,
        {
          needsYou: space.sessions.some((s) => s.state === 'needs_you'),
          live: space.sessions.some((s) => s.state === 'running' || s.state === 'starting'),
          lastActivityAt: space.lastActivityAt ?? null,
          known: false,
        },
      ])
    );
    return buildSpaceSections({
      rows,
      layout,
      signals,
      pinned: new Set(),
      recentOrder: new Map(rows.map((r, i) => [r.bindingId, i])),
      now: Date.now(),
      keepVisible: madeHere,
    });
  }, [spaces, layout, madeHere]);

  const sections = view.sections.filter((s) => s.visible);

  const createGroup = () => {
    const id = newGroupId();
    dispatch({ type: 'createGroup', id, name: nextGroupName(layout) });
    setMadeHere((prev) => new Set(prev).add(id));
    setRenaming(id);
  };

  // Folded to icons, the rail lists every space in your order, with no headers to fold.
  if (collapsed) {
    return (
      <>
        {[...sections.flatMap((section) => section.rows), ...view.folded].map((row) =>
          renderSpace(row.space)
        )}
      </>
    );
  }

  return (
    <>
      {sections.map((section) => (
        <Fragment key={section.key}>
          {section.title && (
            <GroupHeader
              title={section.title}
              count={section.rows.length}
              folded={section.collapsed}
              renaming={renaming === section.groupId}
              dropping={dropOn === section.key}
              onToggle={() =>
                section.groupId
                  ? dispatch({
                      type: 'setGroupCollapsed',
                      id: section.groupId,
                      collapsed: !section.collapsed,
                    })
                  : dispatch({
                      type: 'setSectionCollapsed',
                      key: section.key,
                      collapsed: !section.collapsed,
                    })
              }
              onRename={section.groupId ? () => setRenaming(section.groupId!) : undefined}
              onRenamed={(name) => {
                if (section.groupId && name)
                  dispatch({ type: 'renameGroup', id: section.groupId, name });
                setRenaming(null);
              }}
              onDelete={
                section.groupId
                  ? () => dispatch({ type: 'deleteGroup', id: section.groupId! })
                  : undefined
              }
              canDrop={section.kind === 'group' || section.kind === 'ungrouped'}
              onDragState={(over) => setDropOn(over ? section.key : null)}
              onDropSpace={(bindingId) => {
                setDropOn(null);
                dispatch({ type: 'moveSpace', bindingId, groupId: section.groupId ?? null });
              }}
            />
          )}
          {!section.collapsed && section.rows.map((row) => renderSpace(row.space))}
        </Fragment>
      ))}
      {view.folded.map((row) => renderSpace(row.space))}
      {canGroup(layout) && (
        <button
          type="button"
          onClick={createGroup}
          className="hf-nudge group mt-2 flex h-8 items-center gap-2 rounded-[9px] pl-2.5 text-meta text-text-muted transition-colors hover:bg-bg-2 hover:text-text-primary"
        >
          <Plus className="size-3.5 transition-transform group-hover:rotate-90" strokeWidth={2} />
          New group
        </button>
      )}
    </>
  );
}

function canGroup(layout: HomeLayout): boolean {
  return layout.groupBy === 'custom';
}

function GroupHeader({
  title,
  count,
  folded,
  renaming,
  dropping,
  onToggle,
  onRename,
  onRenamed,
  onDelete,
  canDrop,
  onDragState,
  onDropSpace,
}: {
  title: string;
  count: number;
  folded: boolean;
  renaming: boolean;
  dropping: boolean;
  onToggle: () => void;
  onRename?: () => void;
  /** The new name, or null when it didn't change. */
  onRenamed: (name: string | null) => void;
  onDelete?: () => void;
  canDrop: boolean;
  onDragState: (over: boolean) => void;
  onDropSpace: (bindingId: string) => void;
}) {
  const dropProps = canDrop
    ? {
        onDragOver: (e: React.DragEvent) => {
          if (!e.dataTransfer.types.includes(SPACE_DRAG_TYPE)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          onDragState(true);
        },
        onDragLeave: () => onDragState(false),
        onDrop: (e: React.DragEvent) => {
          const id = e.dataTransfer.getData(SPACE_DRAG_TYPE);
          if (id) onDropSpace(id);
        },
      }
    : {};
  return (
    <div
      {...dropProps}
      className={cn(
        'group/header mt-2.5 flex h-7 items-center rounded-[8px] pr-1 transition-[background-color,box-shadow]',
        dropping && 'bg-accent-subtle shadow-[inset_0_0_0_1px_var(--accent)]'
      )}
    >
      {renaming ? (
        <input
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- a group's name is edited the moment it's made or double-clicked
          autoFocus
          defaultValue={title}
          aria-label="Group name"
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            const name = e.currentTarget.value.trim();
            onRenamed(name && name !== title ? name : null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') e.currentTarget.value = title;
            if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
          }}
          className="ml-1 h-6 min-w-0 flex-1 rounded-[6px] border border-accent bg-bg-1 px-1.5 text-ui font-medium text-text-primary outline-none"
        />
      ) : (
        <button
          type="button"
          aria-expanded={!folded}
          onClick={onToggle}
          onDoubleClick={onRename}
          title={onRename ? 'Double-click to rename' : undefined}
          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-[8px] pl-1.5 text-left text-ui font-medium text-text-secondary transition-colors hover:text-text-primary"
        >
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 text-text-muted transition-transform duration-200',
              folded && '-rotate-90'
            )}
            strokeWidth={2}
          />
          <span className="truncate">{title}</span>
          <span className="text-text-muted">{count}</span>
        </button>
      )}
      {onDelete && !renaming && (
        <button
          type="button"
          aria-label={`Ungroup ${title}`}
          title="Ungroup: its spaces go back to Ungrouped"
          onClick={onDelete}
          className="grid size-6 shrink-0 place-items-center rounded-[6px] text-text-muted opacity-0 transition-opacity group-hover/header:opacity-100 hover:bg-bg-2 hover:text-text-primary focus-visible:opacity-100"
        >
          <X className="size-3.5" strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
