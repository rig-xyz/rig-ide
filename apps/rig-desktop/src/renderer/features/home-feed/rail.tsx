import { ArrowLeftToLine, ArrowRightToLine, Home as HomeIcon, Lock } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { MAX_NEW_MESSAGES, type SpaceAttention } from '@renderer/features/home/space-status-state';
import { SpaceStatusTile } from '@renderer/features/home/space-status-tile';
import { cn } from '@renderer/lib/utils';
import { Count, Face, SessionMatrix, StatusWord } from './bits';
import { useHome } from './home-context';
import { type RailSession, type RailSpace, sessionLabelTone, sessionStatusWord } from './model';
import { SPACE_DRAG_TYPE, SpaceGroups } from './rail-groups';
import { needsYouPhrase } from './say';

/**
 * Left: what's being done. Home and Inbox, then each space and its sessions.
 * State lives on sessions only (a dot matrix and a few words); a space is a
 * name, a lock or faces, and an unread count. Collapsed to 68px, hovering an
 * entry shows a card with its one-line summary.
 */

type Peek = { el: HTMLElement; body: ReactNode };

export function Rail() {
  const { state, dispatch, spaces, counts, open, openInApp } = useHome();
  const collapsed = state.collapsed;
  const [peek, setPeek] = useState<Peek | null>(null);
  const selected =
    state.selection.kind === 'session' || state.selection.kind === 'space'
      ? state.selection.id
      : null;

  useEffect(() => {
    if (!collapsed) setPeek(null);
  }, [collapsed]);

  // A landing entry scrolls into view so the pulse is seen.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!state.landed) return;
    listRef.current
      ?.querySelector(`[data-rail-id="${CSS.escape(state.landed.id)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [state.landed]);

  const showPeek = (el: HTMLElement, body: ReactNode) => {
    if (collapsed) setPeek({ el, body });
  };

  const homeCurrent = state.selection.kind === 'home';

  return (
    <nav
      aria-label="Navigation"
      className={cn(
        'hf-rail relative grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden',
        collapsed ? 'w-[68px]' : 'w-[264px]'
      )}
      onMouseLeave={() => setPeek(null)}
      // Opening something closes its card.
      onClickCapture={() => setPeek(null)}
    >
      {/* The traffic lights sit here; the strip moves the window. */}
      <div aria-hidden className="h-[38px] [-webkit-app-region:drag]" />
      <div className="grid gap-0.5 px-3 pt-1 pb-1">
        <RailItem
          collapsed={collapsed}
          current={homeCurrent}
          icon={<HomeIcon className="size-[15px] text-text-secondary" strokeWidth={1.6} />}
          name="Home"
          label={counts.needsYou ? `Home, ${needsYouPhrase(counts.needsYou)}` : 'Home'}
          end={counts.needsYou ? <Count n={counts.needsYou} accent /> : null}
          onClick={() => open({ kind: 'home' })}
          onPeek={(el) =>
            showPeek(
              el,
              <PeekBody
                title="Home"
                text={`${needsYouPhrase(counts.needsYou)}, ${counts.upNext} up next.`}
              />
            )
          }
        />
      </div>
      <div
        ref={listRef}
        className="grid min-h-0 content-start gap-px overflow-x-hidden overflow-y-auto px-3 pt-2 pb-3"
      >
        <div
          className={cn(
            'flex h-[22px] items-center gap-1.5 py-1 pl-1.5 font-mono text-kicker font-medium tracking-[0.1em] whitespace-nowrap text-text-muted uppercase',
            collapsed && 'invisible'
          )}
        >
          Spaces
          <span className="tracking-normal text-text-muted/70">{spaces.length}</span>
        </div>
        <SpaceGroups
          spaces={spaces}
          collapsed={collapsed}
          renderSpace={(space) => (
            <SpaceEntry
              key={space.id}
              space={space}
              collapsed={collapsed}
              selected={selected}
              landed={state.landed}
              // A space opens in the app, its Room; a session of yours opens its chat.
              // What exists only in this preview (no folder on disk) opens its context here.
              onOpen={(target) => {
                if (space.root && (target.kind === 'space' || target.session.origin === 'real')) {
                  openInApp(
                    target.kind === 'space' ? { space } : { space, session: target.session }
                  );
                } else if (target.kind === 'space') open({ kind: 'space', id: space.id });
                else open({ kind: 'session', id: target.session.id });
              }}
              onPeek={showPeek}
            />
          )}
        />
      </div>
      <div className="px-3 py-2">
        <RailItem
          collapsed={collapsed}
          icon={
            collapsed ? (
              <ArrowRightToLine className="size-[15px] text-text-secondary" strokeWidth={1.6} />
            ) : (
              <ArrowLeftToLine className="size-[15px] text-text-secondary" strokeWidth={1.6} />
            )
          }
          name={collapsed ? 'Expand' : 'Collapse'}
          label={collapsed ? 'Expand' : 'Collapse'}
          ariaExpanded={!collapsed}
          onClick={() => dispatch({ type: 'collapse', value: !collapsed })}
        />
      </div>
      {peek && <HoverCard anchor={peek.el}>{peek.body}</HoverCard>}
    </nav>
  );
}

function SpaceEntry({
  space,
  collapsed,
  selected,
  landed,
  onOpen,
  onPeek,
}: {
  space: RailSpace;
  collapsed: boolean;
  selected: string | null;
  landed: { id: string; n: number } | null;
  onOpen: (target: { kind: 'space' } | { kind: 'session'; session: RailSession }) => void;
  onPeek: (el: HTMLElement, body: ReactNode) => void;
}) {
  // Unread shows on the tile; at the right, a lock or the faces.
  const end =
    space.visibility === 'private' ? (
      <Lock aria-label="Only you" className="size-[11px] text-text-muted" strokeWidth={2} />
    ) : space.faces.length ? (
      <span className="hf-stack flex">
        {space.faces.slice(0, 2).map((p) => (
          <Face key={p.id} person={p} />
        ))}
      </span>
    ) : null;
  return (
    <>
      <RailItem
        railId={space.id}
        label={`# ${space.name}${space.unread ? `, ${space.unread} unread` : ''}`}
        collapsed={collapsed}
        current={selected === space.id}
        ghost={space.fresh}
        landedKey={landed?.id === space.id ? landed.n : undefined}
        className="mt-1.5"
        dragId={space.bindingId}
        icon={<SpaceTile space={space} />}
        name={
          <>
            <i className="text-text-muted not-italic">#</i> {space.name}
          </>
        }
        bold
        end={end}
        onClick={() => onOpen({ kind: 'space' })}
        onPeek={(el) => onPeek(el, <PeekBody title={`# ${space.name}`} text={space.summary} />)}
      />
      {space.sessions.map((session) => (
        <SessionEntry
          key={session.id}
          space={space}
          session={session}
          ghost={space.fresh || session.fresh}
          collapsed={collapsed}
          current={selected === session.id}
          landedKey={landed?.id === session.id ? landed.n : undefined}
          onOpen={() => onOpen({ kind: 'session', session })}
          onPeek={onPeek}
        />
      ))}
    </>
  );
}

