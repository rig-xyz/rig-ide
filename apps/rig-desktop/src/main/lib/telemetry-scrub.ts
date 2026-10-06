import { redactAll } from '@emdash/shared/logger';

/**
 * What an error event may say about an error, beyond its name: a short,
 * scrubbed message and the top stack frame. Pure, so the scrubbing is
 * unit-tested on its own (`telemetry-scrub.test.ts`).
 */

export const MAX_ERROR_MESSAGE_CHARS = 300;

/** Any run of path-ish characters with a `/` or `\\` in it: an absolute, relative or home path, or a URL. */
const PATH_TOKEN = /[^\s'"`()<>[\]{},;]*[\\/][^\s'"`()<>[\]{},;]*/g;

/** A quoted path, which may hold spaces: `'/Users/a/My Folder/b.md'`. */
const QUOTED_PATH = /(['"`])([^'"`\n]*[\\/][^'"`\n]*)\1/g;

function lastPart(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** Every path reduced to its last part: `/Users/a/Code/x/y.ts:3` → `y.ts:3`, `src/a.ts` → `a.ts`. */
export function basenamePaths(value: string): string {
  return value
    .replace(
      QUOTED_PATH,
      (_match, quote: string, path: string) => `${quote}${lastPart(path)}${quote}`
    )
    .replace(PATH_TOKEN, lastPart);
}

/**
 * An error message fit to leave the machine: every path cut to its file
 * name (so no user or folder names), then secrets, emails and IPs removed
 * (the log's own `redactAll`), whitespace collapsed, at most 300 characters.
 */
export function scrubErrorMessage(message: unknown): string {
  if (typeof message !== 'string' || !message) return '';
  const scrubbed = redactAll(basenamePaths(message)).replace(/\s+/g, ' ').trim();
  return scrubbed.length > MAX_ERROR_MESSAGE_CHARS
    ? `${scrubbed.slice(0, MAX_ERROR_MESSAGE_CHARS - 1)}…`
    : scrubbed;
}

/**
 * The top stack frame as `file.ts:line`, file name only. Skips frames with
 * no file (`native`, `<anonymous>`). Empty when there's no usable frame.
 */
export function topStackFrame(error: unknown): string {
  const stack = (error as { stack?: unknown } | null)?.stack;
  if (typeof stack !== 'string') return '';
  for (const line of stack.split('\n').slice(1)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('at ')) continue;
    const located = /\(([^()]+)\)\s*$/.exec(trimmed)?.[1] ?? trimmed.slice(3).trim();
    const match = /^(.*?):(\d+)(?::\d+)?$/.exec(located);
    if (!match) continue;
    const file = match[1]!.split(/[\\/]/).pop() ?? '';
    const clean = file.replace(/\?.*$/, '').replace(/[^A-Za-z0-9_.@$-]/g, '');
    if (!clean) continue;
    return `${clean.slice(0, 80)}:${match[2]}`;
  }
  return '';
}

/** A model id as it may appear in an event: letters, digits and `._-/:[]`, at most 60 characters. */
export function scrubModelId(model: unknown): string | undefined {
  if (typeof model !== 'string') return undefined;
  const clean = model
    .trim()
    .replace(/[^A-Za-z0-9._\-/:[\]]/g, '')
    .slice(0, 60);
  return clean || undefined;
}

/** A version string as it may appear in an event (`0.160.1`, `2.1.149 (Claude Code)` → `2.1.149`). */
export function scrubVersion(version: unknown): string | null {
  if (typeof version !== 'string') return null;
  const match = /\d+(?:\.\d+){0,3}(?:[-+][A-Za-z0-9.]+)?/.exec(version);
  return match ? match[0].slice(0, 40) : null;
}

/** A short code (`EACCES`, `hash_mismatch`): lowercase letters, digits and `_`, at most 40 characters. */
export function scrubCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return clean ? clean.slice(0, 40) : undefined;
}
