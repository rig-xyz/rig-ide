import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { rigFeedChangedChannel } from '@shared/rig/feed';
import { ActionButton } from './action-button';
import { Kicker, SourceLogo, sourceName } from './bits';
import { agoShort } from './connectors-model';
import { type Followed, groupByTopic, hueOf, NO_TOPIC, type Run } from './following-model';
import { useHome } from './home-context';

/**
 * The right panel's other side, when the background orchestrator keeps the
 * Feed: what Rig follows for you but doesn't need you yet, grouped by the
 * topics Claude gives them, so a short Feed never looks like nothing
 * happened. Any of them can be put on the Feed. The footer says what the last
 * run read and did, and which connectors Claude can read.
 */

const FOLLOWING_KEY = ['rig', 'orch', 'following'] as const;
const RUN_KEY = ['rig', 'orch', 'last-run'] as const;
const STATUS_KEY = ['rig', 'orch', 'agent-status'] as const;

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

export function FollowingView() {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      events.on(rigFeedChangedChannel, () => {
        void queryClient.invalidateQueries({ queryKey: FOLLOWING_KEY });
        void queryClient.invalidateQueries({ queryKey: RUN_KEY });
      }),
    [queryClient]
  );
  const { data } = useQuery({
    queryKey: FOLLOWING_KEY,
    queryFn: () => rpc.rig.orch.query({ kind: 'situations', filter: { feed: 'following' }, limit: 200 }),
    staleTime: 60_000,
  });
  const rows = data?.success && 'rows' in data.data ? (data.data.rows as unknown as Followed[]) : null;
  const groups = rows ? groupByTopic(rows) : [];

  return (
    <div className="flex min-h-full flex-col">
      <div className="grid min-w-0 flex-1 content-start gap-5 px-5 pt-1 pb-6">
        <section className="min-w-0">
          <Kicker className="mb-1">Following{rows ? ` · ${rows.length}` : ''}</Kicker>
          <p className="mb-2 text-xs text-text-muted">What Rig keeps an eye on for you. Nothing here needs you yet.</p>
          {rows && !rows.length && <p className="py-2 text-sm text-text-muted">Nothing followed yet.</p>}
          <div className="grid min-w-0 gap-4">
            {groups.map((g) => (
              <TopicGroup key={g.topic} topic={g.topic} rows={g.rows} />
            ))}
          </div>
        </section>
      </div>
      <RunFooter />
    </div>
  );
}

function TopicGroup({ topic, rows }: { topic: string; rows: Followed[] }) {
  const now = useNow(60_000);
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center gap-2 px-1.5">
        <span
          aria-hidden
          className="size-2 rounded-full"
          style={{ background: topic === NO_TOPIC ? 'var(--text-muted)' : `var(--theme-${hueOf(topic)})` }}
        />
        <span className="text-xs font-medium text-text-secondary">{topic}</span>
        <span className="font-mono text-2xs text-text-muted tabular-nums">{rows.length}</span>
      </div>
      <div className="grid min-w-0 gap-px">
        {rows.map((r) => (
          <FollowedRow key={r.ref} row={r} now={now} />
        ))}
      </div>
    </div>
  );
}

