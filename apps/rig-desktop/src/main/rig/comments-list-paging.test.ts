import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@main/lib/telemetry', () => ({ telemetryService: { capture: vi.fn() } }));
vi.mock('./config', () => ({ readRelayToken: vi.fn(async () => 'rpat_test') }));
vi.mock('./relay-trust', () => ({ checkRelayTrust: () => ({ trusted: true, host: 'relay.example.test' }) }));
vi.mock('./relay-request', () => ({ fetchRelay: vi.fn() }));

import { rigCommentsController } from './comments';
import { fetchRelay } from './relay-request';

/**
 * Comments and pins spike (rig docs/comments-pins-spike.md), surface 6.
 * Fails today.
 *
 * The relay lists a file's comments oldest first, at most `limit` per page,
 * and the next page is asked for with `after=<last seq>` (relay
 * `repos/messages.ts`). `rig.comments.list` asks once with limit 200 and
 * stops, so on a file whose threads and replies pass 200 messages, every
 * newer thread is missing from the margin and from `rig_comments_read`.
 * Page pins have the same cap (`pages-controller.ts` `threads`, limit 200).
 */

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  vi.mocked(fetchRelay).mockReset();
});

function boundFile(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rig-comments-paging-')));
  dirs.push(root);
  mkdirSync(join(root, '.rig'), { recursive: true });
  writeFileSync(
    join(root, '.rig', 'tap-binding.local.json'),
    JSON.stringify({ bindingId: 'bnd_paging', relayUrl: 'https://relay.example.test', deviceId: 'dev', token: 'tap_cap_x' })
  );
  const file = join(root, 'plan.md');
  writeFileSync(file, '# Plan\n');
  return file;
}

function message(seq: number, parentId: string | null) {
  return {
    id: `msg_${seq}`,
    seq: String(seq),
    bindingId: 'bnd_paging',
    author: { userId: 'usr_a', name: 'A', avatarUrl: null, kind: 'user' },
    kind: 'text',
    body: `message ${seq}`,
    parentId,
    intentId: null,
    path: parentId ? null : 'plan.md',
    meta: null,
    anchor: parentId ? null : { exact: 'Plan' },
    resolvedAt: null,
    resolvedBy: null,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, seq)).toISOString(),
    editedAt: null,
    deletedAt: null,
  };
}

describe('rig.comments.list on a busy file', () => {
  it('returns a thread started after the first 200 messages', async () => {
    // One long thread: a root and 199 replies, then a new thread.
    const all = [message(1, null), ...Array.from({ length: 199 }, (_, i) => message(i + 2, 'msg_1')), message(201, null)];
    vi.mocked(fetchRelay).mockImplementation(async (input) => {
      const url = new URL(String(input));
      const after = Number(url.searchParams.get('after') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 200);
      const page = all.filter((m) => Number(m.seq) > after).slice(0, limit);
      return new Response(JSON.stringify({ messages: page }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const result = await rigCommentsController.list({ absPath: boundFile() });

    expect(result.success).toBe(true);
    const ids = result.success ? result.data.messages.map((m) => m.id) : [];
    expect(ids).toContain('msg_201');
  });
});
