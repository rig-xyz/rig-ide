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
