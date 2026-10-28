import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, ChevronDown, Eye, MoonStar, PanelRightOpen, Plug, RefreshCw } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { RigChatStore } from '@renderer/features/chat/rig-chat-store';
import { rigSessionRegistry } from '@renderer/features/chat/session/rig-session-registry';
import { loadAllSessionEvents, parseStoredEvents } from '@renderer/features/chat/session-writer';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import { rigFeedChangedChannel } from '@shared/rig/feed';
import { knownTool, type KnownTool, toolKey } from '@shared/rig/first-run';
import { ActionButton } from './action-button';
import { Kicker, SourceLogo, sourceName } from './bits';
import { agoShort } from './connectors-model';
import { useHome } from './home-context';
import { lastAnswer, sessionResult, type SessionResult } from './session-result';

/**
 * What the background orchestrator did, at the foot of the real Feed: the
 * cards it took off and the situations it closed, each with its reason and a
 * way to bring it back ("Set aside"), then its last run and what it reads.
 */

type Aside = { ref: string; title: string; reason: string; closed: boolean; change: string; at: string };
type Working = { ref: string; title: string; run: string; local?: boolean; status: string; space: string; spaceName: string; at: string; ended: string | null };
type Run = { ref: string; title: string; quieted?: string; at: string; ended: string | null; read: { source: string; until: string }[]; changed: number };

const SET_ASIDE_KEY = ['rig', 'orch', 'set-aside'] as const;
const RUN_KEY = ['rig', 'orch', 'last-run'] as const;
const SOURCES_KEY = ['rig', 'orch', 'sources'] as const;
const WORKING_KEY = ['rig', 'orch', 'working'] as const;
const QUIETED_KEY = ['rig', 'orch', 'quieted'] as const;
const STATUS_KEY = ['rig', 'orch', 'agent-status'] as const;

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/** Re-read both when the Feed changes: a run that set something aside also changed the Feed. */
function useRefreshOnFeedChange(): void {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      events.on(rigFeedChangedChannel, () => {
        void queryClient.invalidateQueries({ queryKey: SET_ASIDE_KEY });
        void queryClient.invalidateQueries({ queryKey: RUN_KEY });
        void queryClient.invalidateQueries({ queryKey: SOURCES_KEY });
        void queryClient.invalidateQueries({ queryKey: WORKING_KEY });
        void queryClient.invalidateQueries({ queryKey: QUIETED_KEY });
      }),
    [queryClient]
  );
}

/** A group heading the way the Feed draws its own ("Needs you", "Claude can take"). */
function GroupHead({ tone, children }: { tone: 'accent' | 'muted'; children: ReactNode }) {
  return (
    <Kicker className="flex items-center gap-2">
      <span aria-hidden className="hf-group-dot" data-tone={tone} />
      {children}
    </Kicker>
  );
}

/** Rows shown before "Show all": enough to see what Claude did, not a second Feed. */
const ASIDE_FIRST = 5;

/** Until a run writes its own summary: the latest things, by name. */
function namedSummary(rows: readonly Aside[]): string {
  const names = rows.slice(0, 2).map((r) => r.title);
  const rest = rows.length - names.length;
  return `Claude quieted ${names.join(' and ')}${rest > 0 ? `, and ${rest} more` : ''}.`;
}

