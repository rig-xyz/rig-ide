import { Home as HomeIcon, Lock, PanelLeftClose, PanelLeftOpen, Settings } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { cn } from '@renderer/lib/utils';
import { Count, Face, IconButton, SessionMatrix, StatusWord } from './bits';
import { useHome } from './home-context';
import { type RailSession, type RailSpace, sessionLabelTone, sessionStatusWord } from './model';
import { SPACE_DRAG_TYPE, SpaceGroups } from './rail-groups';
import { needsYouPhrase } from './say';

/**
 * Left: what's being done. Home, then your spaces in your groups, each with
 * its sessions indented under it. State lives on sessions (a dot matrix and a
 * few words); a space is its name, bold while something in it is unread, and
 * a lock or faces. Folds from the toggle at the top (the same toggle the
 * Feed has on the right) to a strip where each busy space is a small group
 * of its sessions under a quiet #, the quiet spaces behind "+N";
 * hovering shows a card. You and Settings sit at the bottom.
 */

type Peek = { el: HTMLElement; body: ReactNode };

export interface RailYou {
  name: string | null;
  avatarUrl: string | null;
}

export function Rail({
  you,
  updateReady,
  onOpenSettings,
}: {
  you: RailYou;
  updateReady: boolean;
  onOpenSettings: (page?: 'account' | 'about') => void;
}) {
  const { state, dispatch, spaces, counts, open, openInApp } = useHome();
  const collapsed = state.collapsed;
  const [peek, setPeek] = useState<Peek | null>(null);
  const selected = state.selection.kind === 'session' ? state.selection.id : null;

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

  const quietCount = spaces.filter(isQuietSpace).length;

  const showPeek = (el: HTMLElement, body: ReactNode) => {
    if (collapsed) setPeek({ el, body });
  };
  const toggle = (
    <IconButton
      label={collapsed ? 'Open the sidebar' : 'Fold the sidebar'}
      dir={collapsed ? 'right' : 'left'}
      onClick={() => dispatch({ type: 'collapse', value: !collapsed })}
    >
      {collapsed ? (
        <PanelLeftOpen className="size-[15px]" strokeWidth={1.6} />
      ) : (
        <PanelLeftClose className="size-[15px]" strokeWidth={1.6} />
      )}
    </IconButton>
  );

  const openSpace = (space: RailSpace) => {
    // A space opens in the app, its Room. One that exists only in this preview opens its context here.
    if (space.root) openInApp({ space });
    else open({ kind: 'space', id: space.id });
  };
  const openSession = (space: RailSpace, session: RailSession) => {
    if (space.root && session.origin === 'real') openInApp({ space, session });
    else open({ kind: 'session', id: session.id });
  };

  return (
    <nav
      aria-label="Navigation"
      className={cn(
        'hf-rail relative grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden',
        collapsed ? 'w-[80px]' : 'w-[264px]'
      )}
      onMouseLeave={() => setPeek(null)}
      // Opening something closes its card.
      onClickCapture={() => setPeek(null)}
    >
      {/* The traffic lights sit at the left of this strip, which moves the window. */}
      {collapsed ? (
        <div className="grid [-webkit-app-region:drag]">
          <div className="h-10" />
          <div className="grid place-items-center pb-1">{toggle}</div>
        </div>
      ) : (
        <div className="flex h-10 items-center justify-end px-3 [-webkit-app-region:drag]">
          {toggle}
        </div>
      )}
      <div className={cn('pt-1 pb-1', collapsed ? 'px-[22px]' : 'px-3')}>
        <RailButton
          collapsed={collapsed}
          current={state.selection.kind === 'home'}
          label={counts.needsYou ? `Home, ${needsYouPhrase(counts.needsYou)}` : 'Home'}
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
          className={collapsed ? 'size-9 justify-center' : 'h-9 gap-2.5 pr-2 pl-2.5'}
        >
          <span className="relative grid place-items-center">
            <HomeIcon className="size-[15px] text-text-secondary" strokeWidth={1.6} />
            {collapsed && counts.needsYou > 0 && (
              <Count n={counts.needsYou} accent className="absolute -top-3 -right-3.5" />
            )}
          </span>
          {!collapsed && (
            <>
              <span className="flex-1 text-ui font-medium">Home</span>
              {counts.needsYou > 0 && <Count n={counts.needsYou} accent />}
            </>
          )}
        </RailButton>
      </div>
      <div
        ref={listRef}
        className={cn(
          'grid min-h-0 content-start gap-px overflow-x-hidden overflow-y-auto pt-2 pb-3',
          // One column that can shrink: a long title ends in "…" rather than being cut off.
          collapsed ? 'justify-items-center px-2.5' : 'grid-cols-[minmax(0,1fr)] px-3'
        )}
      >
        {!collapsed && (
          <div className="flex h-[22px] items-center gap-1.5 py-1 pl-2.5 font-mono text-kicker font-medium tracking-[0.1em] whitespace-nowrap text-text-muted uppercase">
            Spaces
            <span className="tracking-normal text-text-muted/70">{spaces.length}</span>
          </div>
        )}
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
              onOpenSpace={() => openSpace(space)}
              onOpenSession={(session) => openSession(space, session)}
              onPeek={showPeek}
            />
          )}
        />
        {collapsed && quietCount > 0 && (
          <button
            type="button"
            onClick={() => dispatch({ type: 'collapse', value: false })}
            aria-label={`${quietCount} more spaces: open the sidebar`}
            title={`${quietCount} more spaces`}
            className="hf-rail-item mt-1.5 h-7 rounded-full px-2.5 text-kicker font-medium text-text-muted hover:bg-bg-2 hover:text-text-primary"
          >
            +{quietCount}
          </button>
        )}
      </div>
      <You
        you={you}
        collapsed={collapsed}
        updateReady={updateReady}
        onOpenSettings={onOpenSettings}
      />
      {peek && <HoverCard anchor={peek.el}>{peek.body}</HoverCard>}
    </nav>
  );
}

