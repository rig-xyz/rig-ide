/**
 * Commands for Rig typed in Home's chat, as a space's chat has its own (`room-commands.ts`). A
 * command is the whole message, is never sent to Claude as words, and only steers Home's own
 * conversation. Work, and the skills on this Mac, are asked for in words.
 */
export type HomeCommand = 'new' | 'compact' | 'stop';

export const HOME_COMMANDS: readonly { id: HomeCommand; cmd: string; desc: string; also: readonly string[] }[] = [
  { id: 'new', cmd: '/new', desc: 'Start a new conversation with Rig', also: ['/clear'] },
  {
    id: 'compact',
    cmd: '/compact',
    desc: 'Shorten what was said so far, to make room in a long conversation',
    also: [],
  },
  { id: 'stop', cmd: '/stop', desc: 'Stop what Rig is doing now', also: [] },
];

/** The command a message is, or null when it is words for Rig ("/new" inside a sentence is text). */
export function homeCommand(text: string): HomeCommand | null {
  const word = text.trim().toLowerCase();
  return HOME_COMMANDS.find((command) => command.cmd === word || command.also.includes(word))?.id ?? null;
}

/** Commands whose name, or other name ("/clear" for "/new"), starts with what is typed after the slash. */
export function matchHomeCommands(query: string): typeof HOME_COMMANDS {
  const q = query.toLowerCase();
  return HOME_COMMANDS.filter((command) =>
    [command.cmd, ...command.also].some((name) => name.slice(1).startsWith(q))
  );
}
