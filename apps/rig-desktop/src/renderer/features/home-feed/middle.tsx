import {
  Activity,
  ArrowLeft,
  AtSign,
  CornerDownLeft,
  Hash,
  CalendarClock,
  DoorOpen,
  Inbox,
  ListChecks,
  type LucideIcon,
  Play,
  Repeat,
  Reply,
  Undo2,
  UserPlus,
} from 'lucide-react';
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import { ActionButton } from './action-button';
import { Face, Kicker, SessionMatrix, SourceLogo, sourceName, StatusWord } from './bits';
import { HomeComposer, HomeRuns } from './home-claude';
import { useHomeNotes } from './home-notes';
import { rectOf, useHome } from './home-context';
import { SOURCES } from './mock';
import { type RailSession, type RailSpace, sessionStatusWord } from './model';
import type { BriefRow, Inline, ReplyBlock } from './orchestrator';
import { findSession } from './store';

/**
 * Middle: talk to Rig, or see the context of what's open. Home is the chat
 * (a short greeting, quick chips, the composer); clicking a session or a
 * space in the rail swaps in its context (activity, the ask, results), and
 * ← Home comes back.
 */

const QUICK: Array<{ label: string; icon: LucideIcon; say?: string; fill?: string }> = [
  { label: 'Status update', icon: Activity, say: 'Status update' },
  { label: 'Start a session…', icon: Play, fill: 'Start a session to ' },
  { label: 'Every Monday…', icon: Repeat, fill: 'Every Monday, clear stale Earn tickets' },
  { label: 'What came in today?', icon: Inbox, say: 'What came in today?' },
];

export function Middle() {
  const { state } = useHome();
  const sel = state.selection;
  return (
    <section aria-label="Talk to Rig" className="flex min-h-0 min-w-0 flex-1 flex-col">
      {sel.kind === 'home' ? <HomeChat /> : <ContextView />}
    </section>
  );
}

function Bar({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[52px] shrink-0 items-center justify-between gap-3 border-b border-border-hairline px-[22px] py-3 [-webkit-app-region:drag]">
      <div className="flex min-w-0 flex-wrap items-center gap-2.5 [-webkit-app-region:no-drag]">
        {children}
      </div>
    </div>
  );
}

const DATE = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

