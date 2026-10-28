import { ArrowUpRight } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Composer } from '@renderer/features/spaces/components/composer';
import { SessionCard } from '@renderer/features/spaces/components/session-card';
import { MessageRow } from '@renderer/features/spaces/components/transcript-items';
import type { RoomAgent, RoomMember, RoomMessage, RoomSnapshot } from '@renderer/features/spaces/types';
import { events, rpc } from '@renderer/lib/ipc';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { homeChatRunChannel, type HomeChatRun } from '@shared/rig/home-chat';
import { noteWords, type HomeNote } from './home-notes';

/**
 * Home's chat with the person's own Claude, drawn like a space's Room: your
 * message as a bubble, then Claude's run card (the steps it took, its answer,
 * Stop and Retry). Main owns the session (`rpc.rig.homeChat`, with Rig's tools
 * and Home's rules) and records each message as a run, the same raw updates a
 * space records; this only reads them and sends.
 */

/** Home's runs, live; null until the session is open (it opens as Home loads, so the first message doesn't wait). */
export function useHomeRuns(enabled: boolean): HomeChatRun[] | null {
  const [runs, setRuns] = useState<HomeChatRun[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let gone = false;
    const off = events.on(homeChatRunChannel, ({ run }) => {
      setRuns((was) => {
        const list = was ?? [];
        const at = list.findIndex((r) => r.id === run.id);
        return at < 0 ? [...list, run] : list.map((r, i) => (i === at ? run : r));
      });
    });
    void rpc.rig.homeChat
      .open()
      .catch(() => null)
      .then(async (r) => {
        if (gone || !r?.success) return;
        const now = await rpc.rig.homeChat.runs();
        if (!gone) setRuns((was) => (was?.length ? was : now));
      });
    return () => {
      gone = true;
      off();
      setRuns(null);
    };
  }, [enabled]);
  return runs;
}

export function sendToHomeClaude(text: string): void {
  void rpc.rig.homeChat.ask({ text });
}

const ME = 'me';

function member(name: string): RoomMember {
  return { id: ME, name, email: '', role: '', initial: name[0]?.toUpperCase() ?? 'Y', status: 'here' };
}

function snapshotOf(me: RoomMember, agents: RoomAgent[]): RoomSnapshot {
  return {
    name: 'Home',
    ready: true,
    members: [me],
    agents,
    connectors: [],
    skills: [],
    messages: [],
    invitesById: {},
    sessionMetaByRun: {},
    sessionEventsByRun: {},
    typingUserIds: [],
  };
}

const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

function askedMessage(run: HomeChatRun): RoomMessage {
  return { id: `${run.id}:ask`, seq: 0, authorId: ME, createdAt: run.at, time: TIME.format(new Date(run.at)), body: run.prompt, meta: { kind: 'text' } };
}

/** The conversation, oldest first: each message with Claude's run card under it, and Rig's notes between them. */
type Entry = { at: number; run: HomeChatRun; note?: never } | { at: number; note: HomeNote; run?: never };

/** The conversation, kept scrolled to the newest. */
export function HomeRuns({
  runs,
  notes = [],
  onOpenNote,
  name,
  header,
}: {
  runs: HomeChatRun[];
  /** Rig's own notes on the work it started (home-notes.ts), in among the runs by time. */
  notes?: readonly HomeNote[];
  onOpenNote?: (note: HomeNote) => void;
  name: string;
  header: React.ReactNode;
}) {
  const entries = useMemo<Entry[]>(
    () =>
      [
        ...runs.map((run) => ({ at: Date.parse(run.at) || 0, run })),
        ...notes.map((note) => ({ at: note.at, note })),
      ].sort((a, b) => a.at - b.at),
    [runs, notes]
  );
  const me = useMemo(() => member(name), [name]);
  const busy = runs.some((r) => r.status === 'running');
  const agents = useMemo<RoomAgent[]>(() => [{ agent: 'claude', owner: ME, model: runs.at(-1)?.model ?? '', busy }], [runs, busy]);
  const snapshot = useMemo(() => snapshotOf(me, agents), [me, agents]);
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);
  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]">
      <div className="mx-auto flex max-w-[44rem] flex-col gap-4 px-3 pt-[22px] pb-6">
        {header}
        {entries.map(({ run, note }) =>
          note ? (
            <RigNote key={note.id} note={note} onOpen={onOpenNote} />
          ) : (
          <div key={run.id} className="flex flex-col gap-4">
            <MessageRow message={askedMessage(run)} snapshot={snapshot} ownId={ME} />
            <SessionCard
              meta={{ id: run.id, agent: 'claude', owner: ME, model: run.model, title: run.prompt, status: run.status, startedAt: run.at, endedAt: run.endedAt }}
              events={run.events}
              owner={me}
              viewerIsOwner
              messageId={run.id}
              prompt={run.prompt}
              onStop={async () => {
                await rpc.rig.homeChat.stop();
                return true;
              }}
              onRerun={async (_agent, prompt) => {
                sendToHomeClaude(prompt);
                return true;
              }}
              members={[me]}
              ownId={ME}
            />
          </div>
          )
        )}
      </div>
    </div>
  );
}

/** One of Rig's notes: what it started for you, or that it's ready, and the way to it. */
function RigNote({ note, onOpen }: { note: HomeNote; onOpen?: (note: HomeNote) => void }) {
  const words = noteWords(note);
  return (
    <div className="hf-rise grid grid-cols-[28px_minmax(0,1fr)] gap-2.5" data-home-note={note.kind}>
      <span className="hf-rig-tile grid size-7 place-items-center rounded-[8px] border border-border-hairline bg-bg-2">
        <DotMatrix state={note.kind === 'started' ? 'reading' : note.kind === 'review' ? 'waiting' : 'done'} size="sm" />
      </span>
      <div className="min-w-0">
        <div className="mb-0.5 text-meta text-text-muted">Rig · {TIME.format(new Date(note.at))}</div>
        <p className="m-0 text-chat leading-[1.6] text-text-primary">
          {words.before}
          <b className="font-semibold">{note.title}</b>
          {words.after}{' '}
          {onOpen && (
            <button
              type="button"
              onClick={() => onOpen(note)}
              className="inline-flex items-center gap-0.5 align-baseline text-accent hover:opacity-80"
            >
              Open
              <ArrowUpRight className="size-3.5" strokeWidth={2} />
            </button>
          )}
        </p>
      </div>
    </div>
  );
}

/** The Room's composer, for Home: you and your Claude, nothing to attach yet. */
export function HomeComposer({ name, busy, onSend }: { name: string; busy: boolean; onSend: (text: string) => void }) {
  const me = useMemo(() => member(name), [name]);
  const agents = useMemo<RoomAgent[]>(() => [{ agent: 'claude', owner: ME, model: '', busy }], [busy]);
  return (
    <Composer
      spaceName="Home"
      members={[me]}
      agents={agents}
      skills={[]}
      busyAgents={busy ? ['claude'] : []}
      placeholder="Ask Rig, or tell it what to start"
      onSend={(text) => onSend(text)}
    />
  );
}
