import { Home as HomeIcon, PanelLeftClose, PanelLeftOpen, Search, Settings, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { NewSpaceCta } from '@renderer/features/home/new-space-cta';
import { startSpaceSetup } from '@renderer/features/spaces/space-setup-store';
import { useMyInvites } from '@renderer/features/shell/use-my-invites';
import { stepMatrix, untilInWords } from '@renderer/features/views/space-status';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import { Count, Face, IconButton, SessionMatrix, StatusWord } from './bits';
import { useHome } from './home-context';
import {
  type RailSession,
  type RailSpace,
  sessionLabelTone,
  sessionStatusWord,
  spaceIsLoud,
  spacesWaitingCount,
} from './model';
import { findSpaces } from './rail-data';
import { SPACE_DRAG_TYPE, SpaceGroups } from './rail-groups';
import { needsYouPhrase } from './say';
import { useFactoryOverview, type SpaceFactory } from './use-factory-overview';

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
  onOpenSettings: (page?: 'account' | 'invites' | 'about') => void;
}) {
  const { state, dispatch, spaces, counts, open, openInApp, openPath } = useHome();
  const collapsed = state.collapsed;
  const factories = useFactoryOverview(true);
  const [peek, setPeek] = useState<Peek | null>(null);
  const selected = state.selection.kind === 'session' ? state.selection.id : null;

  useEffect(() => {
    if (!collapsed) setPeek(null);
  }, [collapsed]);

  // Finding a space by name: null while the field is closed. Folded to icons, there is no field.
  const [query, setQuery] = useState<string | null>(null);
  useEffect(() => {
    if (collapsed) setQuery(null);
  }, [collapsed]);
  const waiting = spacesWaitingCount(spaces);
  const finding = !collapsed && query !== null && query.trim() !== '';
  const found = finding ? findSpaces(spaces, query) : [];

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
    // A space opens in the app, its Room (downloaded first when it is not on this Mac yet). One that
    // exists only in this preview opens its context here.
    if (space.root || (space.origin === 'real' && space.bindingId)) openInApp({ space });
    else open({ kind: 'space', id: space.id });
  };
  const openSession = (space: RailSpace, session: RailSession) => {
    if (space.root && session.origin === 'real') openInApp({ space, session });
    else open({ kind: 'session', id: session.id });
  };

  const renderSpace = (space: RailSpace) => (
    <SpaceEntry
      key={space.id}
      space={space}
      collapsed={collapsed}
      selected={selected}
      landed={state.landed}
      factory={space.bindingId ? factories.get(space.bindingId) : undefined}
      onOpenSpace={() => openSpace(space)}
      onOpenSession={(session) => openSession(space, session)}
      onPeek={showPeek}
    />
  );

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
        {/* Make a space, or join one by its link: first in the sidebar, above Home. (Inside Home's
            own row of the rail's grid: a row of its own would take the list's stretching one.) */}
        {!collapsed && (
          <div className="pb-2 [-webkit-app-region:no-drag]" data-testid="rail-new-space">
            <NewSpaceCta
              existingNames={new Set(spaces.map((space) => space.name))}
              onCreateSpace={startSpaceSetup}
              onOpenPath={openPath}
            />
          </div>
        )}
        <RailButton
          collapsed={collapsed}
          current={state.selection.kind === 'home'}
          label="Home"
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
          {/* No count here: what needs you is counted on the Feed, what waits in spaces on the Spaces line. */}
          <span className="relative grid place-items-center">
            <HomeIcon className="size-[15px] text-text-secondary" strokeWidth={1.6} />
          </span>
          {!collapsed && <span className="flex-1 text-ui font-medium">Home</span>}
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
        {!collapsed &&
          (query === null ? (
            // Its magnifier sits over the groups' own buttons below (their "×"), the same size.
            <div className="flex h-7 items-center gap-1.5 pr-1 pl-2.5 font-mono text-kicker font-medium tracking-[0.1em] whitespace-nowrap text-text-muted uppercase">
              Spaces
              <span className="tracking-normal text-text-muted/70">{spaces.length}</span>
              {/* What waits for you in your spaces (your agent finished, a mention, a reply): the
                  spaces it is in are bold below, and so are the groups that hold them. */}
              {waiting > 0 && (
                <span
                  className="ml-auto flex font-sans tracking-normal normal-case"
                  aria-label={`${waiting} waiting in your spaces`}
                  title={`${waiting} waiting in your spaces`}
                  data-testid="rail-spaces-count"
                >
                  <Count n={waiting} accent />
                </span>
              )}
              <IconButton
                label="Find a space"
                onClick={() => setQuery('')}
                className={cn('size-6', waiting > 0 ? 'ml-1' : 'ml-auto')}
              >
                <Search className="size-[14px]" strokeWidth={1.6} />
              </IconButton>
            </div>
          ) : (
            // Its magnifier and its text line up with the rows' "#" and names below.
            <div className="flex h-7 items-center gap-2.5 rounded-control border border-border-hairline bg-bg-1 pr-[3px] pl-[9px] focus-within:border-accent">
              <Search className="size-[15px] shrink-0 text-text-muted" strokeWidth={1.6} />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setQuery(null);
                  if (e.key === 'Enter' && found[0]) {
                    setQuery(null);
                    openSpace(found[0]);
                  }
                }}
                placeholder="Find a space"
                aria-label="Find a space"
                className="h-full min-w-0 flex-1 bg-transparent text-ui text-text-primary outline-none placeholder:text-text-muted"
              />
              <IconButton label="Close the search" onClick={() => setQuery(null)} className="size-6">
                <X className="size-3.5" strokeWidth={1.8} />
              </IconButton>
            </div>
          ))}
        {finding ? (
          <>
            {found.map(renderSpace)}
            {found.length === 0 && (
              <p className="px-2.5 pt-2 text-meta text-text-muted">
                No space has “{query.trim()}” in its name.
              </p>
            )}
          </>
        ) : (
          <SpaceGroups spaces={spaces} collapsed={collapsed} renderSpace={renderSpace} />
        )}
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

