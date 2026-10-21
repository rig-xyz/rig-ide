import { relativeTime } from '@renderer/features/chat/session-history';
import type { RigSpaceRunningItem, RigSpaceStatus } from '@shared/rig/space-status';
import type { Person, RailSession, RailSpace } from './model';

/**
 * Turning the app's own data into rail entries, and laying the preview's demo
 * spaces over them. Pure, so the merge rules are tested on their own.
 */

export interface RealSpaceInput {
  bindingId: string;
  name: string;
  path: string | null;
  members: readonly { userId: string; name: string | null }[] | null;
  unread: number;
  status: RigSpaceStatus | undefined;
  chats: readonly { id: string; title: string | null; updatedAt: number }[];
}

const ACTIVITY_WORD: Record<string, string> = {
  thinking: 'Thinking',
  reading: 'Reading',
  searching: 'Searching',
  editing: 'Editing',
  running: 'Running commands',
  planning: 'Planning',
};

/** How many of a space's own chats the rail lists, and how recent they must be. */
export const CHATS_PER_SPACE = 2;
export const CHAT_RECENT_MS = 3 * 24 * 60 * 60 * 1000;

function isRecent(at: number, now: number): boolean {
  return now - at <= CHAT_RECENT_MS;
}

function hueFor(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h % 6) + 1;
}

function agentName(agent: RigSpaceRunningItem['agent']): string {
  return agent === 'codex' ? 'Codex' : 'Claude';
}

export function runToSession(
  spaceId: string,
  run: RigSpaceRunningItem,
  selfUserId: string | null,
  now: number
): RailSession {
  const mine = run.ownerUserId === selfUserId;
  const owner = mine ? undefined : (run.ownerName ?? undefined);
  const who = owner ? `${owner}'s ${agentName(run.agent)}` : agentName(run.agent);
  const waiting = run.activity === 'waiting';
  const state = waiting ? (mine ? 'needs_you' : 'waiting_on_person') : 'running';
  const doing = waiting
    ? mine
      ? 'Needs you'
      : `Waiting on ${owner ?? 'someone'}`
    : (ACTIVITY_WORD[run.activity ?? 'thinking'] ?? 'Working');
  const ago = relativeTime(Date.parse(run.startedAt) || now, now).replace(/ ago$/, '');
  return {
    id: `run:${run.runId}`,
    spaceId,
    name: run.title?.trim() || `${agentName(run.agent)} session`,
    state,
    activity: waiting || !run.activity || run.activity === 'waiting' ? undefined : run.activity,
    short: doing,
    summary: waiting
      ? `${who} is waiting for an answer.`
      : `${who} is working: ${doing.toLowerCase()}.`,
    last: { who, text: doing, ago },
    steps: [{ text: `${who} started this session` }, { text: doing, ago }],
    owner,
    origin: 'real',
  };
}

export function chatToSession(
  spaceId: string,
  chat: RealSpaceInput['chats'][number],
  now: number
): RailSession {
  const ago = relativeTime(chat.updatedAt, now);
  return {
    id: `chat:${chat.id}`,
    spaceId,
    name: chat.title?.trim() || 'Untitled session',
    state: 'idle',
    short: `Last active ${ago}`,
    summary: 'A chat with your agent in this space.',
    last: { who: 'You', text: `Last active ${ago}`, ago: ago.replace(/ ago$/, '') },
    steps: [{ text: `Last active ${ago}`, ago: ago.replace(/ ago$/, '') }],
    origin: 'real',
  };
}

export function realSpaceToRail(
  input: RealSpaceInput,
  selfUserId: string | null,
  now: number
): RailSpace {
  const others = (input.members ?? []).filter((m) => m.userId !== selfUserId);
  const faces: Person[] = others
    .slice(0, 2)
    .map((m) => ({ id: m.userId, name: m.name ?? 'Member', hue: hueFor(m.userId) }));
  const runs = (input.status?.running ?? []).map((run) =>
    runToSession(input.bindingId, run, selfUserId, now)
  );
  const chats = input.chats
    .filter((c) => isRecent(c.updatedAt, now))
    .slice(0, CHATS_PER_SPACE)
    .map((c) => chatToSession(input.bindingId, c, now));
  const shared = input.members ? others.length > 0 : true;
  return {
    id: input.bindingId,
    name: input.name,
    visibility: shared ? 'shared' : 'private',
    faces,
    unread: input.unread,
    summary: shared
      ? `With ${others.map((m) => (m.name ?? 'a member').split(' ')[0]).join(', ') || 'your team'}.`
      : 'Only you.',
    sessions: [...runs, ...chats],
    root: input.path ?? undefined,
    bindingId: input.bindingId,
    origin: 'real',
  };
}

/**
 * Demo spaces first (the Feed is about them), a real space of the same name
 * taking a demo one's place and keeping the demo's sessions after its own;
 * then the rest of the real spaces, newest first. Sessions the user started
 * from Home (`extra`) go on top of their space.
 */
export function mergeRail(
  real: readonly RailSpace[],
  demo: readonly RailSpace[],
  extra: ReadonlyMap<string, RailSession[]> = new Map()
): RailSpace[] {
  const byName = new Map(real.map((s) => [s.name, s]));
  const used = new Set<string>();
  const out: RailSpace[] = [];
  for (const d of demo) {
    const r = byName.get(d.name);
    if (r) {
      used.add(r.id);
      out.push({
        ...r,
        id: d.id,
        summary: d.summary,
        unread: r.unread || d.unread,
        sessions: [...r.sessions.map((x) => ({ ...x, spaceId: d.id })), ...d.sessions],
      });
    } else out.push(d);
  }
  for (const r of real) if (!used.has(r.id)) out.push(r);
  return out.map((s) => {
    const added = extra.get(s.id);
    return added?.length ? { ...s, sessions: [...added, ...s.sessions] } : s;
  });
}