function greetingWord(now: Date): string {
  const h = now.getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function HomeChat() {
  const { state, firstName, orchestrator, orchestratorContext, send, homeRuns, continueSession } = useHome();
  const notes = useHomeNotes();
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState('');
  const now = new Date();

  useLayoutEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [state.messages]);

  const [focused, setFocused] = useState(false);

  const insert = (mark: string) => {
    setDraft((v) => `${v}${v && !v.endsWith(' ') ? ' ' : ''}${mark}`);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    });
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    send(draft);
    setDraft('');
  };

  return (
    <>
      {/* No title: the greeting says where you are. The sheet's top edge still moves the window. */}
      <div aria-hidden className="h-3 shrink-0 [-webkit-app-region:drag]" />
      {homeRuns ? (
        // Home's Claude, live: the greeting, then each message and Claude's run, the way a space's Room shows them.
        <div className="flex min-h-0 flex-1 flex-col pr-[var(--hf-gutter,0px)]">
          <HomeRuns
            runs={homeRuns}
            notes={notes}
            onOpenNote={(note) => continueSession(note.root, note.sessionId)}
            name={firstName}
            header={
              <div className="grid content-start gap-4">
                <div>
                  <Kicker className="text-2xs">{DATE.format(now)}</Kicker>
                  <div className="mt-1.5 font-display text-2xl leading-[1.15] font-medium tracking-[-0.01em]">
                    {greetingWord(now)}, {firstName}.
                  </div>
                </div>
                <RigMessage blocks={orchestrator.greeting(orchestratorContext)} />
              </div>
            }
          />
        </div>
      ) : (
      <div
        ref={logRef}
        aria-live="polite"
        className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto pt-[22px] pr-[max(26px,var(--hf-gutter,0px))] pb-2 pl-[26px]"
      >
        <Column>
          <Kicker className="text-2xs">{DATE.format(now)}</Kicker>
          <div className="mt-1.5 font-display text-2xl leading-[1.15] font-medium tracking-[-0.01em]">
            {greetingWord(now)}, {firstName}.
          </div>
        </Column>
        <RigMessage blocks={orchestrator.greeting(orchestratorContext)} />
        {state.messages.map((m) =>
          m.who === 'me' ? (
            <Column key={m.id} className="hf-rise grid grid-cols-[28px_minmax(0,1fr)] gap-2.5">
              <span className="grid size-7 place-items-center rounded-full bg-[var(--face-7)] text-2xs font-semibold text-face-ink">
                {firstName[0]?.toUpperCase() ?? 'Y'}
              </span>
              <div className="min-w-0 pt-1 text-chat leading-[1.6]">{m.text}</div>
            </Column>
          ) : (
            <RigMessage key={m.id} id={m.id} blocks={m.blocks} />
          )
        )}
      </div>
      )}
      <div className="grid shrink-0 gap-2 pt-2.5 pr-[max(26px,var(--hf-gutter,0px))] pb-[18px] pl-[26px]">
        <Column className="flex flex-wrap gap-1.5">
          {QUICK.map((q) => (
            <button
              key={q.label}
              type="button"
              onClick={() => {
                if (q.say) send(q.say);
                else {
                  setDraft(q.fill ?? '');
                  requestAnimationFrame(() => {
                    const el = inputRef.current;
                    el?.focus();
                    el?.setSelectionRange(el.value.length, el.value.length);
                  });
                }
              }}
              className="hf-chip group inline-flex items-center gap-1.5 rounded-full border border-border-hairline bg-bg-1 py-1 pr-[11px] pl-2.5 text-meta text-text-secondary hover:border-border-strong hover:text-text-primary"
            >
              <q.icon
                className="hf-chip-icon size-3.5 text-text-muted group-hover:text-accent"
                strokeWidth={2}
              />
              {q.label}
            </button>
          ))}
        </Column>
        {homeRuns ? (
          <div className="mx-auto w-full max-w-[44rem] px-3">
            <HomeComposer name={firstName} busy={homeRuns.some((r) => r.status === 'running')} onSend={send} />
          </div>
        ) : (
        <Column>
          {/* The Room's composer, the same box: the words on top, small tools and the send underneath. */}
          <form
            onSubmit={submit}
            className={cn(
              'hf-composer rounded-card border border-border-hairline bg-[light-dark(var(--bg-1),var(--bg-2))]',
              focused && 'border-accent shadow-[0_0_0_3px_var(--accent-subtle)]'
            )}
          >
            <textarea
              ref={inputRef}
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Ask Rig, or tell it what to start"
              aria-label="Message Rig"
              // Grows with what you type, up to 40% of the window, then scrolls.
              className="[field-sizing:content] max-h-[40vh] min-h-[40px] w-full resize-none overflow-y-auto bg-transparent px-3.5 py-2.5 text-sm text-text-primary outline-none placeholder:text-text-muted"
            />
            <div className="flex items-center gap-0.5 px-2 pb-2">
              <ComposerTool label="Mention someone" onClick={() => insert('@')}>
                <AtSign className="size-3.5" strokeWidth={1.5} />
              </ComposerTool>
              <ComposerTool label="Name a space" onClick={() => insert('#')}>
                <Hash className="size-3.5" strokeWidth={1.5} />
              </ComposerTool>
              <button
                type="submit"
                disabled={!draft.trim()}
                className={cn(
                  'hf-send ml-auto flex h-6.5 items-center gap-1.5 rounded-control px-2.5 text-xs transition-colors disabled:opacity-60',
                  draft.trim() ? 'bg-accent text-accent-ink' : 'bg-bg-2 text-text-secondary'
                )}
              >
                Ask
                <CornerDownLeft className="size-3" strokeWidth={1.5} />
              </button>
            </div>
          </form>
        </Column>
        )}
      </div>
    </>
  );
}

