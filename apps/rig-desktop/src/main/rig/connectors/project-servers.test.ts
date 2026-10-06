import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseClaudeMcpStatuses } from './global-setup';
import {
  allowProjectServer,
  expandEnvVars,
  parseLocalApprovals,
  parseProjectMcpJson,
  planCodexProjectServers,
  planProjectServers,
  readCodexProjectServers,
  readProjectServersPlan,
  sameMcpServer,
  toSessionServer,
  withCodexProjectServers,
} from './project-servers';

// What `claude mcp list` printed for the reported space: your claude.ai
// Customer.io connected, the space's own copy of it pending approval.
const REPORTED = `Checking MCP server health…

claude.ai Customer.io: https://mcp.customer.io/mcp - ✔ Connected
customerio: https://mcp.customer.io/mcp/ (HTTP) - ⏸ Pending approval (run \`claude\` to approve)
analytics: https://mcp.example.com/mcp (HTTP) - ⏸ Pending approval (run \`claude\` to approve)
approved: https://approved.example.com/mcp (HTTP) - ✔ Connected
local: npx some-server - ⏸ Pending approval (run \`claude\` to approve)
`;

const PROJECT = parseProjectMcpJson(
  JSON.stringify({
    mcpServers: {
      customerio: { type: 'http', url: 'https://mcp.customer.io/mcp/' },
      analytics: { type: 'http', url: 'https://mcp.example.com/mcp' },
      approved: { type: 'http', url: 'https://approved.example.com/mcp' },
      local: { command: 'npx', args: ['some-server'] },
    },
  })
);
const NO_APPROVALS = parseLocalApprovals(null);

describe('parseClaudeMcpStatuses', () => {
  it('reads every server with its state', () => {
    expect(parseClaudeMcpStatuses(REPORTED).map((e) => [e.name, e.state])).toEqual([
      ['claude.ai Customer.io', 'connected'],
      ['customerio', 'pending'],
      ['analytics', 'pending'],
      ['approved', 'connected'],
      ['local', 'pending'],
    ]);
    expect(
      parseClaudeMcpStatuses(
        [
          'a: https://a.example/mcp (HTTP) - ! Needs authentication',
          'b: https://b.example/mcp (HTTP) - ✗ Failed to connect',
          'c: https://c.example/mcp (HTTP) - ! Connected · tools fetch failed',
          'd: https://d.example/mcp (HTTP) - ⊘ Disabled for this project (re-enable via /mcp)',
          'e: https://e.example/mcp (HTTP) - ✗ Rejected (see disabledMcpjsonServers in settings)',
        ].join('\n')
      ).map((e) => e.state)
    ).toEqual(['needs_auth', 'failed', 'failed', 'disabled', 'rejected']);
  });
});

