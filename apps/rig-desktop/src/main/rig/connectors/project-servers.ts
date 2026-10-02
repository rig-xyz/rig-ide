import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connectorIdForUrl } from '@shared/spaces/connectors';
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
 * Claude only: Codex doesn't read `.mcp.json` at all (its servers live in
 * `~/.codex/config.toml`), so a space's `.mcp.json` means nothing to it.
 */

export interface ProjectServer {
  name: string;
  /** Remote servers only; null for local (stdio) ones. */
  url: string | null;
}

/** `.mcp.json`'s servers; nothing from a file that isn't one. */
export function parseProjectMcpJson(text: string): ProjectServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];
  return Object.entries(servers as Record<string, unknown>).map(([name, config]) => {
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
    const listed = claude?.find((e) => e.name === server.name && isDeclared(e));
    const approved =
      approvals.all || approvals.enabled.includes(server.name) || (listed !== undefined && listed.state !== 'pending');
    if (approved) continue;
    plan.disabled.push(server.name);
    plan.pending.push(server);
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