/**
 * You and Settings, at the foot of the rail: your photo opens your account, the gear opens
 * Settings. Invites waiting for you show as a count on your row, which then opens the page that
 * lists them (Settings › Invites).
 */
function You({
  you,
  collapsed,
  updateReady,
  onOpenSettings,
}: {
  you: RailYou;
  collapsed: boolean;
  updateReady: boolean;
  onOpenSettings: (page?: 'account' | 'invites' | 'about') => void;
}) {
  const name = you.name ?? 'You';
  const invites = useMyInvites().rows?.length ?? 0;
  const invitesWord = `${invites} ${invites === 1 ? 'invite' : 'invites'}`;
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
          aria-label={invites > 0 ? `${name}, your account, ${invitesWord}` : `${name}, your account`}
          title={invites > 0 ? `${name}: ${invitesWord} for you` : name}
          onClick={() => onOpenSettings(invites > 0 ? 'invites' : 'account')}
          className="hf-rail-item relative grid size-9 place-items-center rounded-full hover:bg-bg-2"
        >
          {face}
          {/* On the corner of your photo, as Home's count sits on its icon above. */}
          {invites > 0 && <Count n={invites} accent className="absolute -top-1 -right-1.5" />}
        </button>
        {gear}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1 px-3 pt-1 pb-3">
      <button
        type="button"
        onClick={() => onOpenSettings(invites > 0 ? 'invites' : 'account')}
        title={invites > 0 ? `${invitesWord} for you` : 'Your account'}
        aria-label={invites > 0 ? `${name}, your account, ${invitesWord}` : undefined}
        className="hf-rail-item flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-[9px] pr-2 pl-2 text-left hover:bg-bg-2"
      >
        {face}
        <span className="min-w-0 flex-1 truncate text-ui font-medium">{name}</span>
        {invites > 0 && <Count n={invites} accent />}
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
  factory,
}: {
  space: RailSpace;
  collapsed: boolean;
  selected: string | null;
  landed: { id: string; n: number } | null;
  onOpenSpace: () => void;
  onOpenSession: (session: RailSession) => void;
  onPeek: (el: HTMLElement, body: ReactNode) => void;
  /** What the space is doing as a factory: a pass going now, or standing work at rest. */
  factory?: SpaceFactory;
}) {
  const sessions = space.sessions.map((session) => (
    <SessionEntry
      key={session.id}
      space={space}
      session={session}
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
  const loud = spaceIsLoud(space);
  const unreadDot = (space.unread > 0 || (space.waiting ?? 0) > 0) && (
    <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-accent" />
  );
  // A space that is a factory shows it: a grid moving while a pass is going there, idling while
  // its standing work waits for its next run. (A space only you are in needs no lock to say so.)
  const pulse = factory?.run ? (
    <span
      title={factory.run.state === 'waiting' ? 'Waiting on you' : factory.run.step || 'Working'}
      data-testid="rail-space-factory"
      data-state="running"
      className="grid w-[15px] shrink-0 place-items-center"
    >
      <DotMatrix
        state={stepMatrix(factory.run).state}
        tone={stepMatrix(factory.run).tone}
        size="sm"
      />
    </span>
  ) : factory && factory.scheduled > 0 ? (
    <span
      title={
        factory.nextDueAt !== null
          ? `Runs on its own. Next: ${untilInWords(factory.nextDueAt, Date.now()).replace(/^I/, 'i')}.`
          : 'Runs on its own while Rig is open.'
      }
      data-testid="rail-space-factory"
      data-state="standby"
      className="grid w-[15px] shrink-0 place-items-center"
    >
      <DotMatrix state="standby" tone="mute" size="sm" phase={space.name.length * 11} />
    </span>
  ) : null;
  const people =
    space.visibility === 'private' ? null : space.faces.length ? (
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
        {pulse}
        {people}
      </RailButton>
      {sessions}
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
