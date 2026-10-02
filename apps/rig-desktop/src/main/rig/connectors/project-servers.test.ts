import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseClaudeMcpStatuses } from './global-setup';
import {
  allowProjectServer,
  parseLocalApprovals,
  parseProjectMcpJson,
  planProjectServers,
  readProjectServersPlan,
  sameMcpServer,
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