/** A small tool under the composer's words, as in the Room's composer. */
function ComposerTool({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-control text-text-muted transition-colors hover:bg-bg-2"
    >
      {children}
    </button>
  );
}

/** The chat's reading column: 680px, centered. */
function Column({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-[680px]', className)}>{children}</div>;
}

function RigMessage({ id, blocks }: { id?: string; blocks: ReplyBlock[] | null }) {
  return (
    <Column className="hf-rise grid grid-cols-[28px_minmax(0,1fr)] gap-2.5">
      <span
        data-thinking={!blocks}
        className="hf-rig-tile grid size-7 place-items-center rounded-[8px] border border-border-hairline bg-bg-2"
      >
        <DotMatrix state={blocks ? 'idle' : 'thinking'} size="sm" />
      </span>
      <div className="min-w-0">
        <div className="mb-0.5 text-meta text-text-muted">Rig</div>
        {blocks ? (
          <div className="text-chat leading-[1.6]">
            {blocks.map((block, i) => (
              <Block key={i} block={block} usedKey={id ? `${id}:${i}` : undefined} />
            ))}
          </div>
        ) : (
          <span className="hf-typing inline-flex gap-[3px] py-2">
            <i />
            <i />
            <i />
          </span>
        )}
      </div>
    </Column>
  );
}

function Block({ block, usedKey }: { block: ReplyBlock; usedKey?: string }) {
  const { state, dispatch, startSession, addRoutine } = useHome();
  const used = usedKey ? state.used.includes(usedKey) : false;
  switch (block.kind) {
    case 'text':
      return (
        <div>
          {block.runs.map((run, i) => (
            <Run key={i} run={run} />
          ))}
        </div>
      );
    case 'status':
      return <StatusBlock />;
    case 'brief':
      return (
        <Brief title={<span>{block.title}</span>} rows={block.rows}>
          <ActionButton
            variant="primary"
            icon={Play}
            disabled={used}
            onClick={(e) => {
              if (usedKey) dispatch({ type: 'use', key: usedKey });
              startSession(
                block.start.spaceId,
                block.start.name,
                rectOf(e.currentTarget.closest('[data-brief]'))
              );
            }}
          >
            Start session
          </ActionButton>
        </Brief>
      );
    case 'routine':
      return (
        <Brief
          title={
            <>
              <DotMatrix state="idle" size="sm" />
              {block.title}
            </>
          }
          rows={block.rows}
        >
          <ActionButton
            variant="primary"
            icon={CalendarClock}
            disabled={used}
            onClick={(e) => {
              if (usedKey) dispatch({ type: 'use', key: usedKey });
              addRoutine(block.name, rectOf(e.currentTarget.closest('[data-brief]')));
            }}
          >
            Save routine
          </ActionButton>
        </Brief>
      );
  }
}

function Run({ run }: { run: Inline }) {
  const { spaces, open } = useHome();
  switch (run.kind) {
    case 'text':
      return <>{run.text}</>;
    case 'bold':
      return <b className="font-semibold">{run.text}</b>;
    case 'source':
      return <SourceLogo connector={run.connector} className="mx-0.5 inline-block align-[-2px]" />;
    case 'session': {
      const found = findSession(spaces, run.sessionId);
      return (
        <button
          type="button"
          onClick={() => open({ kind: 'session', id: run.sessionId })}
          className="hf-chip inline-flex items-center gap-1.5 rounded-full border border-border-hairline bg-bg-1 py-0 pr-[9px] pl-[7px] align-middle text-sm leading-[18px] hover:border-border-strong"
        >
          {found ? (
            <SessionMatrix session={found.session} size="sm" />
          ) : (
            <DotMatrix state="done" tone="ok" size="sm" />
          )}
          {run.label}
        </button>
      );
    }
  }
}

function StatusBlock() {
  const { spaces, open } = useHome();
  const rows = spaces.flatMap((space) =>
    space.sessions.filter((s) => s.state !== 'idle').map((session) => ({ space, session }))
  );
  return (
    <div className="mt-2.5 overflow-hidden rounded-[12px] border border-border-hairline bg-bg-1">
      {rows.map(({ space, session }) => (
        <SessionRow
          key={session.id}
          session={session}
          meta={`#${space.name}${session.owner ? ` · ${session.owner}` : ''}`}
          onOpen={() => open({ kind: 'session', id: session.id })}
        />
      ))}
    </div>
  );
}

function SessionRow({
  session,
  meta,
  onOpen,
}: {
  session: RailSession;
  meta?: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="grid w-full grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-border-hairline px-3 py-[9px] text-left transition-colors last:border-b-0 hover:bg-bg-2"
    >
      <SessionMatrix session={session} />
      <span className="min-w-0">
        <span className="block text-ui font-medium">
          {session.name}
          {meta && <i className="ml-1.5 text-xs font-normal text-text-muted not-italic">{meta}</i>}
        </span>
        <span
          className={cn(
            'block truncate text-meta text-text-secondary',
            session.state === 'needs_you' && 'text-status-warn'
          )}
        >
          {session.last.text}
        </span>
      </span>
      <span className="font-mono text-2xs text-text-muted">{session.last.ago}</span>
    </button>
  );
}

function Brief({
  title,
  note,
  rows = [],
  children,
}: {
  title?: ReactNode;
  note?: string;
  rows?: BriefRow[];
  children?: ReactNode;
}) {
  return (
    <div
      data-brief
      className="mt-2.5 grid gap-2 rounded-[12px] border border-border-hairline bg-bg-1 px-3.5 py-3"
    >
      {title && <h4 className="m-0 flex items-center gap-2 text-chat font-semibold">{title}</h4>}
      {note && <div className="text-sm text-text-secondary">{note}</div>}
      {rows.length > 0 && (
        <div className="grid grid-cols-[90px_minmax(0,1fr)] gap-x-2.5 gap-y-1 text-sm">
          {rows.map((row) => (
            <KV key={row.label} row={row} />
          ))}
        </div>
      )}
      {children && <div className="flex flex-wrap gap-1.5">{children}</div>}
    </div>
  );
}

function KV({ row }: { row: BriefRow }) {
  return (
    <>
      <span className="text-text-muted">{row.label}</span>
      <span className="flex items-center gap-1.5 text-text-secondary">
        {row.connector && <SourceLogo connector={row.connector} />}
        {row.value}
      </span>
    </>
  );
}

// ── context ────────────────────────────────────────────────────────────────

function ContextView() {
  const { state, spaces, open } = useHome();
  const sel = state.selection;
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [sel]);

  let bar: ReactNode = null;
  let body: ReactNode = null;
  if (sel.kind === 'space') {
    const space = spaces.find((s) => s.id === sel.id);
    if (space) ({ bar, body } = spaceContext(space));
  } else if (sel.kind === 'session') {
    const found = findSession(spaces, sel.id);
    if (found)
      ({ bar, body } = { bar: <SessionBar {...found} />, body: <SessionBody {...found} /> });
  } else if (sel.kind === 'brief') {
    const entry = state.feed.find((e) => e.item.id === sel.itemId);
    if (entry)
      ({ bar, body } = {
        bar: <BriefBar itemId={sel.itemId} />,
        body: <BriefBody itemId={sel.itemId} />,
      });
  }

  // What was open is gone (moved, or acted on): back to the chat.
  useEffect(() => {
    if (!body) open({ kind: 'home' });
  }, [body, open]);

  return (
    <>
      <Bar>
        <button
          type="button"
          onClick={() => open({ kind: 'home' })}
          data-dir="left"
          className="hf-nudge -ml-2 inline-flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-2 hover:text-text-primary"
        >
          <ArrowLeft className="size-3.5" strokeWidth={1.8} />
          Home
        </button>
        {bar}
      </Bar>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-[26px] pt-[22px] pb-6">
        <Column key={JSON.stringify(sel)} className="hf-rise grid gap-4">
          {body}
        </Column>
      </div>
    </>
  );
}

