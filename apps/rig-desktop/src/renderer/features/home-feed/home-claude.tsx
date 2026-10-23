import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Composer } from '@renderer/features/spaces/components/composer';
import { SessionCard } from '@renderer/features/spaces/components/session-card';
import { MessageRow } from '@renderer/features/spaces/components/transcript-items';
import type { RoomAgent, RoomMember, RoomMessage, RoomSnapshot } from '@renderer/features/spaces/types';
import { events, rpc } from '@renderer/lib/ipc';
import { homeChatRunChannel, type HomeChatRun } from '@shared/rig/home-chat';

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

/** The conversation: each message and Claude's run card under it, kept scrolled to the newest. */
export function HomeRuns({ runs, name, header }: { runs: HomeChatRun[]; name: string; header: React.ReactNode }) {
  const me = useMemo(() => member(name), [name]);
  const busy = runs.some((r) => r.status === 'running');
  const agents = useMemo<RoomAgent[]>(() => [{ agent: 'claude', owner: ME, model: runs.at(-1)?.model ?? '', busy }], [runs, busy]);
  const snapshot = useMemo(() => snapshotOf(me, agents), [me, agents]);
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [runs]);
  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]">
      <div className="mx-auto flex max-w-[44rem] flex-col gap-4 px-3 pt-[22px] pb-6">
        {header}
        {runs.map((run) => (
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
        ))}
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
