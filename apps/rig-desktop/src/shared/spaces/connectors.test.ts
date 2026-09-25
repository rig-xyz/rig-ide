import { describe, expect, it } from 'vitest';
import { CONNECTORS, CONNECTOR_IDS, isConnectorId, prettyConnectorTool } from './connectors';

describe('connectors catalog', () => {
  it('lists every id exactly once, in catalog order', () => {
    expect(CONNECTORS.map((c) => c.id)).toEqual([...CONNECTOR_IDS]);
  });

  it('only accepts known ids', () => {
    expect(isConnectorId('linear')).toBe(true);
    expect(isConnectorId('figma')).toBe(false);
    expect(isConnectorId(undefined)).toBe(false);
  });
});

describe('prettyConnectorTool', () => {
  it('reads Claude-style names', () => {
    const p = prettyConnectorTool('mcp__linear__list_issues');
    expect(p?.connector.name).toBe('Linear');
    expect(p?.action).toBe('list issues');
  });

  it('reads Codex-style names', () => {
    const p = prettyConnectorTool('mcp.notion.search');
    expect(p?.connector.name).toBe('Notion');
    expect(p?.action).toBe('search');
  });

  it('ignores servers that are not ours', () => {
    expect(prettyConnectorTool('mcp__spike-stdio__echo')).toBeNull();
    expect(prettyConnectorTool('mcp.codex_apps.linear.list_teams')).toBeNull();
    expect(prettyConnectorTool('Read')).toBeNull();
  });
});

describe('global setup helpers', () => {
  it('matches a catalog tool by its MCP host', async () => {
    const { connectorIdForUrl } = await import('./connectors');
    expect(connectorIdForUrl('https://mcp.linear.app/mcp')).toBe('linear');
    expect(connectorIdForUrl('https://mcp.atlassian.com/v1/mcp')).toBe('atlassian');
    expect(connectorIdForUrl('https://mcp.launchdarkly.com/mcp/launchdarkly')).toBeNull();
    expect(connectorIdForUrl('not a url')).toBeNull();
  });

  it('reads claude.ai connector and other global tool names, and marks where they came from', async () => {
    const { prettyAgentTool } = await import('./connectors');
    expect(prettyAgentTool('mcp__claude_ai_Linear__list_issues')).toMatchObject({ label: 'Linear', action: 'list issues', via: 'setup' });
    expect(prettyAgentTool('mcp__claude_ai_Atlassian_Rovo__search')).toMatchObject({ label: 'Atlassian Rovo', connector: null, via: 'setup' });
    expect(prettyAgentTool('mcp.launchdarkly.get_flag')).toMatchObject({ label: 'launchdarkly', action: 'get flag', via: 'setup' });
    expect(prettyAgentTool('mcp__linear__list_issues')).toMatchObject({ label: 'Linear', via: 'space' });
    expect(prettyAgentTool('Read')).toBeNull();
  });
});

describe("rig's own tools", () => {
  it('reads as "Rig · invite hugo@…" for both agents, with who or which file', async () => {
    const { prettyAgentTool, rigToolArgs } = await import('./connectors');
    const claude = rigToolArgs('mcp__rig__rig_invite', { email: 'hugo@acme.co', role: 'editor' });
    expect(prettyAgentTool('mcp__rig__rig_invite', claude)).toEqual({
      label: 'Rig',
      action: 'invite hugo@acme.co',
      connector: null,
      via: 'rig',
    });
    // Codex wraps the arguments.
    const codex = rigToolArgs('mcp.rig.rig_comment', {
      server: 'rig',
      tool: 'rig_comment',
      arguments: { path: 'notes/plan.md', reply_to: 'm1', body: 'Done' },
    });
    expect(prettyAgentTool('mcp.rig.rig_comment', codex)?.action).toBe('reply on notes/plan.md');
    expect(prettyAgentTool('mcp__rig__rig_comment', { path: 'plan.md' })?.action).toBe('comment on plan.md');
    expect(prettyAgentTool('mcp__rig__rig_file_comments', { path: 'plan.md' })?.action).toBe('comments on plan.md');
    expect(prettyAgentTool('mcp__rig__rig_people')?.action).toBe('people');
    expect(prettyAgentTool('mcp__rig__rig_recent_changes')?.action).toBe('recent changes');
    // Before the arguments stream in, the bare action.
    expect(prettyAgentTool('mcp__rig__rig_invite')?.action).toBe('invite');
  });

  it('keeps arguments only for rig tools', async () => {
    const { rigToolArgs } = await import('./connectors');
    expect(rigToolArgs('mcp__linear__list_issues', { email: 'a@b.co' })).toBeUndefined();
    expect(rigToolArgs('mcp__rig__rig_people', {})).toBeUndefined();
    expect(rigToolArgs(undefined, { email: 'a@b.co' })).toBeUndefined();
  });
});
