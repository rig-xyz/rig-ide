import { describe, expect, it, vi } from 'vitest';
import { createGlobalSetup, parseClaudeMcpList, parseCodexMcpList } from './global-setup';

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
