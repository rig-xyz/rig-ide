import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * A space session's context size in tokens, read from the agent's own
 * session file, for a session Rig has no size for (saved before Rig kept
 * one). Claude Code: the last assistant entry's usage in its transcript,
 * input plus cache writes plus cache reads. Codex: the newest token_count in
 * its rollout. Null when the file or a usage in it can't be found.
 */
export async function readAgentSessionSize(
  input: { providerId: string; cwd: string; sessionId: string },
  homes: { claude?: string; codex?: string } = {}
): Promise<number | null> {
  try {
    if (input.providerId === 'claude') {
      const file = await claudeTranscript(homes.claude ?? claudeHome(), input.cwd, input.sessionId);
      return file ? await lastFromEnd(file, claudeUsage) : null;
    }
    if (input.providerId === 'codex') {
      const file = await codexRollout(homes.codex ?? codexHome(), input.sessionId);
      return file ? await lastFromEnd(file, codexUsage) : null;
    }
  } catch {
    // Unreadable: the size stays unknown.
  }
  return null;
}

function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
}

function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
}

/** Claude Code keeps a session at projects/<cwd with every other character than a letter or digit made "-">/<id>.jsonl. */
async function claudeTranscript(home: string, cwd: string, sessionId: string): Promise<string | null> {
  const projects = join(home, 'projects');
  const name = `${sessionId}.jsonl`;
  const direct = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'), name);
  if (await isFile(direct)) return direct;
  // A long path gets a shortened folder name: look for the id in every project folder.
  for (const dir of await readdir(projects).catch(() => [] as string[])) {
    const candidate = join(projects, dir, name);
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

/** Codex keeps a session at sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl: newest days first. */
async function codexRollout(home: string, sessionId: string): Promise<string | null> {
  const suffix = `-${sessionId}.jsonl`;
  const newestFirst = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort().reverse();
  const sessions = join(home, 'sessions');
  for (const year of await newestFirst(sessions)) {
    for (const month of await newestFirst(join(sessions, year))) {
      for (const day of await newestFirst(join(sessions, year, month))) {
        const file = (await newestFirst(join(sessions, year, month, day))).find((f) => f.endsWith(suffix));
        if (file) return join(sessions, year, month, day, file);
      }
    }
  }
  return null;
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile(),
    () => false
  );
}

function claudeUsage(entry: Record<string, unknown>): number | null {
  if (entry.type !== 'assistant' || entry.isSidechain === true) return null;
  const usage = (entry.message as { usage?: Record<string, unknown> } | undefined)?.usage;
  if (!usage) return null;
  const n = (key: string) => (typeof usage[key] === 'number' ? (usage[key] as number) : 0);
  const total = n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens');
  return total > 0 ? total : null;
}

function codexUsage(entry: Record<string, unknown>): number | null {
  const payload = entry.payload as { type?: string; info?: { last_token_usage?: { input_tokens?: unknown } } | null } | undefined;
  if (entry.type !== 'event_msg' || payload?.type !== 'token_count') return null;
  const input = payload.info?.last_token_usage?.input_tokens;
  return typeof input === 'number' && input > 0 ? input : null;
}

/**
 * The first value `pick` finds reading the file's JSON lines from its end.
 * Reads a growing tail, so a long transcript isn't read whole for its last
 * line.
 */
async function lastFromEnd(file: string, pick: (entry: Record<string, unknown>) => number | null): Promise<number | null> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    for (let window = 256 * 1024; ; window *= 8) {
      const length = Math.min(window, size);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const lines = buffer.toString('utf8').split('\n');
      // The first line of a partial tail may be cut.
      if (length < size) lines.shift();
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!.trim();
        if (!line) continue;
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const found = entry && typeof entry === 'object' ? pick(entry as Record<string, unknown>) : null;
        if (found !== null) return found;
      }
      if (length >= size) return null;
    }
  } finally {
    await handle.close();
  }
}
