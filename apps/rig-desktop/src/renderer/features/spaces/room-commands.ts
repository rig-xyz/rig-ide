/**
 * Commands for Rig typed in the Room's composer (spike, Rig Alpha). A command is the whole
 * message ("/new"), is never posted to the Room, and only steers the person's own sessions in the
 * space. Work is asked for in words, not commands, so the list stays this short.
 */
export type RoomCommand = 'new' | 'stop' | 'status' | 'side';

export const ROOM_COMMANDS: readonly { id: RoomCommand; cmd: string; desc: string }[] = [
  { id: 'new', cmd: '/new', desc: 'Start a new conversation with your agent' },
  { id: 'stop', cmd: '/stop', desc: 'Stop what your agent is doing now' },
  { id: 'status', cmd: '/status', desc: 'What your agent is doing and how full its session is' },
  { id: 'side', cmd: '/side', desc: 'Open a private side chat, with what you type after it' },
];

/**
 * "/side" is the one command that takes words: what follows it is the side chat's first message.
 * Null when the message is not a side chat at all.
 */
export function sideChatText(text: string): string | null {
  const match = /^\/side(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? (match[1] ?? '').trim() : null;
}

/** Side chats are Rig Alpha's: without it "/side" is not a command, and what was typed is a message like any other. */
const offered = (sideChats: boolean) => ROOM_COMMANDS.filter((command) => sideChats || command.id !== 'side');

/** The command a message is, or null when it is words for the Room ("/new" inside a sentence is text). */
export function roomCommand(text: string, sideChats: boolean): RoomCommand | null {
  const word = text.trim().toLowerCase();
  if (word === '/new-session') return 'new';
  if (sideChats && sideChatText(text) !== null) return 'side';
  return offered(sideChats).find((command) => command.cmd === word)?.id ?? null;
}

/** Commands whose name starts with what is typed after the slash. */
export function matchRoomCommands(query: string, sideChats: boolean): typeof ROOM_COMMANDS {
  const q = query.toLowerCase();
  return offered(sideChats).filter((command) => command.cmd.slice(1).startsWith(q));
}

const tokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k tokens` : `${n} tokens`);

function since(ms: number, now: number): string {
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** What `/status` says, one line per session the person has in the space. */
export function statusLines(
  sessions: readonly {
    agent: 'claude' | 'codex';
    working: boolean;
    contextTokens: number | null;
    lastTurnAt: number | null;
  }[],
  agentName: Record<'claude' | 'codex', string>,
  now: number
): string[] {
  if (sessions.length === 0) return ['No session yet. Your next message starts one.'];
  return sessions.map((session) =>
    [
      `${agentName[session.agent]}: ${session.working ? 'working' : 'idle'}`,
      session.contextTokens !== null ? `${tokens(session.contextTokens)} in its session` : null,
      !session.working && session.lastTurnAt !== null
        ? `last turn ${since(session.lastTurnAt, now)}`
        : null,
    ]
      .filter(Boolean)
      .join(' · ')
  );
}
