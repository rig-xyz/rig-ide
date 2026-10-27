import { describe, expect, it, vi } from 'vitest';
import { parseClaudeMcpStatuses } from '../connectors/global-setup';
import { connectorChecks, ghAuthFrom, runPreflight } from './preflight';

const LIST = [
  'claude.ai Slack: https://mcp.slack.com/mcp (HTTP) - ✔ Connected',
  'claude.ai Gmail: https://gmail.mcp.claude.com/mcp (HTTP) - ! Needs authentication',
  'claude.ai Google Calendar: https://gcal.mcp.claude.com/mcp (HTTP) - ✔ Connected',
  'claude.ai Notion: https://mcp.notion.com/mcp (HTTP) - Disabled',
  'linear-server: https://mcp.linear.app/mcp (HTTP) - ✗ Failed to connect',
  'linear: https://mcp.linear.app/sse (SSE) - ✔ Connected',
  'playwright: npx @playwright/mcp - ✔ Connected',
].join('\n');

const stateOf = (checks: ReturnType<typeof connectorChecks>) =>
  Object.fromEntries(checks.map((c) => [c.connector, c.state]));

describe('connectorChecks', () => {
  it('reads each tool from Claude’s list by name or host, keeping its best state', () => {
    expect(stateOf(connectorChecks(parseClaudeMcpStatuses(LIST), 'missing'))).toEqual({
      slack: 'connected',
      // One Linear server failed, another is connected: connected wins.
      linear: 'connected',
      github: 'missing',
      gmail: 'needs_auth',
      calendar: 'connected',
      // Turned off in Claude: not there.
      notion: 'missing',
    });
  });

  it('takes GitHub from gh, which claude.ai has no connector for', () => {
    expect(stateOf(connectorChecks([], 'connected')).github).toBe('connected');
    expect(stateOf(connectorChecks([], 'needs_auth')).github).toBe('needs_auth');
  });

  it('lists all six tools, as not there, when Claude couldn’t be read', () => {
    const checks = connectorChecks(null, 'missing');
    expect(checks.map((c) => c.connector)).toEqual([
      'slack',
      'linear',
      'github',
      'gmail',
      'calendar',
      'notion',
    ]);
    expect(checks.every((c) => c.state === 'missing')).toBe(true);
  });
});

describe('ghAuthFrom', () => {
  it('signed in on exit 0', () => {
    expect(ghAuthFrom({ ok: true, output: 'Logged in to github.com account octo' })).toBe(
      'connected'
    );
  });

  it('asks to sign in again when GitHub refuses the token', () => {
    expect(
      ghAuthFrom({
        ok: false,
        output:
          'X Failed to log in to github.com using token (GH_TOKEN)\n- The token in GH_TOKEN is invalid.',
      })
    ).toBe('needs_auth');
  });

  it('not there when not signed in, or with no gh at all', () => {
    expect(ghAuthFrom({ ok: false, output: 'You are not logged into any GitHub hosts.' })).toBe(
      'missing'
    );
    expect(ghAuthFrom({ ok: false, output: 'spawn gh ENOENT' })).toBe('missing');
  });
});

describe('runPreflight', () => {
  it('drops the cache before reading, so a tool connected a moment ago shows', async () => {
    const order: string[] = [];
    const checks = await runPreflight({
      invalidate: () => order.push('invalidate'),
      claudeEntries: async () => {
        order.push('read');
        return parseClaudeMcpStatuses(LIST);
      },
      ghAuth: async () => 'connected',
    });
    expect(order).toEqual(['invalidate', 'read']);
    expect(stateOf(checks).github).toBe('connected');
  });

  it('a failing read is nothing connected, not an error', async () => {
    const checks = await runPreflight({
      invalidate: vi.fn(),
      claudeEntries: () => Promise.reject(new Error('no claude')),
      ghAuth: () => Promise.reject(new Error('no gh')),
    });
    expect(checks.every((c) => c.state === 'missing')).toBe(true);
  });
});
