import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AcpHttpMcpServerWire, AcpStdioMcpServerWire } from '@emdash/core/acp';
import { connectorIdForUrl } from '@shared/spaces/connectors';
import type { SessionConnectors } from './connections';
import type { ClaudeMcpEntry } from './global-setup';

/**
 * The MCP servers a space's own `.mcp.json` declares, and which of them a
 * Claude session there gets.
 *
 * What headless Claude does with them (measured with CLI 2.1.283 through the
 * Agent SDK, which is how the ACP adapter runs it): every `.mcp.json` server
 * not listed in `disabledMcpjsonServers` loads, approved or not; the
 * "⏸ Pending approval" in `claude mcp list` is the interactive CLI's view
 * only. And a loaded `.mcp.json` server at the same URL as one of your
 * claude.ai connectors makes Claude drop the connector ("duplicates
 * manually-configured"), so the space's copy (no login of its own) replaces
 * the one you connected, and the agent gets no tools from either.
 *
 * So rig decides here, per session: a declared server that duplicates one
 * your Claude already has connected is held back (yours is used), and one
 * you haven't allowed is held back until you click Allow, which records it
 * where Claude itself reads approvals for that folder
 * (`.claude/settings.local.json`, never synced). Never approved silently.
 *
 * Codex doesn't read `.mcp.json` at all (its servers live in
 * `~/.codex/config.toml`), so rig hands it the declared servers itself, in
 * its session's `mcpServers` (`planCodexProjectServers`), through the same
 * Allow: what you allowed for Claude in the folder is what Codex gets there.
 * Remote ones and local (stdio) ones both; a local one is a command Codex
 * runs, which only the main process may ever put in a session (the renderer
 * wire drops it, see the ACP runtime host). Codex starts it in the space
 * folder: codex-acp sets no `cwd` for it, so it inherits Codex's own, and
 * a space's Codex process is spawned there (its pool key is the folder).
 */

export interface ProjectServer {
  name: string;
  /** Remote servers only; null for local (stdio) ones. */
  url: string | null;
}

/** `.mcp.json`'s server entries as written, by name; none from a file that isn't one. */
function projectMcpEntries(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return {};
  return servers as Record<string, unknown>;
}

/** `.mcp.json`'s servers; nothing from a file that isn't one. */
export function parseProjectMcpJson(text: string): ProjectServer[] {
  return Object.entries(projectMcpEntries(text)).map(([name, config]) => {
    const url = (config as { url?: unknown } | null)?.url;
    return { name, url: typeof url === 'string' ? url : null };
  });
}

/** The approvals in a folder's `.claude/settings.local.json`. */
export interface ProjectApprovals {
  enabled: string[];
  disabled: string[];
  all: boolean;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function parseLocalApprovals(text: string | null): ProjectApprovals {
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = text ? JSON.parse(text) : {};
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    // An unreadable settings file approves nothing.
  }
  return {
    enabled: strings(parsed.enabledMcpjsonServers),
    disabled: strings(parsed.disabledMcpjsonServers),
    all: parsed.enableAllProjectMcpServers === true,
  };
}

/** Scheme, host and path, lowercased host, no trailing slash: how Claude matches a duplicate. */
function normalizedUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** The same server: same URL once normalized, or the same catalog tool (matched by host, as the rest of rig does). */
export function sameMcpServer(a: string, b: string): boolean {
  const na = normalizedUrl(a);
  if (na !== null && na === normalizedUrl(b)) return true;
  const id = connectorIdForUrl(a);
  return id !== null && id === connectorIdForUrl(b);
}

export interface ProjectServersPlan {
  /** Kept out of this session (its `disabledMcpjsonServers`). */
  disabled: string[];
  /** Declared servers your Claude already has connected itself: yours is used instead. */
  duplicates: Array<{ name: string; duplicateOf: string }>;
  /** Declared servers you haven't allowed on this computer yet. */
  pending: ProjectServer[];
}

/**
 * Which of a folder's `.mcp.json` servers a Claude session there gets.
 * `claude` is what `claude mcp list` shows from the folder (null when it
 * couldn't be read: then only the local approvals count).
 */