function ContextHead({
  tile,
  title,
  summary,
}: {
  tile: ReactNode;
  title: string;
  summary: string;
}) {
  return (
    <div className="grid grid-cols-[44px_minmax(0,1fr)] items-center gap-3.5">
      <span className="grid size-11 place-items-center rounded-[11px] border border-border-hairline bg-bg-1">
        {tile}
      </span>
      <div className="min-w-0">
        <div className="font-display text-xl leading-[1.2] font-medium">{title}</div>
        <div className="mt-0.5 text-ui text-text-secondary">{summary}</div>
      </div>
    </div>
  );
}

function spaceContext(space: RailSpace): { bar: ReactNode; body: ReactNode } {
  return {
    bar: (
      <>
        <b className="text-chat font-semibold"># {space.name}</b>
        <span className="text-sm text-text-muted">
          {space.visibility === 'private' ? 'Only you' : 'Shared'}
        </span>
        {space.faces.length > 0 && (
          <span className="hf-stack flex">
            {space.faces.map((p) => (
              <Face key={p.id} person={p} />
            ))}
          </span>
        )}
      </>
    ),
    body: <SpaceBody space={space} />,
  };
}

function SpaceBody({ space }: { space: RailSpace }) {
  const { open, openInApp } = useHome();
  const listed = space.history ?? space.sessions;
  return (
    <>
      <ContextHead
        tile={
          <span className="grid size-[30px] place-items-center rounded-[6px] border border-border-hairline bg-bg-2 font-mono text-sm font-semibold text-text-secondary">
            {space.name[0]?.toUpperCase()}
          </span>
        }
        title={`# ${space.name}`}
        summary={space.summary}
      />
      {space.root && (
        <div className="flex gap-1.5">
          <ActionButton icon={DoorOpen} onClick={() => openInApp({ space })}>
            Open space
          </ActionButton>
        </div>
      )}
      <Kicker className="text-2xs">Sessions · {listed.length}</Kicker>
      <div className="-mt-2 overflow-hidden rounded-[12px] border border-border-hairline bg-bg-1">
        {listed.length ? (
          listed.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              meta={session.owner}
              onOpen={() => open({ kind: 'session', id: session.id })}
            />
          ))
        ) : (
          <div className="px-3 py-[9px] pl-[44px] text-meta text-text-secondary">
            No sessions yet
          </div>
        )}
      </div>
    </>
  );
}