function SessionEntry({
  space,
  session,
  ghost,
  collapsed,
  current,
  landedKey,
  onOpen,
  onPeek,
}: {
  space: RailSpace;
  session: RailSession;
  /** Hidden until its copy lands (it, or the new space it's in). */
  ghost?: boolean;
  collapsed: boolean;
  current: boolean;
  landedKey?: number;
  onOpen: () => void;
  onPeek: (el: HTMLElement, body: ReactNode) => void;
}) {
  const tone = sessionLabelTone(session.state);
  const word = sessionStatusWord(session.state);
  return (
    <RailItem
      railId={session.id}
      label={`${session.name}, ${session.short}`}
      collapsed={collapsed}
      current={current}
      ghost={ghost}
      landedKey={landedKey}
      className="min-h-10"
      stem={!collapsed}
      icon={<SessionMatrix session={session} />}
      name={session.name}
      sub={
        <span
          className={cn(tone === 'warn' && 'text-status-warn', tone === 'ok' && 'text-status-ok')}
        >
          {session.short}
        </span>
      }
      onClick={onOpen}
      onPeek={(el) =>
        onPeek(
          el,
          <>
            <div className="flex items-center gap-2 font-semibold">
              <SessionMatrix session={session} size="sm" />
              <span className="min-w-0 truncate">{session.name}</span>
              <span className="ml-auto">
                <StatusWord {...word} />
              </span>
            </div>
            <p className="mt-1.5 text-sm text-text-secondary">{session.last.text}</p>
            <p className="mt-1.5 text-sm text-text-muted">
              #{space.name} · {session.last.ago}
            </p>
          </>
        )
      }
    />
  );
}

