import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAgentSessionSize } from './session-size';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'session-size-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const jsonl = (entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
const assistant = (input: number, creation: number, read: number, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  ...extra,
  message: { usage: { input_tokens: input, cache_creation_input_tokens: creation, cache_read_input_tokens: read, output_tokens: 50 } },
});

describe('readAgentSessionSize', () => {
  it("reads a Claude session's last assistant usage from its transcript, under the cwd's folder name", async () => {
    const dir = join(home, 'projects', '-Users-me-Rig-warm-island');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'sess-1.jsonl'),
      jsonl([assistant(2, 300_000, 0), { type: 'user', message: {} }, assistant(2, 136, 351_669), assistant(1, 1, 1, { isSidechain: true }), { type: 'system' }])
    );
    const size = await readAgentSessionSize({ providerId: 'claude', cwd: '/Users/me/Rig/warm-island', sessionId: 'sess-1' }, { claude: home });
    expect(size).toBe(2 + 136 + 351_669);
  });

  it('finds a Claude transcript in another project folder by its id, and reads past a long tail', async () => {
    const dir = join(home, 'projects', 'shortened-name-abc123');
    mkdirSync(dir, { recursive: true });
    const filler = Array.from({ length: 4000 }, (_, i) => ({ type: 'attachment', note: 'x'.repeat(100), i }));
    writeFileSync(join(dir, 'sess-2.jsonl'), jsonl([assistant(10, 20, 30), ...filler]));
    expect(await readAgentSessionSize({ providerId: 'claude', cwd: '/elsewhere', sessionId: 'sess-2' }, { claude: home })).toBe(60);
  });

  it("reads a Codex session's newest token_count from its rollout", async () => {
    const day = join(home, 'sessions', '2026', '10', '08');
    mkdirSync(day, { recursive: true });
    const count = (input: number) => ({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: input, cached_input_tokens: input - 10 } } } });
    writeFileSync(join(day, 'rollout-2026-10-08T11-31-38-thread-9.jsonl'), jsonl([count(1_000), count(134_145), { type: 'response_item', payload: {} }]));
    expect(await readAgentSessionSize({ providerId: 'codex', cwd: '/x', sessionId: 'thread-9' }, { codex: home })).toBe(134_145);
  });

  it('is null when the file or a usage in it is missing', async () => {
    expect(await readAgentSessionSize({ providerId: 'claude', cwd: '/x', sessionId: 'none' }, { claude: home })).toBeNull();
    expect(await readAgentSessionSize({ providerId: 'codex', cwd: '/x', sessionId: 'none' }, { codex: home })).toBeNull();
    const dir = join(home, 'projects', '-x');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'empty.jsonl'), jsonl([{ type: 'user' }, 'not json']));
    expect(await readAgentSessionSize({ providerId: 'claude', cwd: '/x', sessionId: 'empty' }, { claude: home })).toBeNull();
  });
});
