import {
  FIRST_RUN_CONNECTORS,
  type ConnectorCheck,
  type FirstRunConnector,
} from '@shared/rig/first-run';
import type { ClaudeMcpEntry } from '../connectors/global-setup';

/**
 * The first run's Connect pre-flight: which of the person's tools their
 * Claude reaches right now. It reads Claude's own `claude mcp list` (fresh,
 * past the 10-minute cache: the person may have just connected something in
 * claude.ai) and `gh auth status` for GitHub, which claude.ai has no
 * connector for. States only, no counts: a count would cost a model call per
 * tool, and the first read brings them anyway.
 */

/** How a tool shows up in Claude's list: its name ("claude.ai Slack") or its server's host. */
const MATCH: Record<FirstRunConnector, RegExp> = {
  slack: /slack/i,
  linear: /linear/i,
  github: /github/i,
  gmail: /gmail|google mail/i,
  calendar: /calendar|gcal/i,
  notion: /notion/i,
};

/** `gh auth status`'s answer, reduced: signed in, signed in with a token GitHub refuses, or not at all. */
export type GhAuth = 'connected' | 'needs_auth' | 'missing';

type State = ConnectorCheck['state'];
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

/** Each tool's best state across Claude's servers, and `gh` for GitHub. Claude unreadable reads as nothing connected. */
export function connectorChecks(
  entries: readonly ClaudeMcpEntry[] | null,
  gh: GhAuth
): ConnectorCheck[] {
  return FIRST_RUN_CONNECTORS.map((connector) => {
    let state: State = connector === 'github' ? gh : 'missing';
    for (const entry of entries ?? []) {
      if (MATCH[connector].test(`${entry.name} ${entry.url ?? ''}`))
        state = best(state, entryState(entry));
    }
    return { connector, state };
  });
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
