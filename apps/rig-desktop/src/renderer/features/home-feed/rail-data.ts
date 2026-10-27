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
  members: readonly { userId: string; name: string | null; avatarUrl?: string | null }[] | null;
  unread: number;
  status: RigSpaceStatus | undefined;
  /** `live`: the chat is running in this window right now (working, or waiting on the person). */
  chats: readonly { id: string; title: string | null; updatedAt: number; live?: 'running' | 'needs_you' }[];
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
/** Chats the space's own page lists, finished ones included: the work Rig started there stays findable. */
export const CHATS_ON_SPACE_PAGE = 8;
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
  const name = chat.title?.trim() || 'Untitled session';
  // Still running here: say so, never "idle · Last active".
  if (chat.live) {
    const working = chat.live === 'running';
    return {
      id: `chat:${chat.id}`,
      spaceId,
      name,
      state: chat.live,
      short: working ? 'Working' : 'Needs you',
      summary: working ? 'Your agent is working in this space.' : 'Your agent is waiting for you.',
      last: { who: 'You', text: working ? 'Working' : 'Needs you', ago: 'now' },
      steps: [{ text: working ? 'Working' : 'Needs you', ago: 'now' }],
      origin: 'real',
    };
  }
  return {
    id: `chat:${chat.id}`,
    spaceId,
    name,
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
  const faces: Person[] = others.slice(0, 2).map((m) => ({
    id: m.userId,
    name: m.name ?? 'Member',
    hue: hueFor(m.userId),
    avatarUrl: m.avatarUrl ?? null,
  }));
  // Runs newest first; a chat that is one of them shows once, as the run.
  const running = [...(input.status?.running ?? [])].sort(
    (a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0)
  );
  const runIds = new Set(running.map((r) => r.runId));
  const runs = running.map((run) => runToSession(input.bindingId, run, selfUserId, now));
  // The space's own chats: what still runs first, then newest first.
  const recent = input.chats
    .filter((c) => !runIds.has(c.id) && (c.live || isRecent(c.updatedAt, now)))
    .sort((a, b) => Number(!!b.live) - Number(!!a.live) || b.updatedAt - a.updatedAt);
  const activity = [
    ...running.map((r) => Date.parse(r.startedAt) || 0),
    ...input.chats.map((c) => (c.live ? now : c.updatedAt)),
  ].filter((t) => t > 0);
  const chats = recent.slice(0, CHATS_PER_SPACE).map((c) => chatToSession(input.bindingId, c, now));
  const history = recent.slice(0, CHATS_ON_SPACE_PAGE).map((c) => chatToSession(input.bindingId, c, now));
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
    history: [...runs, ...history],
    root: input.path ?? undefined,
    bindingId: input.bindingId,
    lastActivityAt: activity.length ? Math.max(...activity) : null,
    origin: 'real',
  };
}

/**
 * The rail's spaces, newest work first: by a space's latest session or run, or by when it was made
 * when nothing ever happened in it.
 */
export function orderSpacesByActivity(entries: readonly { space: RailSpace; madeAt: number }[]): RailSpace[] {
  const at = (e: { space: RailSpace; madeAt: number }) => e.space.lastActivityAt ?? e.madeAt;
  return [...entries].sort((a, b) => at(b) - at(a)).map((e) => e.space);
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