export function planProjectServers(
  project: readonly ProjectServer[],
  claude: readonly ClaudeMcpEntry[] | null,
  approvals: ProjectApprovals
): ProjectServersPlan {
  const byName = new Map(project.map((p) => [p.name, p]));
  // Is this listed entry the declared server itself (same name, same endpoint)?
  const isDeclared = (e: ClaudeMcpEntry) => {
    const p = byName.get(e.name);
    if (!p) return false;
    return p.url === null || e.url === null ? p.url === e.url : sameMcpServer(p.url, e.url);
  };
  const own = (claude ?? []).filter((e) => e.state === 'connected' && e.url !== null && !isDeclared(e));
  const plan: ProjectServersPlan = { disabled: [], duplicates: [], pending: [] };
  for (const server of project) {
    // Already turned off for this folder: Claude skips it itself.
    if (approvals.disabled.includes(server.name)) continue;
    const mine = server.url ? own.find((e) => sameMcpServer(e.url!, server.url!)) : undefined;
    // Your own server by the same name at another endpoint (unless you allowed the space's): headless
    // Claude would take the space's copy, which has no login of its own.
    const allowedHere = approvals.all || approvals.enabled.includes(server.name);
    const shadowed = allowedHere
      ? undefined
      : claude?.find((e) => e.name === server.name && e.scopeConflict && e.state === 'connected');
    if (mine || shadowed) {
      plan.disabled.push(server.name);
      plan.duplicates.push({ name: server.name, duplicateOf: (mine ?? shadowed)!.name });
      continue;
    }
    if (isAllowed(server, claude, approvals)) continue;
    plan.disabled.push(server.name);
    plan.pending.push(server);
  }
  return plan;
}

/**
 * The Allow gate Claude and Codex share: allowed in the folder's
 * `.claude/settings.local.json`, or approved in Claude itself (it lists the
 * declared server, same name and endpoint, as anything but pending).
 */
function isAllowed(server: ProjectServer, claude: readonly ClaudeMcpEntry[] | null, approvals: ProjectApprovals): boolean {
  if (approvals.all || approvals.enabled.includes(server.name)) return true;
  const listed = claude?.find(
    (e) =>
      e.name === server.name &&
      (server.url === null || e.url === null ? server.url === e.url : sameMcpServer(server.url, e.url))
  );
  return listed !== undefined && listed.state !== 'pending';
}

type Env = Readonly<Record<string, string | undefined>>;

/** `${VAR}` and `${VAR:-default}`, expanded the way Claude expands them in `.mcp.json`; null when a variable with no default isn't set. */
export function expandEnvVars(value: string, env: Env): string | null {
  let missing = false;
  const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback?: string) => {
    const set = env[name];
    if (set !== undefined) return set;
    if (fallback !== undefined) return fallback;
    missing = true;
    return '';
  });
  return missing ? null : expanded;
}

function isHttpUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.every(([, v]) => typeof v === 'string') ? (Object.fromEntries(entries) as Record<string, string>) : null;
}

/**
 * One declared server in the shape a Codex session takes it: a remote one
 * (`type: "http"`, url and headers) or a local one (command, args, env),
 * variables expanded. Null for what Codex can't run: SSE, which codex-acp
 * refuses outright (failing the whole session), and broken entries.
 */
export function toSessionServer(
  name: string,
  config: unknown,
  env: Env
): AcpHttpMcpServerWire | AcpStdioMcpServerWire | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const c = config as Record<string, unknown>;
  const expand = (v: string) => expandEnvVars(v, env);
  const pairs = (record: Record<string, string> | null) => {
    if (!record) return null;
    const out: Array<{ name: string; value: string }> = [];
    for (const [key, raw] of Object.entries(record)) {
      const value = expand(raw);
      if (value === null) return null;
      out.push({ name: key, value });
    }
    return out;
  };
  if (typeof c.url === 'string' && (c.type === undefined || c.type === 'http')) {
    const url = expand(c.url);
    const headers = pairs(stringRecord(c.headers));
    if (url === null || !isHttpUrl(url) || !headers) return null;
    return { type: 'http', name, url, headers };
  }
  if (typeof c.command === 'string' && (c.type === undefined || c.type === 'stdio')) {
    const command = expand(c.command);
    const rawArgs = c.args === undefined ? [] : c.args;
    if (!Array.isArray(rawArgs) || !rawArgs.every((a): a is string => typeof a === 'string')) return null;
    const args = rawArgs.map(expand);
    const envVars = pairs(stringRecord(c.env));
    if (!command || args.some((a) => a === null) || !envVars) return null;
    return { name, command, args: args as string[], env: envVars };
  }
  return null;
}

export interface CodexProjectServers {
  /** Remote ones, for the Codex session's `mcpServers`. Can carry keys: never log or keep them. */
  servers: AcpHttpMcpServerWire[];
  /**
   * Local (stdio) ones, for the same `mcpServers`: commands Codex runs in the
   * space folder. Main process only (the renderer wire drops them). Can carry
   * keys too.
   */
  local: AcpStdioMcpServerWire[];
  /** Declared servers you haven't allowed on this computer yet. */
  pending: ProjectServer[];
  /** Allowed, but nothing Codex can run (SSE, a broken entry, an unset variable). Names only. */
  unusable: string[];
}