function RailItem({
  label,
  railId,
  collapsed,
  current,
  ghost,
  landedKey,
  icon,
  name,
  sub,
  end,
  collapsedBadge,
  bold,
  stem,
  className,
  ariaExpanded,
  dragId,
  onClick,
  onPeek,
}: {
  /** The entry's name for screen readers while collapsed, when only its icon shows. */
  label: string;
  railId?: string;
  collapsed: boolean;
  current?: boolean;
  ghost?: boolean;
  landedKey?: number;
  icon: ReactNode;
  name: ReactNode;
  sub?: ReactNode;
  end?: ReactNode;
  /** What the tile carries in a corner while the rail is collapsed. */
  collapsedBadge?: ReactNode;
  bold?: boolean;
  stem?: boolean;
  className?: string;
  ariaExpanded?: boolean;
  /** A space's binding id: it can be dragged onto a group. */
  dragId?: string;
  onClick: () => void;
  onPeek?: (el: HTMLElement) => void;
}) {
  const badge = collapsed ? (collapsedBadge ?? (end && isCount(end) ? end : null)) : null;
  return (
    <button
      type="button"
      data-rail-id={railId}
      aria-label={collapsed ? label : undefined}
      draggable={!!dragId}
      onDragStart={
        dragId
          ? (e) => {
              e.dataTransfer.setData(SPACE_DRAG_TYPE, dragId);
              e.dataTransfer.effectAllowed = 'move';
            }
          : undefined
      }
      aria-current={current ? 'page' : undefined}
      aria-expanded={ariaExpanded}
      onClick={onClick}
      onMouseEnter={(e) => onPeek?.(e.currentTarget)}
      onFocus={(e) => onPeek?.(e.currentTarget)}
      className={cn(
        'hf-rail-item relative grid min-h-9 w-full items-center gap-2 rounded-[9px] text-left',
        collapsed ? 'grid-cols-[36px] px-1' : 'grid-cols-[36px_minmax(0,1fr)_auto] pr-2 pl-1',
        current ? 'hf-rail-current bg-accent-subtle' : 'hover:bg-bg-2',
        ghost && 'invisible',
        className
      )}
    >
      {stem && <span aria-hidden className="hf-stem" />}
      <span
        key={landedKey}
        className={cn(
          'relative grid h-8 w-9 place-items-center',
          landedKey !== undefined && 'hf-landed'
        )}
      >
        {icon}
        {badge && <span className="absolute -top-1 -right-1">{badge}</span>}
      </span>
      {!collapsed && (
        <>
          <span className="min-w-0 whitespace-nowrap">
            <span className={cn('block truncate text-ui', bold ? 'font-semibold' : 'font-medium')}>
              {name}
            </span>
            {sub && <span className="-mt-px block truncate text-xs text-text-muted">{sub}</span>}
          </span>
          <span className="flex items-center gap-1">{end}</span>
        </>
      )}
    </button>
  );
}

function isCount(node: ReactNode): boolean {
  return typeof node === 'object' && node !== null && 'type' in node && node.type === Count;
}

function PeekBody({ title, text }: { title: string; text: string }) {
  return (
    <>
      <div className="flex items-center gap-2 font-semibold">{title}</div>
      <p className="mt-1.5 text-sm text-text-secondary">{text}</p>
    </>
  );
}

/** The collapsed rail's hover card, beside the entry it's about. */
function HoverCard({ anchor, children }: { anchor: HTMLElement; children: ReactNode }) {
  const r = anchor.getBoundingClientRect();
  const top = Math.max(8, Math.min(r.top - 6, window.innerHeight - 160));
  return (
    <div
      role="tooltip"
      style={{ left: r.right + 8, top }}
      className="popover-in pointer-events-none fixed z-50 w-[290px] rounded-[12px] border border-border-hairline bg-bg-1 px-3.5 py-3 text-chat shadow-float"
    >
      {children}
    </div>
  );
}

/**
 * A space's tile, the Spaces card's own (`SpaceStatusTile`): the motion of
 * whatever runs in it, new messages as dice, else its faint pattern; a dot
 * when something there is for you (accent) or unread (grey).
 */
function SpaceTile({ space }: { space: RailSpace }) {
  const live = space.sessions.find((s) => s.state === 'running' || s.state === 'needs_you');
  const attention: SpaceAttention = live
    ? {
        kind: 'live',
        state: live.state === 'needs_you' ? 'waiting' : (live.activity ?? 'thinking'),
      }
    : space.unread
      ? { kind: 'messages', count: Math.min(space.unread, MAX_NEW_MESSAGES), exact: true }
      : { kind: 'idle', lastActivityAt: null };
  const needsYou = space.sessions.some((s) => s.state === 'needs_you');
  return (
    <SpaceStatusTile
      attention={attention}
      seed={space.bindingId ?? space.id}
      size="sm"
      dot={needsYou ? 'forYou' : space.unread ? 'unread' : null}
      className="rounded-[7px]"
    />
  );
}
