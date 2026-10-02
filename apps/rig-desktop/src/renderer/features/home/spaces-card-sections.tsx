import { Check, ChevronRight, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Popover } from '@renderer/lib/ui/popover';
import type { ContextMenuPoint } from '@renderer/lib/ui/popover-types';
import { cn } from '@renderer/lib/utils';
import type {
  HomeGroupBy,
  HomeLayout,
  HomeLayoutAction,
  HomeSortBy,
} from '@shared/rig/home-layout';

/**
 * The Spaces card's own controls for "Many spaces on Home" v1: the header
 * menu (group by, sort by, show quiet, show empty groups), a section's
 * header (collapse, rename, delete, drag to reorder), "+ New group", the
 * offer to group two spaces dropped on each other, and the quiet fold.
 * The rows themselves stay in `spaces-card.tsx`.
 */

/** Marks a submenu's popover, so pressing inside it doesn't close the menu it opened from. */
const SUBMENU_CLASS = 'home-spaces-submenu';
export const insideSubmenu = (target: Element): boolean =>
  target.closest(`.${SUBMENU_CLASS}`) !== null;

const ITEM =
  'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-text-primary hover:bg-bg-2 outline-none focus-visible:bg-bg-2';

/** A radio or checkbox row with the app's check glyph (same look as the Rigs card's menu). */
export function MenuCheckRow({
  label,
  checked,
  onSelect,
  role = 'menuitemradio',
}: {
  label: string;
  checked: boolean;
  onSelect: () => void;
  role?: 'menuitemradio' | 'menuitemcheckbox';
}) {
  return (
    <button
      type="button"
      role={role}
      tabIndex={-1}
      aria-checked={checked}
      onClick={onSelect}
      className={ITEM}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {checked && <Check className="size-3" strokeWidth={1.5} />}
      </span>
      {label}
    </button>
  );
}

/**
 * A menu row that opens a submenu beside it ("Group by ›"), on hover, click
 * or →. The submenu is its own popover, marked so its parent stays open
 * (`insideSubmenu`); the parent passes `keepOpenOn={insideSubmenu}`.
 */
export function SubmenuItem({
  label,
  open,
  onOpenChange,
  icon,
  children,
}: {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  icon?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [point, setPoint] = useState<ContextMenuPoint | null>(null);
  // Held in a ref so `close` stays one function: the popover re-runs its focus and dismissal setup when it changes.
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const show = () => {
    if (open) return;
    const rect = ref.current?.getBoundingClientRect();
    if (rect) setPoint({ x: rect.right, y: rect.top - 4 });
    onOpenChange(true);
  };
  const close = useCallback(() => onOpenChangeRef.current(false), []);
  return (
    <>
      <button
        ref={ref}
        type="button"
        role="menuitem"
        tabIndex={-1}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={show}
        onMouseEnter={show}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') {
            e.preventDefault();
            show();
          }
        }}
        className={ITEM}
      >
        {icon ?? <span className="size-3.5 shrink-0" />}
        <span className="flex-1">{label}</span>
        <ChevronRight className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />
      </button>
      {point && (
        <Popover
          anchor={point}
          open={open}
          onClose={close}
          role="menu"
          gap={0}
          estimatedWidth={180}
          minWidth={180}
          className={SUBMENU_CLASS}
        >
          {children}
        </Popover>
      )}
    </>
  );
}

const GROUP_BY_LABELS: Record<HomeGroupBy, string> = {
  custom: 'Custom groups',
  state: 'State',
  none: 'None',
};
const SORT_BY_LABELS: Record<HomeSortBy, string> = { recent: 'Recent activity', name: 'Name' };

/** The ⋯ on the Spaces card's header. */
export function SpacesViewMenu({
  layout,
  dispatch,
}: {
  layout: HomeLayout;
  dispatch: (action: HomeLayoutAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<'group' | 'sort' | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    setSub(null);
  }, []);
  const pick = (action: HomeLayoutAction) => {
    dispatch(action);
    close();
  };
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Arrange spaces"
        className="flex items-center justify-center rounded-control p-1 text-text-muted transition-colors hover:text-text-primary"
        data-testid="spaces-view-menu"
      >
        <MoreHorizontal className="size-3.5" strokeWidth={1.5} />
      </button>
      <Popover
        anchor={triggerRef}
        open={open}
        onClose={close}
        role="menu"
        align="right"
        gap={4}
        estimatedWidth={200}
        minWidth={200}
        keepOpenOn={insideSubmenu}
      >
        <SubmenuItem
          label="Group by"
          open={sub === 'group'}
          onOpenChange={(o) => setSub(o ? 'group' : null)}
        >
          {(Object.keys(GROUP_BY_LABELS) as HomeGroupBy[]).map((groupBy) => (
            <MenuCheckRow
              key={groupBy}
              label={GROUP_BY_LABELS[groupBy]}
              checked={layout.groupBy === groupBy}
              onSelect={() => pick({ type: 'setGroupBy', groupBy })}
            />
          ))}
        </SubmenuItem>
        <SubmenuItem
          label="Sort by"
          open={sub === 'sort'}
          onOpenChange={(o) => setSub(o ? 'sort' : null)}
        >
          {(Object.keys(SORT_BY_LABELS) as HomeSortBy[]).map((sortBy) => (
            <MenuCheckRow
              key={sortBy}
              label={SORT_BY_LABELS[sortBy]}
              checked={layout.sortBy === sortBy}
              onSelect={() => pick({ type: 'setSortBy', sortBy })}
            />
          ))}
        </SubmenuItem>
        <div className="my-1 border-t border-border-hairline" onMouseEnter={() => setSub(null)} />
        <div onMouseEnter={() => setSub(null)}>
          <MenuCheckRow
            role="menuitemcheckbox"
            label="Show quiet spaces"
            checked={layout.showQuiet}
            onSelect={() => pick({ type: 'setShowQuiet', value: !layout.showQuiet })}
          />
          <MenuCheckRow
            role="menuitemcheckbox"
            label="Show empty groups"
            checked={layout.showEmptyGroups}
            onSelect={() => pick({ type: 'setShowEmptyGroups', value: !layout.showEmptyGroups })}
          />
        </div>
      </Popover>
    </>
  );
}

