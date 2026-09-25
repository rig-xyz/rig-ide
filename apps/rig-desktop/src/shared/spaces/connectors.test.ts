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
