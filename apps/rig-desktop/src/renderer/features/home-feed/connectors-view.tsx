import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Eye, Plus, RefreshCw, ThumbsUp } from 'lucide-react';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { connectorsApi } from '@renderer/features/spaces/connectors-api';
import { ConnectorLogo } from '@renderer/features/spaces/logos';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import { CONNECTORS } from '@shared/spaces/connectors';
import { ActionButton } from './action-button';
import { Kicker, SourceLogo } from './bits';
import { ClassifyQueue, JoinLayer, useClassifyFlights } from './classify-flight';
import { agoShort, resultLine, type Topic, type WatchedConnector } from './connectors-model';
import { useHome } from './home-context';

/**
 * The right panel's other side: your connectors at work. What Rig does for
 * you in the background, shown as it happens: each connector's watch session
 * checking on its schedule, today's items landing in the grid colored by
 * topic, and the topics as the Room's pills, with where each stands (in your
 * Feed, held back with Rig's reason, or just watched).
 */

/** Topics shown before the rest fold into "+N", like the Room's dock. */
const MAX_PILLS = 7;

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

export function ConnectorsView({
  onOpenFeedItem,
}: {
  onOpenFeedItem: (itemId: string | null) => void;
}) {
  const { connectors, state, reducedMotion } = useHome();
  const now = useNow(15_000);
  const { flights, hidden, popping, unborn, land } = useClassifyFlights(
    connectors.cells,
    reducedMotion
  );

  const openTopicInFeed = (topicId: string) => {
    const entry = state.feed.find((e) => e.item.topicId === topicId);
    onOpenFeedItem(entry?.item.id ?? null);
  };

  return (
    <div className="grid gap-5 px-5 pt-1 pb-6">
      <section>
        <div className="mb-1 flex items-center">
          <Kicker>Connectors</Kicker>
          <ConnectMenu />
        </div>
        <div className="grid gap-px">
          {connectors.connectors.map((c) => (
            <WatchedRow key={c.id} connector={c} now={now} />
          ))}
          <OtherConnected />
        </div>
        {/* What the checks bring back waits here while Claude sorts it. */}
        <ClassifyQueue flights={flights} topics={connectors.topics} />
      </section>

      <section>
        <Kicker className="mb-2">Today · {connectors.cells.length}</Kicker>
        <TodayGrid hidden={hidden} popping={popping} />
      </section>

      <section>
        <Kicker className="mb-2">Topics</Kicker>
        <TopicPills onOpenInFeed={openTopicInFeed} unborn={unborn} />
        <JoinLayer flights={flights} topics={connectors.topics} onLand={land} />
      </section>
    </div>
  );
}

function WatchedRow({ connector: c, now }: { connector: WatchedConnector; now: number }) {
  const { checkNow } = useHome();
  return (
    <div
      data-connector-row={c.connector}
      className="group rounded-[10px] px-1.5 py-2 transition-colors hover:bg-bg-2/60"
    >
      <div className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2.5">
        <span className="grid place-items-center">
          <SourceLogo connector={c.connector} size={18} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-ui font-medium">
            {c.name} <span className="font-normal text-text-secondary">· {c.scope}</span>
          </span>
          {c.checking ? (
            <span className="flex items-center gap-1.5 text-xs text-accent">
              <DotMatrix state="searching" size="sm" />
              Claude is checking…
            </span>
          ) : (
            <span className="block truncate text-xs text-text-muted">
              Checked {agoShort(c.lastCheckAt, now)} · {resultLine(c)}
            </span>
          )}
        </span>
        <span className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label={`Check ${c.name} now`}
            title={`Check now (usually ${c.cadence})`}
            onClick={() => checkNow(c.connector)}
            disabled={c.checking}
            className="grid size-6 place-items-center rounded-control text-text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-bg-3 hover:text-text-primary focus-visible:opacity-100 disabled:opacity-0"
          >
            <RefreshCw className="size-3.5" strokeWidth={1.8} />
          </button>
          <span
            className="min-w-[2ch] text-right font-mono text-2xs text-text-muted tabular-nums"
            title="Today"
          >
            {c.today}
          </span>
        </span>
      </div>
    </div>
  );
}

const CONNECTORS_KEY = ['rig', 'connectors', 'list'];

/** Your other connected connectors: Rig can read them, but no watch session checks them yet. */
function OtherConnected() {
  const { connectors, toast } = useHome();
  const { data } = useQuery({
    queryKey: CONNECTORS_KEY,
    queryFn: () => connectorsApi.list(),
    staleTime: 30_000,
  });
  const watched = new Set(connectors.connectors.map((c) => c.connector as string));
  const rows = (data ?? []).filter((s) => s.state !== 'not_connected' && !watched.has(s.id));
  return (
    <>
      {rows.map((s) => {
        const def = CONNECTORS.find((d) => d.id === s.id);
        if (!def) return null;
        return (
          <div
            key={s.id}
            className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2.5 px-1.5 py-2"
          >
            <span className="grid place-items-center">
              <ConnectorLogo id={def.id} name={def.name} brand={def.brand} size={18} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-ui font-medium">{def.name}</span>
              <span className="block truncate text-xs text-text-muted">
                {s.state === 'expired' ? 'Signed out' : 'Connected, not watched yet'}
              </span>
            </span>
            <ActionButton
              variant="quiet"
              size="sm"
              icon={s.state === 'expired' ? RefreshCw : Eye}
              motion="nudge"
              onClick={() =>
                s.state === 'expired'
                  ? void connectorsApi.connect(def.id)
                  : toast(`Rig will start watching ${def.name} once its watch sessions ship`)
              }
            >
              {s.state === 'expired' ? 'Sign in' : 'Watch'}
            </ActionButton>
          </div>
        );
      })}
    </>
  );
}