/**
 * Which of a folder's `.mcp.json` servers a Codex session there gets, by
 * the same rules as Claude's: one turned off for the folder or not allowed
 * is held back (the latter shown as pending), and one the session already
 * has is left out, yours winning. `own` is what the session already has:
 * rig's connectors and tools for it and Codex's own global servers. The
 * same name counts too, since the space's would replace yours in Codex.
 */
export function planCodexProjectServers(
  mcpJson: string,
  claude: readonly ClaudeMcpEntry[] | null,
  approvals: ProjectApprovals,
  own: ReadonlyArray<{ name: string; url: string | null }>,
  env: Env
): CodexProjectServers {
  const plan: CodexProjectServers = { servers: [], local: [], pending: [], unusable: [] };
  const entries = projectMcpEntries(mcpJson);
  for (const server of parseProjectMcpJson(mcpJson)) {
    if (approvals.disabled.includes(server.name)) continue;
    const duplicate = own.some(
      (o) => o.name === server.name || (o.url !== null && server.url !== null && sameMcpServer(o.url, server.url))
    );
    if (duplicate) continue;
    if (!isAllowed(server, claude, approvals)) {
      plan.pending.push(server);
      continue;
    }
    const wire = toSessionServer(server.name, entries[server.name], env);
    if (!wire) plan.unusable.push(server.name);
    else if ('type' in wire) plan.servers.push(wire);
    else plan.local.push(wire);
  }
  return plan;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

const localSettingsPath = (cwd: string) => join(cwd, '.claude', 'settings.local.json');

/** The plan for a folder: its `.mcp.json`, its local approvals, and what Claude lists there. */
export async function readProjectServersPlan(
  cwd: string,
  claudeEntries: () => Promise<ClaudeMcpEntry[] | null>
): Promise<ProjectServersPlan> {
  const project = parseProjectMcpJson((await readText(join(cwd, '.mcp.json'))) ?? '');
  if (project.length === 0) return { disabled: [], duplicates: [], pending: [] };
  const approvals = parseLocalApprovals(await readText(localSettingsPath(cwd)));
  return planProjectServers(project, await claudeEntries(), approvals);
}

/**
 * A Codex session's connectors with the folder's own servers added: the
 * allowed remote and local ones beside rig's, and the ones waiting for your
 * Allow named, so its context says so the way Claude's does.
 */
export function withCodexProjectServers(rigSide: SessionConnectors, codex: CodexProjectServers | null): SessionConnectors {
  if (!codex || (codex.servers.length === 0 && codex.local.length === 0 && codex.pending.length === 0)) return rigSide;
  return {
    ...rigSide,
    servers: [...rigSide.servers, ...codex.servers, ...codex.local],
    ...(codex.pending.length > 0 ? { project: { disabled: [], pending: codex.pending.map((p) => p.name) } } : {}),
  };
}

/** The servers a Codex session in this folder gets from its `.mcp.json` (see `planCodexProjectServers`). */
export async function readCodexProjectServers(
  cwd: string,
  deps: {
    claudeEntries: () => Promise<ClaudeMcpEntry[] | null>;
    own: () => Promise<ReadonlyArray<{ name: string; url: string | null }>>;
    env: () => Promise<Env>;
  }
): Promise<CodexProjectServers> {
  const text = (await readText(join(cwd, '.mcp.json'))) ?? '';
  if (parseProjectMcpJson(text).length === 0) return { servers: [], local: [], pending: [], unusable: [] };
  const approvals = parseLocalApprovals(await readText(localSettingsPath(cwd)));
  const [claude, own, env] = await Promise.all([deps.claudeEntries(), deps.own(), deps.env()]);
  return planCodexProjectServers(text, claude, approvals, own, env);
}

/**
 * You allowed a declared server on this computer: adds it to the folder's
 * `.claude/settings.local.json` `enabledMcpjsonServers`, keeping everything
 * else in that file. Refuses a name `.mcp.json` doesn't declare.
 */
export async function allowProjectServer(cwd: string, name: string): Promise<boolean> {
  const project = parseProjectMcpJson((await readText(join(cwd, '.mcp.json'))) ?? '');
  if (!project.some((p) => p.name === name)) return false;
  const path = localSettingsPath(cwd);
  const text = await readText(path);
  let settings: Record<string, unknown> = {};
  if (text) {
    const value: unknown = JSON.parse(text); // An unreadable file is left alone: the caller says it failed.
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    settings = value as Record<string, unknown>;
  }
  const enabled = strings(settings.enabledMcpjsonServers);
  if (enabled.includes(name)) return true;
  settings.enabledMcpjsonServers = [...enabled, name];
  await mkdir(join(cwd, '.claude'), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
  return true;
}