function FollowedRow({ row, now }: { row: Followed; now: number }) {
  const { toast, firstName } = useHome();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  // Everyone but you: you're in all of them.
  const others = row.people.filter((p) => p.split(' ')[0] !== firstName);
  const putOnFeed = async () => {
    setBusy(true);
    const r = await rpc.rig.orch.act({ refs: [row.ref], action: 'show', args: { reason: 'You put it on your Feed' } });
    if (!r.success || r.data.some((x) => !x.ok)) {
      setBusy(false);
      toast(`Couldn't put "${row.title}" on your Feed`);
      return;
    }
    void queryClient.invalidateQueries({ queryKey: FOLLOWING_KEY });
    toast(`Claude is writing the card for "${row.title}"`);
    // The card is Claude's to write: a run now picks it up.
    void rpc.rig.orch.runNow().finally(() => void queryClient.invalidateQueries({ queryKey: RUN_KEY }));
  };
  return (
    <div className="group relative min-w-0 overflow-hidden rounded-[10px] px-1.5 py-1.5 transition-colors hover:bg-bg-2/60">
      <span className="min-w-0">
        <span className="block truncate text-ui">{row.title}</span>
        {row.line && <span className="line-clamp-2 text-xs text-text-muted">{row.line}</span>}
        <span className="block truncate text-2xs text-text-muted">
          {[others.slice(0, 2).join(', '), agoShort(Date.parse(row.at), now)].filter(Boolean).join(' · ')}
        </span>
      </span>
      <ActionButton
        variant="quiet"
        size="sm"
        icon={ArrowUpRight}
        motion="nudge"
        disabled={busy}
        onClick={() => void putOnFeed()}
        className="absolute top-1.5 right-1.5 bg-bg-2 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        To my Feed
      </ActionButton>
    </div>
  );
}

/** The last background run in one line, Run now, and the connectors Claude reads. */
function RunFooter() {
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
    queryFn: () => rpc.rig.orch.query({ kind: 'runs', limit: 1 }),
    staleTime: 60_000,
    refetchInterval: running ? 15_000 : false,
  });
  const last = data?.success && 'rows' in data.data ? ((data.data.rows[0] as unknown as Run | undefined) ?? null) : null;
  if (status?.success && !status.data.on) return null;

  const runNow = async () => {
    setAsked(true);
    await rpc.rig.orch.runNow();
    setAsked(false);
    void queryClient.invalidateQueries({ queryKey: RUN_KEY });
    void queryClient.invalidateQueries({ queryKey: FOLLOWING_KEY });
  };
  const sources = last?.read.map((r) => r.source).filter(Boolean) ?? [];

  return (
    <div className="sticky bottom-0 border-t border-border-hairline bg-bg-1/95 px-5 pt-3 pb-4 backdrop-blur">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          {running ? (
            <span className="flex items-center gap-1.5 text-xs text-accent">
              <DotMatrix state="searching" size="sm" />
              Claude is reading your work…
            </span>
          ) : last ? (
            <>
              <span className="block truncate text-xs text-text-secondary">
                Last run {agoShort(Date.parse(last.ended ?? last.at), now)}
                {sources.length ? ` · read ${sources.map(nameOf).join(' and ')}` : ''}
                {` · ${last.changed ? `${last.changed} change${last.changed === 1 ? '' : 's'}` : 'no changes'}`}
              </span>
              {last.title && (
                <span className="line-clamp-2 text-2xs text-text-muted" title={last.title}>
                  {last.title}
                </span>
              )}
            </>
          ) : (
            <span className="text-xs text-text-muted">No run yet.</span>
          )}
        </span>
        <ActionButton variant="quiet" size="sm" icon={RefreshCw} disabled={running} onClick={() => void runNow()}>
          Run now
        </ActionButton>
      </div>
      <Reads sources={sources} />
    </div>
  );
}

/** A source as its note names it, the way the person knows it. */
const nameOf = (source: string) => source.charAt(0).toUpperCase() + source.slice(1);

/** What the background run reads: the sources of its last note, and GitHub through gh. */
function Reads({ sources }: { sources: string[] }) {
  const known = (['slack', 'linear', 'granola', 'gmail', 'github'] as const).filter((c) => c === 'github' || sources.includes(c));
  return (
    <div className="mt-2 flex items-center gap-2 text-2xs text-text-muted">
      <span>Reads</span>
      {known.map((c) => (
        <span key={c} className="flex items-center gap-1" title={`${sourceName(c)}, read only`}>
          <SourceLogo connector={c} size={12} />
          {sourceName(c)}
        </span>
      ))}
      <span className="ml-auto">read only</span>
    </div>
  );
}
