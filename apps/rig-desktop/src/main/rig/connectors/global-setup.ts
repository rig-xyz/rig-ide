import { log } from '@main/lib/logger';
import { connectorIdForUrl, type ConnectorId, type GlobalServer } from '@shared/spaces/connectors';
import type { SessionConnectors } from './connections';

/**
 * What your agents bring from their own global setup: your claude.ai
 * connectors and ~/.claude servers for Claude, ~/.codex servers for Codex.
 * Rig never changes these; it reads them (through each agent's own CLI, so
 * it sees exactly what the agent sees) to show them in the Room and to not
 * nudge you to connect a tool your agent already has. Codex's ChatGPT-app
 * connectors aren't listed by its CLI, so they stay invisible here.
 */

/** Scheme, host and path only: a server URL can carry a key in its query or userinfo, and nothing here needs it. */
function safeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return null;
  }
}

export type RunCli = (agent: 'claude' | 'codex', args: string[], cwd: string | undefined) => Promise<string>;

/** `claude mcp list` (text): "<name>: <url or command> [(HTTP)] - ✔ Connected". Connected remote and local servers. */
export function parseClaudeMcpList(text: string): GlobalServer[] {
  const servers: GlobalServer[] = [];
  for (const line of text.split('\n')) {
    const match = /^(.+?): (\S+)(?: \([A-Z]+\))?.* - (.+)$/.exec(line.trim());
    if (!match) continue;
    const [, name, target, status] = match;
    if (!status!.includes('✔')) continue;
    const url = /^https?:\/\//.test(target!) ? safeUrl(target!) : null;
    servers.push({ agent: 'claude', name: name!, url, connectorId: url ? connectorIdForUrl(url) : null });
  }
  return servers;
}

/** `codex mcp list --json`: enabled servers, with the URL of remote ones. */
export function parseCodexMcpList(json: string): GlobalServer[] {
  let rows: unknown;
  try {
    rows = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const servers: GlobalServer[] = [];
  for (const row of rows) {
    const r = row as { name?: unknown; enabled?: unknown; transport?: { url?: unknown } };
    if (typeof r.name !== 'string' || r.enabled !== true) continue;
    const url = typeof r.transport?.url === 'string' ? safeUrl(r.transport.url) : null;
    servers.push({ agent: 'codex', name: r.name, url, connectorId: url ? connectorIdForUrl(url) : null });
  }
  return servers;
}

export interface GlobalSetup {
  /** Your agents' global servers, as seen from a space's folder (project-scoped ones count). Cached. */
  list(cwd: string | undefined): Promise<GlobalServer[]>;
  /** Drops the cache (e.g. after you connect something in an agent's own app). */
  invalidate(): void;
}

const TTL_MS = 10 * 60_000;

export function createGlobalSetup(deps: { run: RunCli; now?: () => number; ttlMs?: number }): GlobalSetup {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? TTL_MS;
  const cache = new Map<string, { at: number; servers: Promise<GlobalServer[]> }>();

  async function read(agent: 'claude' | 'codex', cwd: string | undefined): Promise<GlobalServer[]> {
    try {
      return agent === 'claude'
        ? parseClaudeMcpList(await deps.run('claude', ['mcp', 'list'], cwd))
        : parseCodexMcpList(await deps.run('codex', ['mcp', 'list', '--json'], cwd));
    } catch (error) {
      // An agent that isn't installed (or signed in) just brings nothing.
      log.info('Rig connectors: could not read an agent’s own MCP setup', { agent, error: String(error) });
      return [];
    }
  }

  return {
    list(cwd) {
      const key = cwd ?? '';
      const hit = cache.get(key);
      if (hit && now() - hit.at < ttl) return hit.servers;
      // One read in flight per folder; both agents in parallel.
      const servers = Promise.all([read('claude', cwd), read('codex', cwd)]).then(([a, b]) => [...a, ...b]);
      cache.set(key, { at: now(), servers });
      return servers;
    },
    invalidate() {
      cache.clear();
    },
  };
}

/**
 * The connectors one agent's session gets for a space, when the agent may
 * already reach some of them from its own global setup.
 *
 * Precedence (decided 2026-09-30): the agent's own connection wins. A space
 * connector the agent being run already has globally (e.g. Mixpanel in your
 * claude.ai connectors) is NOT injected by rig, even when you also have a rig
 * login for it: the agent would otherwise see the same service twice (Claude's
 * `claude_ai_Mixpanel` and rig's `mixpanel`), and 0.4.2 promised rig won't
 * make you reconnect tools your agent already has. It's listed as `global`
 * (the agent is told it has it) and is never a gap. Rig's own login only
 * serves agents that don't have the tool themselves — e.g. your Codex, when
 * only your Claude has it.
 */
export async function sessionConnectorsFor(
  ids: readonly ConnectorId[],
  agent: 'claude' | 'codex',
  deps: {
    forSession: (ids: readonly ConnectorId[]) => Promise<SessionConnectors>;
    globalSetup: () => Promise<GlobalServer[]>;
  }
): Promise<SessionConnectors> {
  const own = await deps.globalSetup().catch(() => [] as GlobalServer[]);
  const theirs = new Set(own.filter((s) => s.agent === agent && s.connectorId).map((s) => s.connectorId!));
  const global = ids.filter((id) => theirs.has(id));
  const session = await deps.forSession(ids.filter((id) => !theirs.has(id)));
  return { servers: session.servers, gaps: session.gaps, global };
}