/** You and Settings, at the foot of the rail: your photo opens your account, the gear opens Settings. */
function You({
  you,
  collapsed,
  updateReady,
  onOpenSettings,
}: {
  you: RailYou;
  collapsed: boolean;
  updateReady: boolean;
  onOpenSettings: (page?: 'account' | 'about') => void;
}) {
  const name = you.name ?? 'You';
  const gear = (
    <IconButton
      label={updateReady ? 'Settings, update ready' : 'Settings'}
      onClick={() => onOpenSettings(updateReady ? 'about' : undefined)}
    >
      <Settings className="size-[15px]" strokeWidth={1.6} />
      {updateReady && (
        <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-accent" />
      )}
    </IconButton>
  );
  const face = <Face person={{ name, hue: 7, avatarUrl: you.avatarUrl }} size={24} />;
  if (collapsed) {
    return (
      <div className="grid justify-items-center gap-1 pt-1 pb-3">
        <button
          type="button"
          aria-label={`${name}, your account`}
          title={name}
          onClick={() => onOpenSettings('account')}
          className="hf-rail-item grid size-9 place-items-center rounded-full hover:bg-bg-2"
        >
          {face}
        </button>
        {gear}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1 px-3 pt-1 pb-3">
      <button
        type="button"
        onClick={() => onOpenSettings('account')}
        title="Your account"
        className="hf-rail-item flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-[9px] pr-2 pl-2 text-left hover:bg-bg-2"
      >
        {face}
        <span className="truncate text-ui font-medium">{name}</span>
      </button>
      {gear}
    </div>
  );
}

function SpaceEntry({
  space,
  collapsed,
  selected,
  landed,
  onOpenSpace,
  onOpenSession,
  onPeek,
}: {
  space: RailSpace;
  collapsed: boolean;
  selected: string | null;
  landed: { id: string; n: number } | null;
  onOpenSpace: () => void;
  onOpenSession: (session: RailSession) => void;
  onPeek: (el: HTMLElement, body: ReactNode) => void;
}) {
  const sessions = space.sessions.map((session, i) => (
    <SessionEntry
      key={session.id}
      space={space}
      session={session}
      last={i === space.sessions.length - 1}
      ghost={space.fresh || session.fresh}
      collapsed={collapsed}
      current={selected === session.id}
      landedKey={landed?.id === session.id ? landed.n : undefined}
      onOpen={() => onOpenSession(session)}
      onPeek={onPeek}
    />
  ));
  if (collapsed) {
    // Folded, a space is a small group holding its sessions, topped by a quiet # that
    // opens it (its name is in the hover card).
    // A space with nothing going on folds into the "+N" at the end of the list.
    if (isQuietSpace(space)) return null;
    return (
      <div
        className={cn(
          'hf-fold-space mt-1.5 grid w-[60px] grid-cols-[minmax(0,1fr)] justify-items-center gap-0.5 rounded-[16px] px-1 py-1',
          space.fresh && 'invisible'
        )}
      >
        <RailButton
          railId={space.id}
          collapsed
          landedKey={landed?.id === space.id ? landed.n : undefined}
          label={`# ${space.name}${space.unread ? `, ${space.unread} unread` : ''}`}
          onClick={onOpenSpace}
          onPeek={(el) => onPeek(el, <PeekBody title={`# ${space.name}`} text={space.summary} />)}
          className="h-6 w-full min-w-0 justify-center rounded-full"
        >
          <span
            className={cn(
              'relative font-mono text-meta',
              space.unread > 0 ? 'text-text-primary' : 'text-text-muted'
            )}
          >
            #
            {space.unread > 0 && (
              <span
                aria-hidden
                className="absolute -top-px -right-2 size-1.5 rounded-full bg-accent"
              />
            )}
          </span>
        </RailButton>
        {sessions}
      </div>
    );
  }
  // Bold while something in it is unread or waits on you, like the Spaces card.
  const loud = space.unread > 0 || space.sessions.some((s) => s.state === 'needs_you');
  const unreadDot = space.unread > 0 && (
    <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-accent" />
  );
  const people =
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
      <RailButton
        railId={space.id}
        collapsed={collapsed}
        ghost={space.fresh}
        landedKey={landed?.id === space.id ? landed.n : undefined}
        label={`# ${space.name}${space.unread ? `, ${space.unread} unread` : ''}`}
        dragId={space.bindingId}
        onClick={onOpenSpace}
        onPeek={(el) => onPeek(el, <PeekBody title={`# ${space.name}`} text={space.summary} />)}
        className={collapsed ? 'mt-1 h-8 gap-2 pr-2 pl-2' : 'mt-1 h-8 gap-2.5 pr-2 pl-2.5'}
      >
        {!collapsed && (
          <span aria-hidden className="grid w-[15px] shrink-0 place-items-center text-ui text-text-muted">
            #
          </span>
        )}
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-ui',
            loud ? 'font-semibold text-text-primary' : 'text-text-secondary'
          )}
        >
          {collapsed && <span className="mr-1 text-text-muted">#</span>}
          {space.name}
        </span>
        {unreadDot}
        {people}
      </RailButton>
      {sessions}
    </>
  );
}