describe('planProjectServers', () => {
  it("holds back the space's copy of a server your Claude already has connected, so yours is used", () => {
    const plan = planProjectServers(PROJECT, parseClaudeMcpStatuses(REPORTED), NO_APPROVALS);
    expect(plan.duplicates).toEqual([{ name: 'customerio', duplicateOf: 'claude.ai Customer.io' }]);
    expect(plan.disabled).toContain('customerio');
  });

  it("holds back servers you haven't allowed, never approving them itself, and lets approved ones load", () => {
    const plan = planProjectServers(PROJECT, parseClaudeMcpStatuses(REPORTED), NO_APPROVALS);
    expect(plan.pending.map((p) => p.name)).toEqual(['analytics', 'local']);
    expect(plan.disabled).toEqual(['customerio', 'analytics', 'local']);
  });

  it('lets a server you allowed in the local settings load even while Claude still lists it as pending', () => {
    const plan = planProjectServers(PROJECT, parseClaudeMcpStatuses(REPORTED), parseLocalApprovals('{"enabledMcpjsonServers":["analytics"]}'));
    expect(plan.pending.map((p) => p.name)).toEqual(['local']);
    expect(plan.disabled).not.toContain('analytics');
    expect(planProjectServers(PROJECT, parseClaudeMcpStatuses(REPORTED), parseLocalApprovals('{"enableAllProjectMcpServers":true}')).pending).toEqual([]);
  });

  it("skips one you turned off for the folder (Claude already does), and doesn't count a same-name server of yours as approval", () => {
    const project = parseProjectMcpJson('{"mcpServers":{"customerio":{"url":"https://space.example/mcp"},"off":{"url":"https://off.example/mcp"}}}');
    // Same name as yours, different endpoint: `claude mcp list` shows yours, the space's copy is still unapproved.
    const claude = parseClaudeMcpStatuses('customerio: https://mine.example/mcp (HTTP) - ✔ Connected');
    const plan = planProjectServers(project, claude, parseLocalApprovals('{"disabledMcpjsonServers":["off"]}'));
    expect(plan.pending.map((p) => p.name)).toEqual(['customerio']);
    expect(plan.duplicates).toEqual([]);
    expect(plan.disabled).toEqual(['customerio']);
  });

  it("holds back the space's copy when Claude reports your server of the same name at another endpoint", () => {
    const project = parseProjectMcpJson('{"mcpServers":{"customerio":{"url":"https://mcp.customer.io/mcp/"}}}');
    const claude = parseClaudeMcpStatuses(`customerio: https://mcp.customer.io/mcp (HTTP) - ✔ Connected

MCP config diagnostics ⚠
[Conflicting scopes]
├ Server "customerio" is defined in multiple scopes with different endpoints: user (https://mcp.customer.io/mcp), project (https://mcp.customer.io/mcp/).
`);
    const plan = planProjectServers(project, claude, NO_APPROVALS);
    expect(plan.duplicates).toEqual([{ name: 'customerio', duplicateOf: 'customerio' }]);
    expect(plan.disabled).toEqual(['customerio']);
  });

  it("approves nothing when Claude's own list can't be read", () => {
    const project = parseProjectMcpJson('{"mcpServers":{"approved":{"url":"https://approved.example.com/mcp"}}}');
    expect(planProjectServers(project, null, NO_APPROVALS).pending.map((p) => p.name)).toEqual(['approved']);
  });
});

describe('sameMcpServer', () => {
  it('matches by normalized URL or by catalog tool', () => {
    expect(sameMcpServer('https://MCP.customer.io/mcp/', 'https://mcp.customer.io/mcp?x=1')).toBe(true);
    expect(sameMcpServer('https://mcp.linear.app/sse', 'https://mcp.linear.app/mcp')).toBe(true);
    expect(sameMcpServer('https://a.example/mcp', 'https://b.example/mcp')).toBe(false);
  });
});

describe('reading and allowing in a folder', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rig-project-servers-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('has nothing to say about a folder without .mcp.json, and never asks Claude then', async () => {
    let asked = false;
    const plan = await readProjectServersPlan(dir, async () => {
      asked = true;
      return [];
    });
    expect(plan).toEqual({ disabled: [], duplicates: [], pending: [] });
    expect(asked).toBe(false);
  });

  it('Allow records the approval in the local settings, keeping what was there, and the next plan loads it', async () => {
    await writeFile(join(dir, '.mcp.json'), '{"mcpServers":{"analytics":{"type":"http","url":"https://mcp.example.com/mcp"}}}');
    await mkdir(join(dir, '.claude'));
    await writeFile(join(dir, '.claude', 'settings.local.json'), '{"permissions":{"allow":["Bash(ls)"]}}');
    const claude = async () => parseClaudeMcpStatuses(REPORTED);
    expect((await readProjectServersPlan(dir, claude)).pending.map((p) => p.name)).toEqual(['analytics']);

    expect(await allowProjectServer(dir, 'analytics')).toBe(true);
    expect(await allowProjectServer(dir, 'analytics')).toBe(true);
    expect(JSON.parse(await readFile(join(dir, '.claude', 'settings.local.json'), 'utf8'))).toEqual({
      permissions: { allow: ['Bash(ls)'] },
      enabledMcpjsonServers: ['analytics'],
    });
    expect(await readProjectServersPlan(dir, claude)).toEqual({ disabled: [], duplicates: [], pending: [] });
  });

  it("refuses to allow a name the folder's .mcp.json doesn't declare", async () => {
    await writeFile(join(dir, '.mcp.json'), '{"mcpServers":{}}');
    expect(await allowProjectServer(dir, 'anything')).toBe(false);
  });
});

