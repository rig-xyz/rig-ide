import { describe, expect, it, vi } from 'vitest';
import { parseClaudeMcpStatuses } from '../connectors/global-setup';
import { connectorChecks, ghAuthFrom, runPreflight } from './preflight';

const LIST = [
  'claude.ai Slack: https://mcp.slack.com/mcp (HTTP) - ✔ Connected',
  'claude.ai Granola: https://mcp.granola.ai/mcp (HTTP) - ✔ Connected',
  'claude.ai Google Drive: https://drivemcp.googleapis.com/mcp (HTTP) - ✔ Connected',
  'claude.ai Ramp: https://ramp-mcp-remote.ramp.com/mcp (HTTP) - ! Needs authentication',
  'claude.ai Notion: https://mcp.notion.com/mcp (HTTP) - Disabled',
  'linear-server: https://mcp.linear.app/mcp (HTTP) - ✗ Failed to connect',
  'linear: https://mcp.linear.app/sse (SSE) - ✔ Connected',
  'langfuse: https://cloud.langfuse.com/api/public/mcp (HTTP) - ✔ Connected',
].join('\n');

describe('connectorChecks', () => {
  it("lists every tool Claude has, by its own name, in Claude's order, then GitHub", () => {
    expect(connectorChecks(parseClaudeMcpStatuses(LIST), 'connected')).toEqual([
      { connector: 'Slack', known: 'slack', state: 'connected' },
      { connector: 'Granola', known: 'granola', state: 'connected' },
      // No logo for it: a neutral mark, under its own name.
      { connector: 'Google Drive', known: null, state: 'connected' },
      { connector: 'Ramp', known: null, state: 'needs_auth' },
      // Two Linear servers, one failed, one connected: one row, connected.
      { connector: 'Linear', known: 'linear', state: 'connected' },
      { connector: 'langfuse', known: null, state: 'connected' },
      { connector: 'GitHub', known: 'github', state: 'connected' },
    ]);
  });

  it('leaves out a tool turned off in Claude, and GitHub when gh is not signed in', () => {
    const names = connectorChecks(parseClaudeMcpStatuses(LIST), 'missing').map((c) => c.connector);
    expect(names).not.toContain('Notion');
    expect(names).not.toContain('GitHub');
  });

  it('takes GitHub from gh, which claude.ai has no connector for', () => {
    expect(connectorChecks([], 'needs_auth')).toEqual([
      { connector: 'GitHub', known: 'github', state: 'needs_auth' },
    ]);
  });

  it('lists nothing from Claude when it couldn’t be read', () => {
    expect(connectorChecks(null, 'missing')).toEqual([]);
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
    expect(checks.find((c) => c.known === 'github')?.state).toBe('connected');
  });

  it('a failing read is nothing connected, not an error', async () => {
    const checks = await runPreflight({
      invalidate: vi.fn(),
      claudeEntries: () => Promise.reject(new Error('no claude')),
      ghAuth: () => Promise.reject(new Error('no gh')),
    });
    expect(checks).toEqual([]);
  });
});