/** A name field for a group: Enter or leaving it saves, Escape keeps the old name. */
export function GroupNameInput({
  initial,
  onDone,
}: {
  initial: string;
  /** `null` when cancelled. */
  onDone: (name: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      ref={ref}
      value={value}
      maxLength={80}
      aria-label="Group name"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(value);
        else if (e.key === 'Escape') finish(null);
      }}
      onBlur={() => finish(value)}
      onClick={(e) => e.stopPropagation()}
      className="min-w-0 flex-1 rounded-control border border-border-hairline bg-bg-2 px-1.5 py-0.5 text-xs text-text-primary outline-none"
    />
  );
}

/**
 * A section's header: the collapse arrow, its name and count. A group's
 * also renames (double-click or its ⋯), deletes, and drags to reorder.
 */
export function SectionHeader({
  title,
  count,
  collapsed,
  onToggle,
  group,
}: {
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  group?: {
    renaming: boolean;
    onRenameStart: () => void;
    onRenameDone: (name: string | null) => void;
    onDelete: () => void;
    onDragStart: () => void;
    onDragEnd: () => void;
  };
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  return (
    <div
      className="group/header flex h-6 items-center gap-1 px-1"
      draggable={group && !group.renaming ? true : undefined}
      onDragStart={
        group
          ? (e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', title);
              group.onDragStart();
            }
          : undefined
      }
      onDragEnd={group?.onDragEnd}
      data-testid="space-section-header"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
        className="flex shrink-0 items-center justify-center rounded-control p-0.5 text-text-muted hover:text-text-primary"
      >
        <ChevronRight
          className={cn('size-3 transition-transform', !collapsed && 'rotate-90')}
          strokeWidth={1.5}
        />
      </button>
      {group?.renaming ? (
        <GroupNameInput initial={title} onDone={group.onRenameDone} />
      ) : (
        <button
          type="button"
          onClick={onToggle}
          onDoubleClick={group?.onRenameStart}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span className="truncate text-xs font-medium text-text-secondary">{title}</span>
          <span className="text-xs text-text-muted">{count}</span>
        </button>
      )}
      {group && !group.renaming && (
        <>
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`More actions for group "${title}"`}
            className={cn(
              'text-text-muted hover:text-text-primary rounded-control shrink-0 items-center justify-center p-0.5',
              menuOpen ? 'flex' : 'hidden group-focus-within/header:flex group-hover/header:flex'
            )}
          >
            <MoreHorizontal className="size-3.5" strokeWidth={1.5} />
          </button>
          <Popover
            anchor={triggerRef}
            open={menuOpen}
            onClose={closeMenu}
            role="menu"
            gap={4}
            estimatedWidth={170}
            minWidth={170}
          >
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                setMenuOpen(false);
                group.onRenameStart();
              }}
              className={ITEM}
            >
              <Pencil className="size-3.5 shrink-0" strokeWidth={1.5} />
              Rename
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                setMenuOpen(false);
                group.onDelete();
              }}
              className={cn(ITEM, 'text-danger hover:bg-danger/10')}
            >
              <Trash2 className="size-3.5 shrink-0" strokeWidth={1.5} />
              Delete group
            </button>
          </Popover>
        </>
      )}
    </div>
  );
}

export function NewGroupButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-fit items-center gap-1 px-1 text-xs text-text-muted transition-colors hover:text-text-primary"
      data-testid="new-group"
    >
      <Plus className="size-3" strokeWidth={1.5} />
      New group
    </button>
  );
}

/** Shown after one ungrouped space is dropped on another. */
export function GroupBothOffer({
  names,
  onAccept,
  onDismiss,
}: {
  names: [string, string];
  onAccept: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded-control bg-bg-2 px-2 py-1.5 text-xs"
      role="group"
      aria-label="Start a group"
      data-testid="group-both-offer"
    >
      <span className="min-w-0 flex-1 truncate text-text-secondary">
        Group {names[0]} and {names[1]}?
      </span>
      <button
        type="button"
        onClick={onAccept}
        className="shrink-0 font-medium text-accent hover:underline"
      >
        Make group
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 text-text-muted hover:text-text-primary"
      >
        Not now
      </button>
    </div>
  );
}

/** "22 quiet spaces ▸": the spaces with nothing new in 14 days, folded into one line. */
export function QuietFold({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex w-fit items-center gap-1 px-1 text-xs text-text-muted transition-colors hover:text-text-primary"
      data-testid="quiet-fold"
    >
      {count === 1 ? '1 quiet space' : `${count} quiet spaces`}
      <ChevronRight
        className={cn('size-3 transition-transform', open && 'rotate-90')}
        strokeWidth={1.5}
      />
    </button>
  );
}
