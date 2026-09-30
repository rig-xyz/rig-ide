import { describe, expect, it, vi } from 'vitest';
import type { ConnectorId } from '@shared/spaces/connectors';
import { createGlobalSetup, parseClaudeMcpList, parseCodexMcpList, sessionConnectorsFor } from './global-setup';

const CLAUDE_OUT = `Checking MCP server health…

claude.ai Linear: https://mcp.linear.app/mcp - ✔ Connected
claude.ai Atlassian Rovo: https://mcp.atlassian.com/v1/mcp - ✔ Connected
claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected
plugin:chrome-devtools-mcp:chrome-devtools: npx chrome-devtools-mcp@latest - ✔ Connected
plugin:ulys-qa:grafana: https://monitor.example/api/mcp (HTTP) - ✘ Failed to connect — MCP endpoint not found at https://monitor.example.
Neon: https://mcp.neon.tech/mcp (HTTP) - ✔ Connected
pending: https://mcp.notion.com/mcp (HTTP) - ⏸ Pending approval
`;

const CODEX_OUT = JSON.stringify([
  { name: 'codex_app', enabled: false, transport: { type: 'stdio', command: 'x' } },
  { name: 'launchdarkly', enabled: true, transport: { type: 'streamable_http', url: 'https://mcp.launchdarkly.com/mcp/launchdarkly' } },
  { name: 'sentry', enabled: true, transport: { type: 'streamable_http', url: 'https://mcp.sentry.dev/mcp' } },
  { name: 'node_repl', enabled: true, transport: { type: 'stdio', command: 'node_repl' } },
]);

describe('parseClaudeMcpList', () => {
  it('keeps connected servers, matches catalog tools by host, and skips failed or pending ones', () => {
    expect(parseClaudeMcpList(CLAUDE_OUT)).toEqual([
      { agent: 'claude', name: 'claude.ai Linear', url: 'https://mcp.linear.app/mcp', connectorId: 'linear' },
      { agent: 'claude', name: 'claude.ai Atlassian Rovo', url: 'https://mcp.atlassian.com/v1/mcp', connectorId: 'atlassian' },
      { agent: 'claude', name: 'claude.ai Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1', connectorId: null },
      { agent: 'claude', name: 'plugin:chrome-devtools-mcp:chrome-devtools', url: null, connectorId: null },
      { agent: 'claude', name: 'Neon', url: 'https://mcp.neon.tech/mcp', connectorId: 'neon' },
    ]);
  });
});

describe('parseCodexMcpList', () => {
  it('keeps enabled servers with their URL', () => {
    expect(parseCodexMcpList(CODEX_OUT)).toEqual([
      { agent: 'codex', name: 'launchdarkly', url: 'https://mcp.launchdarkly.com/mcp/launchdarkly', connectorId: null },
      { agent: 'codex', name: 'sentry', url: 'https://mcp.sentry.dev/mcp', connectorId: 'sentry' },
      { agent: 'codex', name: 'node_repl', url: null, connectorId: null },
    ]);
  });

  it('drops query strings and credentials from server URLs', () => {
    const out = JSON.stringify([
      { name: 'x', enabled: true, transport: { url: 'https://user:pw@mcp.example.com/mcp?api_key=secret' } },
    ]);
    expect(parseCodexMcpList(out)[0]?.url).toBe('https://mcp.example.com/mcp');
  });

  it('brings nothing from output it cannot read', () => {
    expect(parseCodexMcpList('not json')).toEqual([]);
  });
});

describe('createGlobalSetup', () => {
  it('reads both agents once per folder and caches the result', async () => {
    const run = vi.fn(async (agent: 'claude' | 'codex') => (agent === 'claude' ? CLAUDE_OUT : CODEX_OUT));
    let now = 0;
    const setup = createGlobalSetup({ run, now: () => now, ttlMs: 1000 });
    const [a, b] = await Promise.all([setup.list('/space'), setup.list('/space')]);
    expect(a).toBe(b);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledWith('claude', ['mcp', 'list'], '/space');
    expect(run).toHaveBeenCalledWith('codex', ['mcp', 'list', '--json'], '/space');
    expect(a.map((s) => s.connectorId).filter(Boolean)).toEqual(['linear', 'atlassian', 'neon', 'sentry']);

    now = 1500;
    await setup.list('/space');
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('treats an agent whose CLI fails as bringing nothing', async () => {
    const run = vi.fn(async (agent: 'claude' | 'codex') => {
      if (agent === 'codex') throw new Error('ENOENT');
      return CLAUDE_OUT;
    });
    const servers = await createGlobalSetup({ run }).list(undefined);
    expect(servers.every((s) => s.agent === 'claude')).toBe(true);
  });
});

describe('sessionConnectorsFor', () => {
  const server = (id: string) => ({ type: 'http' as const, name: id, url: `https://${id}`, headers: [] });
  // Stands in for connections.forSession: connected via rig to mixpanel and linear, nothing else.
  const forSession = vi.fn(async (ids: readonly ConnectorId[]) => ({
    servers: ids.filter((id) => id === 'mixpanel' || id === 'linear').map(server),
    gaps: ids.filter((id) => id !== 'mixpanel' && id !== 'linear').map((id) => ({ id, state: 'not_connected' as const })),
  }));
  const own = async () => [
    { agent: 'claude' as const, name: 'claude.ai Mixpanel', url: 'https://mcp.mixpanel.com/mcp', connectorId: 'mixpanel' as const },
    { agent: 'claude' as const, name: 'claude.ai Notion', url: 'https://mcp.notion.com/mcp', connectorId: 'notion' as const },
  ];

  it("uses the agent's own connection instead of injecting rig's: no duplicate server, no gap, no token read", async () => {
    forSession.mockClear();
    const result = await sessionConnectorsFor(['mixpanel', 'notion', 'linear', 'sentry'], 'claude', { forSession, globalSetup: own });
    expect(forSession).toHaveBeenCalledWith(['linear', 'sentry']);
    expect(result.servers.map((s) => s.name)).toEqual(['linear']);
    expect(result.gaps).toEqual([{ id: 'sentry', state: 'not_connected' }]);
    expect(result.global).toEqual(['mixpanel', 'notion']);
  });

  it("injects rig's login for an agent that doesn't have the tool itself", async () => {
    const result = await sessionConnectorsFor(['mixpanel', 'notion'], 'codex', { forSession, globalSetup: own });
    expect(result.servers.map((s) => s.name)).toEqual(['mixpanel']);
    expect(result.gaps).toEqual([{ id: 'notion', state: 'not_connected' }]);
    expect(result.global).toEqual([]);
  });

  it('falls back to rig alone when the global setup cannot be read', async () => {
    const result = await sessionConnectorsFor(['mixpanel'], 'claude', {
      forSession,
      globalSetup: () => Promise.reject(new Error('no claude')),
    });
    expect(result.servers.map((s) => s.name)).toEqual(['mixpanel']);
    expect(result.global).toEqual([]);
  });
});