/** Connect another: the catalog, signing in the same way a space does. */
function ConnectMenu() {
  const { toast } = useHome();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data } = useQuery({
    queryKey: CONNECTORS_KEY,
    queryFn: () => connectorsApi.list(),
    staleTime: 30_000,
  });
  const state = new Map((data ?? []).map((s) => [s.id, s.state]));
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const connect = async (id: (typeof CONNECTORS)[number]['id'], name: string) => {
    setOpen(false);
    const result = await connectorsApi.connect(id);
    void queryClient.invalidateQueries({ queryKey: CONNECTORS_KEY });
    toast(result.ok ? `${name} is connected` : `${name} didn't connect`);
  };
  return (
    <div ref={ref} className="relative ml-auto">
      <ActionButton
        variant="quiet"
        size="sm"
        icon={Plus}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        Connect
      </ActionButton>
      {open && (
        <div
          role="menu"
          className="hf-menu-in absolute top-[calc(100%+6px)] right-0 z-30 grid max-h-80 w-64 gap-px overflow-y-auto rounded-[12px] border border-border-hairline bg-bg-1 p-1.5 shadow-float"
        >
          {CONNECTORS.map((d) => {
            const connected = state.get(d.id) === 'connected';
            return (
              <button
                key={d.id}
                type="button"
                role="menuitem"
                disabled={connected}
                onClick={() => void connect(d.id, d.name)}
                className="flex items-center gap-2.5 rounded-[8px] px-2 py-1.5 text-left text-sm hover:bg-bg-2 disabled:hover:bg-transparent"
              >
                <ConnectorLogo id={d.id} name={d.name} brand={d.brand} size={16} />
                <span className="min-w-0 flex-1 truncate">{d.name}</span>
                {connected && <Check className="size-3.5 text-status-ok" strokeWidth={2} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Today's items as cells, colored by topic; new ones pulse in. Focusing a topic dims the rest. */
function TodayGrid({
  hidden,
  popping,
}: {
  hidden: ReadonlySet<string>;
  popping: ReadonlySet<string>;
}) {
  const { connectors, connectorsDispatch } = useHome();
  const byId = new Map(connectors.topics.map((t) => [t.id, t]));
  const checking = connectors.connectors.some((c) => c.checking);
  return (
    <div className="grid grid-cols-[repeat(24,minmax(0,1fr))] gap-[3px]">
      {connectors.cells.map((cell) => {
        const topic = byId.get(cell.topic);
        const dim = connectors.focus !== null && connectors.focus !== cell.topic;
        return (
          <button
            key={cell.id}
            type="button"
            title={`${cell.ref} · ${cell.title} → ${topic?.name ?? ''}`}
            aria-label={`${cell.ref}: ${cell.title}, in ${topic?.name ?? 'no topic'}`}
            onClick={() =>
              connectorsDispatch({
                type: 'focus',
                topic: connectors.focus === cell.topic ? null : cell.topic,
              })
            }
            data-cell-id={cell.id}
            style={{ '--hue': `var(--theme-${topic?.hue ?? 4})` } as CSSProperties}
            className={cn(
              'hf-cell aspect-square rounded-[3px]',
              // Hidden while it waits to be sorted; it pops in as it joins its topic.
              hidden.has(cell.id)
                ? 'invisible'
                : (popping.has(cell.id) || cell.fresh) && 'hf-cell-fresh',
              dim && 'opacity-20'
            )}
          />
        );
      })}
      {/* Where the next item will land, while Claude is checking. */}
      {checking && <span aria-hidden className="hf-cell-next aspect-square rounded-[3px]" />}
    </div>
  );
}

/** New first, then what's in your Feed, then the rest, held back last. */
function order(topics: readonly Topic[]): Topic[] {
  const rank = (t: Topic) =>
    t.fresh > 0 ? 0 : t.state === 'feed' ? 1 : t.state === 'none' ? 2 : 3;
  return [...topics].sort((a, b) => rank(a) - rank(b));
}

/** The topics as the Room's pills; the focused one opens a card with its items and where it stands. */
function TopicPills({
  onOpenInFeed,
  unborn,
}: {
  onOpenInFeed: (topicId: string) => void;
  /** Topics an item still being sorted starts: their pill holds its place, unseen, until it joins. */
  unborn: ReadonlySet<string>;
}) {
  const { connectors, connectorsDispatch } = useHome();
  const [all, setAll] = useState(false);
  // While a topic is open, the order holds still: it stays where you clicked it and its
  // card pushes the pills after it down. New topics join at the end until you close it.
  const held = useRef<string[]>([]);
  const byId = new Map(connectors.topics.map((t) => [t.id, t]));
  const live = order(connectors.topics).map((t) => t.id);
  if (connectors.focus === null) held.current = live;
  const ids =
    connectors.focus === null
      ? live
      : [
          ...held.current.filter((id) => byId.has(id)),
          ...live.filter((id) => !held.current.includes(id)),
        ];
  const sorted = ids.map((id) => byId.get(id)!);
  const shown = all ? sorted : sorted.slice(0, MAX_PILLS);
  const more = sorted.length - shown.length;
  return (
    <div className="flex flex-wrap items-start gap-1.5">
      {shown.map((t) => (
        <div key={t.id} className="contents">
          <TopicPill
            topic={t}
            unborn={unborn.has(t.id)}
            focused={connectors.focus === t.id}
            onClick={() =>
              connectorsDispatch({ type: 'focus', topic: connectors.focus === t.id ? null : t.id })
            }
          />
          {connectors.focus === t.id && (
            <TopicCard topic={t} onOpenInFeed={() => onOpenInFeed(t.id)} />
          )}
        </div>
      ))}
      {more > 0 && (
        <button
          type="button"
          onClick={() => setAll(true)}
          data-topic-more
          className="hf-topic-pill h-[30px] rounded-full px-3 text-xs text-text-secondary hover:text-text-primary"
        >
          +{more}
        </button>
      )}
    </div>
  );
}

function TopicPill({
  topic,
  unborn,
  focused,
  onClick,
}: {
  topic: Topic;
  unborn: boolean;
  focused: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={focused}
      data-topic-pill={topic.id}
      className={cn(
        'hf-topic-pill flex h-[30px] max-w-full items-center gap-2 rounded-full pr-3 pl-2.5 text-xs whitespace-nowrap',
        topic.state === 'held' ? 'text-text-secondary' : 'text-text-primary',
        unborn && 'invisible',
        focused && 'shadow-[inset_0_0_0_1.5px_var(--accent)]'
      )}
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ background: `var(--theme-${topic.hue})` }}
      />
      <span className="max-w-[200px] min-w-0 truncate">{topic.name}</span>
      <span className="font-mono text-2xs text-text-muted tabular-nums">
        {topic.count}
        {topic.state === 'held' && ' · held'}
      </span>
      {topic.state === 'feed' && (
        <span
          title="In your Feed"
          className="size-1.5 shrink-0 rounded-full bg-accent shadow-[0_0_0_2px_var(--accent-subtle)]"
        />
      )}
      {topic.fresh > 0 && (
        <span className="font-mono text-2xs leading-none tracking-wide text-accent uppercase">
          new
        </span>
      )}
    </button>
  );
}

function TopicCard({ topic, onOpenInFeed }: { topic: Topic; onOpenInFeed: () => void }) {
  const { promoteTopic, connectorsDispatch, toast } = useHome();
  return (
    <div className="hf-menu-in hf-topic-card my-0.5 grid w-full gap-2 rounded-[16px] px-3.5 py-3">
      <div className="grid gap-1">
        {topic.items.slice(0, 4).map((item, i) => (
          <div
            key={`${item.ref}-${i}`}
            className="grid grid-cols-[16px_64px_minmax(0,1fr)] items-center gap-2 text-xs"
          >
            <SourceLogo connector={item.connector} size={14} />
            <span className="truncate font-mono text-2xs text-text-secondary">{item.ref}</span>
            <span className="truncate text-text-primary">
              {item.title}
              {item.flag && <span className="text-status-warn"> · {item.flag}</span>}
            </span>
          </div>
        ))}
      </div>
      {topic.state === 'feed' && (
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <span className="flex-1">In your Feed.</span>
          <ActionButton variant="secondary" size="sm" icon={Eye} onClick={onOpenInFeed}>
            Open in Feed
          </ActionButton>
        </div>
      )}
      {topic.state === 'held' && (
        <div className="grid gap-2 text-xs text-text-secondary">
          <span>Held back: {topic.why}</span>
          <div className="flex gap-1.5">
            <ActionButton
              variant="secondary"
              size="sm"
              icon={Eye}
              onClick={() => promoteTopic(topic.id)}
            >
              Show me these
            </ActionButton>
            <ActionButton
              variant="quiet"
              size="sm"
              icon={ThumbsUp}
              motion="nudge"
              onClick={() => {
                connectorsDispatch({
                  type: 'topic-state',
                  topic: topic.id,
                  state: 'held',
                  why: 'You agreed. Rig keeps these out of your way.',
                });
                toast('Thanks, noted');
              }}
            >
              Right call
            </ActionButton>
          </div>
        </div>
      )}
      {topic.state === 'none' && (
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <span className="flex-1">Rig is keeping an eye on it.</span>
          <ActionButton
            variant="secondary"
            size="sm"
            icon={Plus}
            onClick={() => promoteTopic(topic.id)}
          >
            Add to your Feed
          </ActionButton>
        </div>
      )}
    </div>
  );
}