/** "Set aside": folded by default, like a group the person opens when they wonder why the Feed is short. */
export function SetAside() {
  useRefreshOnFeedChange();
  const now = useNow(60_000);
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: SET_ASIDE_KEY,
    queryFn: () => rpc.rig.orch.query({ kind: 'set_aside', limit: 30 }),
    staleTime: 60_000,
  });
  const rows = data?.success && 'rows' in data.data ? (data.data.rows as unknown as Aside[]) : [];
  const { data: runsData } = useQuery({
    queryKey: QUIETED_KEY,
    queryFn: () => rpc.rig.orch.query({ kind: 'runs', limit: 10 }),
    staleTime: 60_000,
  });
  const runs = runsData?.success && 'rows' in runsData.data ? (runsData.data.rows as unknown as Run[]) : [];
  if (!rows.length) return null;
  const shown = all ? rows : rows.slice(0, ASIDE_FIRST);
  // Claude's own words from its latest run; the latest things by name until a run has written them.
  const quieted = runs.find((r) => r.quieted)?.quieted || namedSummary(rows);
  return (
    <section className="min-w-0 pb-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-5 pt-3.5 pb-1.5 text-left outline-none"
      >
        <GroupHead tone="muted">Set aside · {rows.length}</GroupHead>
        <ChevronDown
          className={cn('ml-auto size-3.5 text-text-muted transition-transform', open && 'rotate-180')}
          strokeWidth={1.8}
        />
      </button>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-start gap-2.5 px-5 pb-2.5 text-left outline-none"
      >
        <MoonStar className="mt-0.5 size-3.5 shrink-0 text-text-muted" strokeWidth={1.7} aria-hidden />
        <span className="line-clamp-2 text-xs leading-relaxed text-text-muted">{quieted}</span>
      </button>
      {open && (
        <div className="grid min-w-0 pb-1">
          {shown.map((row) => (
            <AsideRow
              key={row.ref}
              row={row}
              now={now}
              expanded={expanded === row.ref}
              onToggle={() => setExpanded(expanded === row.ref ? null : row.ref)}
            />
          ))}
          {rows.length > shown.length && (
            <button
              type="button"
              onClick={() => setAll(true)}
              className="justify-self-start px-5 py-2 text-xs text-text-muted hover:text-text-primary"
            >
              Show all {rows.length}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** One line per thing; its reason and Show me open beneath it on click. */
function AsideRow({ row, now, expanded, onToggle }: { row: Aside; now: number; expanded: boolean; onToggle: () => void }) {
  const { toast } = useHome();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  // Undoing Claude's change puts the card (or the situation) back as it was.
  const bringBack = async () => {
    setBusy(true);
    const r = await rpc.rig.orch.act({ refs: [row.change], action: 'undo' });
    setBusy(false);
    if (!r.success || r.data.some((x) => !x.ok)) {
      toast(`Couldn't bring back "${row.title}"`);
      return;
    }
    void queryClient.invalidateQueries({ queryKey: SET_ASIDE_KEY });
  };
  const state = row.closed ? 'Done' : 'Keeping an eye on it';
  return (
    <div className={cn('min-w-0 rounded-[10px] mx-2.5 transition-colors', expanded ? 'bg-bg-2/50' : 'hover:bg-bg-2/30')}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="grid w-full min-w-0 grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-x-2.5 px-2.5 py-[7px] text-left outline-none"
      >
        <span
          aria-label={state}
          title={state}
          className={cn('size-1.5 justify-self-center rounded-full', row.closed ? 'bg-status-ok/70' : 'ring-1 ring-text-muted ring-inset')}
        />
        <span className="min-w-0 truncate text-[13px] text-text-secondary">{row.title}</span>
        <span className="text-2xs text-text-muted tabular-nums">{agoShort(Date.parse(row.at), now)}</span>
      </button>
      {expanded && (
        <div className="grid gap-2 px-2.5 pb-2.5 pl-[30px]">
          <p className="text-xs leading-relaxed text-text-muted">
            <span className="text-text-secondary">{state}.</span> {row.reason}
          </p>
          <ActionButton
            variant="quiet"
            size="sm"
            icon={Eye}
            motion="nudge"
            disabled={busy}
            onClick={() => void bringBack()}
            className="-ml-2 h-6 justify-self-start text-accent hover:bg-accent-subtle hover:text-accent"
          >
            Show me
          </ActionButton>
        </div>
      )}
    </div>
  );
}

/** How a session started for a situation reads on the Feed. */
const RUN_STATE: Record<string, { line: string; tone: 'working' | 'warn' | 'done' | 'off' }> = {
  running: { line: 'Claude is on it', tone: 'working' },
  waiting: { line: 'Waiting on your approval', tone: 'warn' },
  done: { line: 'Done: see what it found', tone: 'done' },
  stopped: { line: 'Stopped partway', tone: 'off' },
  failed: { line: "Didn't finish", tone: 'off' },
};

/** A space session's state, from its live chat here; one the app no longer holds has finished. */
function localState(sessionId: string): string {
  const store = rigSessionRegistry.get(sessionId);
  if (!(store instanceof RigChatStore) || store.disposed) return 'done';
  if (store.permissionQueue.length) return 'waiting';
  return store.affordances.isWorking ? 'running' : 'done';
}

/**
 * Work Claude is doing or just did for a situation, under "Claude can take":
 * the latest session started for it, how it stands, and a way to open it.
 * `withHead`: draw the group heading, when no card above has drawn it.
 */
export function ClaudeOnIt({ withHead }: { withHead: boolean }) {
  useRefreshOnFeedChange();
  // Often enough to follow a space session's state, which lives here, not on the relay.
  const now = useNow(5_000);
  const { spaces, open, openInApp } = useHome();
  const { data } = useQuery({
    queryKey: WORKING_KEY,
    queryFn: () => rpc.rig.orch.query({ kind: 'working', limit: 8 }),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  const rows = data?.success && 'rows' in data.data ? (data.data.rows as unknown as Working[]) : [];
  if (!rows.length) return null;
  return (
    <section className="min-w-0">
      {withHead && (
        <div className="px-5 pt-3.5 pb-1.5">
          <GroupHead tone="accent">Claude can take</GroupHead>
        </div>
      )}
      {rows.map((row) => {
        const state = RUN_STATE[row.local ? localState(row.run) : row.status] ?? RUN_STATE.done!;
        // Open the session itself (a space session) or the space's chat (a shared-chat run); the space's page when it isn't on this Mac.
        const openIt = () => {
          const space = spaces.find((s) => s.id === row.space);
          if (space?.root) openInApp(row.local ? { space, sessionId: row.run } : { space });
          else open({ kind: 'space', id: row.space });
        };
        if (row.local && state.tone === 'done')
          return <ResultCard key={row.ref} row={row} ago={agoShort(Date.parse(row.ended ?? row.at), now)} onOpen={openIt} />;
        return (
          <button
            key={row.ref}
            type="button"
            onClick={openIt}
            className="group grid w-full outline-none focus-visible:bg-bg-2/40 min-w-0 grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-x-2 border-b border-border-hairline px-5 py-3.5 text-left transition-colors hover:bg-bg-2/40"
          >
            <span className="grid place-items-center">
              {state.tone === 'working' ? (
                <DotMatrix state="searching" size="sm" />
              ) : (
                <span
                  aria-hidden
                  className={cn(
                    'size-1.5 rounded-full',
                    state.tone === 'warn' && 'bg-status-warn',
                    state.tone === 'done' && 'bg-status-ok',
                    state.tone === 'off' && 'bg-text-muted'
                  )}
                />
              )}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-base leading-[1.3] font-semibold text-text-primary">{row.title}</span>
              <span
                className={cn(
                  'mt-0.5 block truncate text-meta',
                  state.tone === 'working' ? 'text-accent' : state.tone === 'warn' ? 'text-status-warn' : 'text-text-muted'
                )}
              >
                {state.line}
                {row.spaceName ? ` · #${row.spaceName}` : ''} · {agoShort(Date.parse(row.ended ?? row.at), now)}
              </span>
            </span>
            <ArrowUpRight className="size-3.5 text-text-muted opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={1.8} />
          </button>
        );
      })}
    </section>
  );
}

/** A finished session's own title and what it found: its last answer, read from the stored session. */
function useSessionResult(sessionId: string): {
  title: string | null;
  result: SessionResult | null;
  /** Read, and it never answered: it stopped first. */
  noAnswer: boolean;
} {
  const { data } = useQuery({
    queryKey: ['rig', 'sessions', 'result', sessionId],
    queryFn: async () => {
      const [session, events] = await Promise.all([
        rpc.rig.sessions.getSession({ sessionId }),
        loadAllSessionEvents(async ({ afterSeq, limit }) => {
          const page = await rpc.rig.sessions.getEventsPage({ sessionId, afterSeq, limit });
          return { events: page.events, nextAfterSeq: page.nextCursor };
        }),
      ]);
      const answer = lastAnswer(parseStoredEvents(events).turns);
      return { title: session?.title ?? null, result: answer ? sessionResult(answer) : null };
    },
    staleTime: 60_000,
  });
  return { title: data?.title ?? null, result: data?.result ?? null, noAnswer: !!data && !data.result };
}

/**
 * A session Claude finished for you, as a card: what it was, what it found
 * (the opening of its answer), what it left for you to decide, and Open.
 */
function ResultCard({ row, ago, onOpen }: { row: Working; ago: string; onOpen: () => void }) {
  const { title, result, noAnswer } = useSessionResult(row.run);
  return (
    <div className="border-b border-border-hairline px-5 py-3.5" data-testid="feed-result">
      <article className="grid min-w-0 gap-1.5">
        <div className="grid grid-cols-[20px_minmax(0,1fr)] items-center gap-2">
          <span className="grid place-items-center">
            <DotMatrix state={noAnswer ? 'stopped' : 'done'} size="sm" tone={noAnswer ? 'mute' : 'ok'} />
          </span>
          <span className="truncate text-meta text-text-muted">
            {noAnswer ? 'Claude stopped before answering' : 'Claude finished this'}
            {row.spaceName ? ` in #${row.spaceName}` : ''} · {ago}
          </span>
        </div>
        <button
          type="button"
          onClick={onOpen}
          className="ml-7 text-left text-base leading-[1.3] font-semibold text-text-primary decoration-border-strong underline-offset-[3px] hover:underline"
        >
          {title ?? row.title}
        </button>
        {result?.lead && <p className="ml-7 line-clamp-3 text-ui leading-[1.6] text-text-secondary">{result.lead}</p>}
        {noAnswer && (
          <p className="ml-7 text-ui leading-[1.6] text-text-muted">Open it to see how far it got, or send it on.</p>
        )}
        <div className="mt-1.5 flex items-center gap-2.5 pl-7">
          {result && result.decisions > 0 && (
            <span className="rounded-full bg-status-warn/10 px-2 py-0.5 text-meta text-status-warn">
              {result.decisions === 1 ? '1 decision for you' : `${result.decisions} decisions for you`}
            </span>
          )}
          <span className="flex-1" />
          <ActionButton icon={PanelRightOpen} variant="primary" size="sm" onClick={onOpen}>
            Open
          </ActionButton>
        </div>
      </article>
    </div>
  );
}

/**
 * Beside the Feed's title, in one quiet line: the tools Rig reads (their
 * logos), when it last checked, and Check now. While it reads, it says so.
 */
export function RunStatus() {
  useRefreshOnFeedChange();
  const now = useNow(30_000);
  const queryClient = useQueryClient();
  const [asked, setAsked] = useState(false);
  const { data: status } = useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => rpc.rig.orch.agentStatus(),
    refetchInterval: 10_000,
  });
  const running = asked || (status?.success ? status.data.running : false);
  const { data } = useQuery({
    queryKey: RUN_KEY,
    queryFn: () => rpc.rig.orch.query({ kind: 'runs', limit: 3 }),
    staleTime: 60_000,
    refetchInterval: running ? 15_000 : false,
  });
  const runs = data?.success && 'rows' in data.data ? (data.data.rows as unknown as Run[]) : [];
  // The latest run that ended with a note: a run in progress has read nothing yet.
  const last = runs.find((r) => r.ended && r.read.length) ?? runs[0] ?? null;
  const checked = last?.read.map((r) => r.source).filter(Boolean) ?? [];
  const tools = useReads();

  const checkNow = async () => {
    setAsked(true);
    await rpc.rig.orch.runNow();
    setAsked(false);
    void queryClient.invalidateQueries({ queryKey: RUN_KEY });
    void queryClient.invalidateQueries({ queryKey: SET_ASIDE_KEY });
  };
  const when = last ? agoShort(Date.parse(last.ended ?? last.at), now) : null;
  const said = running
    ? 'Claude is reading your work'
    : last
      ? `Rig checked ${checked.length ? checked.map(nameOf).join(' and ') : 'your tools'} ${when}`
      : "Rig hasn't checked yet";

  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs text-text-muted [-webkit-app-region:no-drag]" title={said}>
      <span className="flex shrink-0 items-center gap-1" aria-label={`Reads ${tools.map((t) => t.name).join(', ')}, read only`}>
        {tools.map((t) =>
          t.known ? (
            <SourceLogo key={t.key} connector={t.known} size={12} />
          ) : (
            <Plug key={t.key} className="size-3" strokeWidth={1.75} aria-hidden />
          )
        )}
      </span>
      {running ? (
        <span className="flex min-w-0 items-center gap-1.5 text-accent">
          <DotMatrix state="searching" size="sm" />
          <span className="truncate">Reading…</span>
        </span>
      ) : (
        <span className="truncate">{when ?? 'Not checked yet'}</span>
      )}
      <button
        type="button"
        aria-label="Check now"
        title="Check now"
        disabled={running}
        onClick={() => void checkNow()}
        className="grid size-6 shrink-0 place-items-center rounded-control text-text-muted transition-colors hover:bg-bg-2 hover:text-text-primary disabled:opacity-40"
      >
        <RefreshCw className={cn('size-3', running && 'animate-spin')} strokeWidth={1.75} />
      </button>
    </div>
  );
}

/** A source as its note names it, the way the person knows it. */
const nameOf = (source: string) => source.charAt(0).toUpperCase() + source.slice(1);

/** What a run reads when the person has no sources of their own (`main/rig/orch/agent.ts`). */
const DEFAULT_READS = ['slack', 'linear', 'github'];

/**
 * What the background run reads: the sources the person keeps on (Connect's
 * switches, or ones they added), one per tool, each by its own name; else
 * what a run falls back to.
 */
function useReads(): { key: string; name: string; known: KnownTool | null }[] {
  const { data } = useQuery({
    queryKey: SOURCES_KEY,
    queryFn: () => rpc.rig.orch.sources(),
    staleTime: 30_000,
  });
  const on = data?.success ? data.data.filter((row) => !row.paused).map((row) => row.connector) : [];
  const tools = [...new Map((on.length ? on : DEFAULT_READS).map((c) => [toolKey(c), c])).values()];
  return tools.map((c) => {
    const known = knownTool(c);
    return { key: toolKey(c), name: known ? sourceName(known) : c, known };
  });
}