describe('Codex and the space’s .mcp.json', () => {
  const MCP_JSON = JSON.stringify({
    mcpServers: {
      remote: { type: 'http', url: 'https://remote.example/mcp', headers: { Authorization: 'Bearer ${REMOTE_TOKEN}' } },
      local: { command: 'npx', args: ['-y', 'some-server', '--root', '${ROOT:-.}'], env: { KEY: '${LOCAL_KEY}' } },
      streaming: { type: 'sse', url: 'https://sse.example/sse' },
      waiting: { type: 'http', url: 'https://waiting.example/mcp' },
      off: { type: 'http', url: 'https://off.example/mcp' },
      linear: { type: 'http', url: 'https://mcp.linear.app/mcp' },
      mine: { type: 'http', url: 'https://mine.example/mcp' },
    },
  });
  const ENV = { REMOTE_TOKEN: 't0k', LOCAL_KEY: 'k3y' };
  const approvals = parseLocalApprovals(
    JSON.stringify({
      enabledMcpjsonServers: ['remote', 'local', 'streaming', 'linear', 'mine'],
      disabledMcpjsonServers: ['off'],
    })
  );

  it('expands variables the way Claude does', () => {
    expect(expandEnvVars('a ${X} b ${Y:-why}', { X: 'x' })).toBe('a x b why');
    expect(expandEnvVars('${MISSING}', {})).toBeNull();
    expect(expandEnvVars('plain', {})).toBe('plain');
  });

  it('translates remote and local entries into the session shape, and refuses SSE', () => {
    expect(toSessionServer('r', { type: 'http', url: 'https://r.example/mcp', headers: { A: '${T}' } }, { T: 'v' })).toEqual({
      type: 'http',
      name: 'r',
      url: 'https://r.example/mcp',
      headers: [{ name: 'A', value: 'v' }],
    });
    expect(toSessionServer('l', { command: 'node', args: ['s.js'], env: { K: 'v' } }, {})).toEqual({
      name: 'l',
      command: 'node',
      args: ['s.js'],
      env: [{ name: 'K', value: 'v' }],
    });
    expect(toSessionServer('l', { type: 'stdio', command: 'node' }, {})).toEqual({ name: 'l', command: 'node', args: [], env: [] });
    expect(toSessionServer('s', { type: 'sse', url: 'https://s.example/sse' }, {})).toBeNull();
    expect(toSessionServer('bad', { type: 'http', url: 'not a url' }, {})).toBeNull();
    expect(toSessionServer('unset', { command: 'node', env: { K: '${NOPE}' } }, {})).toBeNull();
    expect(toSessionServer('args', { command: 'node', args: [1] }, {})).toBeNull();
  });

  it('gives Codex the allowed remote and local ones, and holds back the rest', () => {
    const plan = planCodexProjectServers(
      MCP_JSON,
      null,
      approvals,
      [
        // rig's Linear connector for this session, and a server Codex has in its own setup.
        { name: 'linear-rig', url: 'https://mcp.linear.app/mcp' },
        { name: 'mine', url: null },
      ],
      ENV
    );
    expect(plan.servers).toEqual([
      { type: 'http', name: 'remote', url: 'https://remote.example/mcp', headers: [{ name: 'Authorization', value: 'Bearer t0k' }] },
    ]);
    expect(plan.local).toEqual([
      { name: 'local', command: 'npx', args: ['-y', 'some-server', '--root', '.'], env: [{ name: 'KEY', value: 'k3y' }] },
    ]);
    expect(plan.pending.map((p) => p.name)).toEqual(['waiting']);
    expect(plan.unusable).toEqual(['streaming']);
  });

  it('nothing is allowed until you allow it, unless Claude itself approved it', () => {
    const claude = parseClaudeMcpStatuses('remote: https://remote.example/mcp (HTTP) - ✔ Connected\nwaiting: https://waiting.example/mcp (HTTP) - ⏸ Pending approval');
    const plan = planCodexProjectServers(MCP_JSON, claude, NO_APPROVALS, [], ENV);
    expect(plan.servers.map((s) => s.name)).toEqual(['remote']);
    expect(plan.local).toEqual([]);
    expect(plan.pending.map((p) => p.name)).toEqual(['local', 'streaming', 'waiting', 'off', 'linear', 'mine']);
  });

  it('allow-all lets every usable one through', () => {
    const all = parseLocalApprovals(JSON.stringify({ enableAllProjectMcpServers: true }));
    const plan = planCodexProjectServers(MCP_JSON, null, all, [], ENV);
    expect(plan.servers.map((s) => s.name)).toEqual(['remote', 'waiting', 'off', 'linear', 'mine']);
    expect(plan.pending).toEqual([]);
  });

  it('reads the folder: its .mcp.json and Claude’s local approvals', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-project-'));
    try {
      await writeFile(join(dir, '.mcp.json'), MCP_JSON);
      await mkdir(join(dir, '.claude'), { recursive: true });
      await writeFile(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ enabledMcpjsonServers: ['remote'] }));
      const plan = await readCodexProjectServers(dir, {
        claudeEntries: async () => null,
        own: async () => [],
        env: async () => ENV,
      });
      expect(plan.servers.map((s) => s.name)).toEqual(['remote']);
      expect(plan.pending.map((p) => p.name)).toContain('local');
      const empty = await mkdtemp(join(tmpdir(), 'codex-project-'));
      expect(await readCodexProjectServers(empty, { claudeEntries: async () => null, own: async () => [], env: async () => ({}) })).toEqual({
        servers: [],
        local: [],
        pending: [],
        unusable: [],
      });
      await rm(empty, { recursive: true, force: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('withCodexProjectServers', () => {
  const rigSide = {
    servers: [{ type: 'http' as const, name: 'linear', url: 'https://mcp.linear.app/mcp', headers: [] }],
    gaps: [],
    global: [],
  };

  it('adds the allowed ones beside rig’s and names the waiting ones for the context', async () => {
    const merged = withCodexProjectServers(rigSide, {
      servers: [{ type: 'http', name: 'remote', url: 'https://remote.example/mcp', headers: [] }],
      local: [],
      pending: [{ name: 'waiting', url: 'https://waiting.example/mcp' }],
      unusable: [],
    });
    expect(merged.servers.map((s) => s.name)).toEqual(['linear', 'remote']);
    expect(merged.project).toEqual({ disabled: [], pending: ['waiting'] });
    const { connectorsHiddenContext } = await import('../spaces/dispatch');
    const context = connectorsHiddenContext(
      merged.servers.map((s) => s.name),
      merged.gaps,
      merged.global,
      'everything',
      merged.project?.pending
    );
    expect(context).toContain('remote');
    expect(context).toContain("This space's .mcp.json also declares waiting");
  });

  it('hands Codex an allowed local server from the folder, and not one still waiting for your Allow', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-local-'));
    try {
      await writeFile(
        join(dir, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            notes: { command: 'node', args: ['notes-server.js', '--key', '${NOTES_KEY}'] },
            unvetted: { command: 'sh', args: ['-c', 'echo hi'] },
          },
        })
      );
      await mkdir(join(dir, '.claude'), { recursive: true });
      await writeFile(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ enabledMcpjsonServers: ['notes'] }));
      const codex = await readCodexProjectServers(dir, {
        claudeEntries: async () => null,
        own: async () => [],
        env: async () => ({ NOTES_KEY: 'n0tes' }),
      });
      const merged = withCodexProjectServers(rigSide, codex);
      expect(merged.servers).toEqual([
        ...rigSide.servers,
        { name: 'notes', command: 'node', args: ['notes-server.js', '--key', 'n0tes'], env: [] },
      ]);
      expect(merged.servers.map((s) => s.name)).not.toContain('unvetted');
      expect(merged.project).toEqual({ disabled: [], pending: ['unvetted'] });
      // Its context names the local one like the remote ones, and the waiting one as waiting.
      const { connectorsHiddenContext } = await import('../spaces/dispatch');
      const context = connectorsHiddenContext(
        merged.servers.map((s) => s.name),
        merged.gaps,
        merged.global,
        'everything',
        merged.project?.pending
      )!;
      expect(context).toContain('Connected tools you can use, through your owner\'s own login: Linear, notes.');
      expect(context).toContain("This space's .mcp.json also declares unvetted");
      expect(context).not.toContain('n0tes');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('adds an allowed local server even when nothing remote or pending comes with it', () => {
    const local = { name: 'notes', command: 'node', args: [], env: [] };
    const merged = withCodexProjectServers(rigSide, { servers: [], local: [local], pending: [], unusable: [] });
    expect(merged.servers).toEqual([...rigSide.servers, local]);
    expect(merged.project).toBeUndefined();
  });

  it('leaves rig’s side alone when the folder brings nothing', () => {
    expect(withCodexProjectServers(rigSide, null)).toBe(rigSide);
    expect(withCodexProjectServers(rigSide, { servers: [], local: [], pending: [], unusable: ['s'] })).toBe(rigSide);
  });
});
