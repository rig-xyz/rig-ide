import { KNOWN_NAME, knownTool, toolKey, type ConnectorCheck } from '@shared/rig/first-run';
import type { ClaudeMcpEntry } from '../connectors/global-setup';

/**
 * The first run's Connect pre-flight: the tools the person's Claude reaches
 * right now, as Claude itself lists them. It reads Claude's own `claude mcp
 * list` (fresh, past the 10-minute cache: the person may have just connected
 * something in claude.ai) and `gh auth status` for GitHub, which claude.ai
 * has no connector for. Every server that's connected or asks to sign in
 * again is a tool, by its own name; one that's off or refused isn't listed.
 * States only, no counts: a count would cost a model call per tool, and the
 * first read brings them anyway.
 */

/** `gh auth status`'s answer, reduced: signed in, signed in with a token GitHub refuses, or not at all. */
export type GhAuth = 'connected' | 'needs_auth' | 'missing';

type State = ConnectorCheck['state'] | 'missing';
const RANK: Record<State, number> = { missing: 0, needs_auth: 1, connected: 2 };
const best = (a: State, b: State): State => (RANK[b] > RANK[a] ? b : a);

/** One of Claude's servers as a tool state: there but not working means sign in again; disabled or rejected means not there. */
function entryState(entry: ClaudeMcpEntry): State {
  switch (entry.state) {
    case 'connected':
      return 'connected';
    case 'needs_auth':
    case 'pending':
    case 'failed':
      return 'needs_auth';
    case 'disabled':
    case 'rejected':
    case 'other':
      return 'missing';
  }
}

/** A server's name as the person knows the tool: claude.ai's connectors drop their "claude.ai " prefix. */
export function toolName(entry: Pick<ClaudeMcpEntry, 'name'>): string {
  return entry.name.replace(/^claude\.ai\s+/i, '').trim();
}

/**
 * Claude's servers as tools, in Claude's order, each by its own name with its
 * best state when it's listed twice, then GitHub from `gh` (or, when Claude
 * has a GitHub server too, the better of the two). Claude unreadable lists
 * GitHub alone, or nothing.
 */
export function connectorChecks(
  entries: readonly ClaudeMcpEntry[] | null,
  gh: GhAuth
): ConnectorCheck[] {
  const tools = new Map<string, { connector: string; known: ConnectorCheck['known']; state: State }>();
  for (const entry of entries ?? []) {
    const connector = toolName(entry);
    const known = knownTool(entry.name, entry.url);
    // A known tool is one row, by its usual name, however many servers Claude has for it ("linear" and "linear-server").
    const key = known ?? toolKey(connector);
    const was = tools.get(key);
    const state = entryState(entry);
    if (was) was.state = best(was.state, state);
    else tools.set(key, { connector: known ? KNOWN_NAME[known] : connector, known, state });
  }
  const github = tools.get('github');
  if (github) github.state = best(github.state, gh);
  else tools.set('github', { connector: KNOWN_NAME.github, known: 'github', state: gh });
  return [...tools.values()].flatMap((t) =>
    t.state === 'missing' ? [] : [{ connector: t.connector, known: t.known, state: t.state }]
  );
}

/** `gh auth status`'s outcome as `GhAuth`: exit 0 is signed in; a refused token asks to sign in again. */
export function ghAuthFrom(result: { ok: boolean; output: string }): GhAuth {
  if (result.ok) return 'connected';
  if (/token .*invalid|failed to log in|re-?authenticate/i.test(result.output)) return 'needs_auth';
  return 'missing';
}

export type PreflightDeps = {
  /** Drops the global-setup cache, so the read below is fresh. */
  invalidate: () => void;
  claudeEntries: () => Promise<ClaudeMcpEntry[] | null>;
  ghAuth: () => Promise<GhAuth>;
};

export async function runPreflight(deps: PreflightDeps): Promise<ConnectorCheck[]> {
  deps.invalidate();
  const [entries, gh] = await Promise.all([
    deps.claudeEntries().catch(() => null),
    deps.ghAuth().catch((): GhAuth => 'missing'),
  ]);
  return connectorChecks(entries, gh);
}
