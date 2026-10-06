import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adapterStatuses, isNewer } from './agent-adapters.ts';

describe('agent adapter check', () => {
  it('compares versions segment by segment', () => {
    expect(isNewer('2.1.1', '1.10.0')).toBe(true);
    expect(isNewer('0.86.0', '0.86.0')).toBe(false);
    expect(isNewer('0.9.0', '0.10.0')).toBe(false);
    expect(isNewer('1.0', '1.0.0')).toBe(false);
    expect(isNewer('next', '1.0.0')).toBe(false);
  });

  it('reads the pins and asks npm, staying quiet when npm is unreachable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adapters-'));
    mkdirSync(join(root, 'packages/plugins'), { recursive: true });
    writeFileSync(
      join(root, 'packages/plugins/package.json'),
      JSON.stringify({
        dependencies: {
          '@agentclientprotocol/claude-agent-acp': '0.86.0',
          '@agentclientprotocol/codex-acp': '2.1.1',
        },
      })
    );
    const fetchFn = (async (url: string) =>
      url.includes('codex-acp')
        ? new Response(JSON.stringify({ version: '2.2.0' }))
        : new Response('down', { status: 503 })) as unknown as typeof fetch;
    expect(await adapterStatuses(root, fetchFn)).toEqual([
      { name: '@agentclientprotocol/claude-agent-acp', pinned: '0.86.0', latest: null },
      { name: '@agentclientprotocol/codex-acp', pinned: '2.1.1', latest: '2.2.0' },
    ]);
  });
});