function SessionBar({ space, session }: { space: RailSpace; session: RailSession }) {
  const { open } = useHome();
  const word = sessionStatusWord(session.state);
  return (
    <>
      <b className="text-chat font-semibold">{session.name}</b>
      <button
        type="button"
        onClick={() => open({ kind: 'space', id: space.id })}
        className="text-sm text-accent hover:underline"
      >
        #{space.name}
      </button>
      {session.source && (
        <span className="flex items-center gap-1.5 text-sm text-text-muted">
          <SourceLogo connector={session.source.connector} />
          {sourceName(session.source.connector)} · {SOURCES[session.source.connector].scope}
        </span>
      )}
      <StatusWord {...word} />
    </>
  );
}

function SessionBody({ space, session }: { space: RailSpace; session: RailSession }) {
  const { bringIn, toast, openInApp } = useHome();
  const steps = session.steps.length
    ? session.steps
    : [{ text: session.last.text, ago: session.last.ago }];
  const isTriageAsk = session.state === 'needs_you' && session.origin === 'mock';
  return (
    <>
      <ContextHead
        tile={<SessionMatrix session={session} size="xl" />}
        title={session.name}
        summary={session.summary}
      />
      {isTriageAsk && (
        <Brief
          title={
            <>
              <SessionMatrix session={session} size="sm" />
              Claude needs you
            </>
          }
          note={session.last.text}
        >
          <ActionButton
            variant="primary"
            icon={UserPlus}
            onClick={(e) => bringIn(session.id, rectOf(e.currentTarget.closest('[data-brief]')))}
          >
            Bring Riyad in
          </ActionButton>
          <ActionButton
            icon={Reply}
            onClick={() => toast('Type your answer in the session; Claude picks it up next step')}
          >
            Answer
          </ActionButton>
        </Brief>
      )}
      {session.id === 's-stale' && (
        <Brief
          title={
            <>
              <DotMatrix state="done" tone="ok" size="sm" />
              16 close calls to review
            </>
          }
          note="61 closed in Linear with a reason each; 38 kept with a note."
        >
          <ActionButton
            variant="primary"
            icon={ListChecks}
            onClick={() => toast('Opens the per-item review: keep closed or reopen with a reason')}
          >
            Review 16
          </ActionButton>
          <ActionButton
            icon={Undo2}
            motion="undo"
            onClick={() => toast('Would start a background session that reopens all 61')}
          >
            Undo all
          </ActionButton>
        </Brief>
      )}
      {session.origin === 'real' && space.root && (
        <div className="flex gap-1.5">
          <ActionButton icon={DoorOpen} onClick={() => openInApp({ space, session })}>
            {session.id.startsWith('chat:') ? 'Open session' : 'Open space'}
          </ActionButton>
        </div>
      )}
      <Kicker className="text-2xs">Activity</Kicker>
      <div className="-mt-2 ml-2.5 grid border-l border-border-hairline">
        {steps.map((step, i) => {
          const last = i === steps.length - 1;
          return (
            <div
              key={`${i}-${step.text}`}
              className={cn(
                '-ml-[11px] grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2.5 py-[7px] text-ui',
                last ? 'text-text-primary' : 'text-text-secondary'
              )}
            >
              <span className="grid size-[22px] place-items-center bg-bg-0">
                {last ? (
                  <SessionMatrix session={session} size="sm" />
                ) : (
                  <i className="block size-1.5 rounded-full bg-text-muted" />
                )}
              </span>
              <span>{step.text}</span>
              <span className="font-mono text-2xs text-text-muted">{last ? step.ago : ''}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

function BriefBar({ itemId }: { itemId: string }) {
  const { state, spaces } = useHome();
  const entry = state.feed.find((e) => e.item.id === itemId)!;
  const space = spaces.find((s) => s.id === entry.item.spaceId);
  return (
    <>
      <b className="text-chat font-semibold">Brief · {entry.item.title}</b>
      <span className="text-sm text-text-muted">#{space?.name ?? entry.item.spaceId}</span>
    </>
  );
}

function BriefBody({ itemId }: { itemId: string }) {
  const { state, dispatch, startSession } = useHome();
  const entry = state.feed.find((e) => e.item.id === itemId)!;
  const { item } = entry;
  const source = item.source;
  const rows: BriefRow[] = [
    { label: 'Goal', value: item.plan ?? item.title },
    { label: 'Why', value: item.why.replace(/\{([^}]+)\}/g, '$1') },
    source
      ? {
          label: 'Source',
          value: `${sourceName(source.connector)} · ${source.scope}`,
          connector: source.connector,
        }
      : { label: 'Source', value: item.people.length ? 'A message in the space' : 'Rig' },
    {
      label: 'Limits',
      value: 'Read freely with your connectors. Ask before commenting, assigning or closing.',
    },
    { label: 'Report', value: 'Progress in the rail; questions in your Feed.' },
  ];
  const spaceId = item.spaceId;
  return (
    <>
      <ContextHead
        tile={<DotMatrix state="idle" size="xl" />}
        title={item.title}
        summary={`Edit the goal and limits, then start. Saved as .rig/briefs/${item.id.replace(/^(prp|ask)_/, '')}.md`}
      />
      <Brief rows={rows}>
        <ActionButton
          variant="primary"
          icon={Play}
          onClick={(e) => {
            dispatch({ type: 'remove', itemId });
            startSession(spaceId, item.title, rectOf(e.currentTarget.closest('[data-brief]')), {
              source,
            });
          }}
        >
          Start session
        </ActionButton>
      </Brief>
    </>
  );
}