function SessionEntry({
  space,
  session,
  last,
  ghost,
  collapsed,
  current,
  landedKey,
  onOpen,
  onPeek,
}: {
  space: RailSpace;
  session: RailSession;
  /** The space's last session: the thread down from its name ends here. */
  last: boolean;
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
  const matrix = (
    <span
      key={landedKey}
      className={cn(
        'grid size-7 shrink-0 place-items-center',
        landedKey !== undefined && 'hf-landed'
      )}
    >
      <SessionMatrix session={session} />
    </span>
  );
  return (
    <RailButton
      railId={session.id}
      collapsed={collapsed}
      current={current}
      ghost={ghost}
      label={`${session.name}, ${session.short}`}
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
      className={collapsed ? 'size-9 justify-center' : 'min-h-10 gap-2 pr-2 pl-4'}
    >
      {!collapsed && <span aria-hidden className="hf-stem" data-last={last || undefined} />}
      {matrix}
      {!collapsed && (
        <span className="min-w-0 flex-1 whitespace-nowrap">
          <span className="block truncate text-ui font-medium">{session.name}</span>
          <span
            className={cn(
              '-mt-px block truncate text-xs text-text-muted',
              tone === 'warn' && 'text-status-warn',
              tone === 'ok' && 'text-status-ok'
            )}
          >
            {session.short}
          </span>
        </span>
      )}
    </RailButton>
  );
}

/** Nothing going on in it: no sessions, nothing unread. Folded, it waits behind "+N". */
function isQuietSpace(space: RailSpace): boolean {
  return space.sessions.length === 0 && space.unread === 0 && !space.fresh;
}

/** One rail row: the open and press states, the hover card, dragging a space, the landing pulse. */
function RailButton({
  label,
  railId,
  collapsed,
  current,
  ghost,
  landedKey,
  dragId,
  onClick,
  onPeek,
  className,
  children,
}: {
  /** The row's name for screen readers while folded, when only its icon shows. */
  label: string;
  railId?: string;
  collapsed: boolean;
  current?: boolean;
  ghost?: boolean;
  landedKey?: number;
  /** A space's binding id: it can be dragged onto a group. */
  dragId?: string;
  onClick: () => void;
  onPeek?: (el: HTMLElement) => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-rail-id={railId}
      aria-label={collapsed ? label : undefined}
      aria-current={current ? 'page' : undefined}
      draggable={!!dragId}
      onDragStart={
        dragId
          ? (e) => {
              e.dataTransfer.setData(SPACE_DRAG_TYPE, dragId);
              e.dataTransfer.effectAllowed = 'move';
            }
          : undefined
      }
      onClick={onClick}
      onMouseEnter={(e) => onPeek?.(e.currentTarget)}
      onFocus={(e) => onPeek?.(e.currentTarget)}
      className={cn(
        'hf-rail-item relative flex w-full min-w-0 items-center rounded-[9px] text-left',
        collapsed && 'w-9 rounded-full',
        current ? 'hf-rail-current bg-accent-subtle' : 'hover:bg-bg-2',
        ghost && 'invisible',
        landedKey !== undefined && 'hf-landed',
        className
      )}
    >
      {children}
    </button>
  );
}

function PeekBody({ title, text }: { title: string; text: string }) {
  return (
    <>
      <div className="flex items-center gap-2 font-semibold">{title}</div>
      <p className="mt-1.5 text-sm text-text-secondary">{text}</p>
    </>
  );
}

/** The folded rail's hover card, beside the entry it's about. */
function HoverCard({ anchor, children }: { anchor: HTMLElement; children: ReactNode }) {
  const r = anchor.getBoundingClientRect();
  const top = Math.max(8, Math.min(r.top - 6, window.innerHeight - 160));
  return (
    <div
      role="tooltip"
      style={{ left: r.right + 12, top }}
      className="popover-in pointer-events-none fixed z-50 w-[290px] rounded-[14px] border border-border-hairline bg-bg-1 px-3.5 py-3 text-chat shadow-float"
    >
      {children}
    </div>
  );
}
