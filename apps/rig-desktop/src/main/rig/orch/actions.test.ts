import { err, ok } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import { createActions, sinceToIso, type ActionsDeps } from './actions';
import type { Source } from './sources';
import { createTurnGate } from './turns';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const source = (over: Partial<Source> = {}): Source => ({
  ref: 'src_linear', connector: 'Linear', what: 'issues in Ulys', everyMin: 30, paused: false, cursor: null, lastRun: null, lastStatus: null, lastCount: 0, ...over,
});

function deps(over: Partial<ActionsDeps> = {}): ActionsDeps & { turns: ReturnType<typeof createTurnGate> } {
  const turns = createTurnGate({ now: () => NOW });
  return {
    relay: {
      query: vi.fn(async (kind: string) => ok({ kind, rows: [{ ref: 'sit_1', title: 'Vendor list' }] })),
      get: vi.fn(async (ref: string) => ok({ ref, situation: { id: 'sit_1', title: 'Vendor list', description: 'Riyad waits [ev:i04].' }, events: [{ ref: 'ev:i04', title: 'Which list?', binding_id: 'b2' }], feed: { card: { action: '**Pick the list.** The 8.' } } })),
      act: vi.fn(async (refs: string[], action: string) => ok(refs.map((ref) => ({ ref, ok: true, message: action })))),
      linkSession: vi.fn(async () => ok(null)),
    },
    spaces: async () => ok([{ bindingId: 'b1', name: 'ops', root: '/r/ops' }, { bindingId: 'b2', name: 'deletion', root: '/r/deletion' }, { bindingId: 'b3', name: 'remote', root: null }]),
    topics: async () => [{ name: 'Vendor eraser', space: 'deletion', description: 'Which vendors erase', messages: 4, people: ['Riyad'] }],
    connectors: async () => [{ name: 'Linear', state: 'connected' }, { name: 'Gmail', state: 'needs_auth' }],
    sessions: async () => ok([]),
    sources: {
      list: async () => [source({ lastRun: '2026-10-23T11:30:00Z', lastStatus: 'ok', lastCount: 3 })],
      update: vi.fn(async (ref: string) => source({ ref, paused: true })),
      run: vi.fn(async () => ({ status: 'ok' as const, listed: 5, added: 2, cursor: '2026-10-23T11:59:00Z' })),
    },
    runLocal: vi.fn(async () => ok({ runId: 'run_9' })),
    writeFile: vi.fn(async () => {}),
    turns,
    now: () => NOW,
    ...over,
  } as ActionsDeps & { turns: ReturnType<typeof createTurnGate> };
}

describe('the control plane', () => {
  it('lists relay kinds from the relay and Mac kinds from the Mac, and says what it cannot list yet', async () => {
    const d = deps();
    const a = createActions(d);
    await a.query({ kind: 'items', since: '1d' });
    expect(d.relay.query).toHaveBeenCalledWith('items', { since: '2026-10-22T12:00:00.000Z', limit: undefined, filter: undefined });
    const conns = await a.query({ kind: 'connectors' });
    expect(conns.success && 'rows' in conns.data && conns.data.rows.map((r) => [r.ref, r.state])).toEqual([['conn_linear', 'connected'], ['conn_gmail', 'needs_auth']]);
    const src = await a.query({ kind: 'sources' });
    expect(src.success && 'rows' in src.data && src.data.rows[0]).toMatchObject({ ref: 'src_linear', lastChecked: '30 min ago', lastCount: 3 });
    const usage = await a.query({ kind: 'usage' });
    expect(usage.success && usage.data).toMatchObject({ unavailable: true });
  });

  it('runs a source now, pauses it, and makes removing one a card', async () => {
    const d = deps();
    const a = createActions(d);
    const ran = await a.act({ refs: ['src_linear'], action: 'run_now', actor: 'person' });
    expect(ran.success && ran.data[0]).toMatchObject({ ok: true, message: 'Checked: 5 listed, 2 new.' });
    await a.act({ refs: ['src_linear'], action: 'pause', actor: 'person' });
    expect(d.sources.update).toHaveBeenCalledWith('src_linear', { paused: true });
    const removed = await a.act({ refs: ['src_linear'], action: 'remove', actor: 'person' });
    expect(removed.success && removed.data[0].card).toMatchObject({ action: 'remove' });
    await a.act({ refs: ['sit_1'], action: 'ignore', args: { reason: 'x' }, actor: 'Claude (agent)' });
    expect(d.relay.act).toHaveBeenCalledWith(['sit_1'], 'ignore', { reason: 'x' }, 'Claude (agent)');
  });

  it('starts work only with a fresh turn id, in the card\'s own space, and links the run to the card', async () => {
    const d = deps();
    const a = createActions(d);
    expect((await a.start({ task: 'x', userTurnId: 'made_up' })).success).toBe(false);
    const turn = d.turns.issue('chat');
    const started = await a.start({ ref: 'sit_1', userTurnId: turn });
    expect(started.success && started.data).toMatchObject({ runId: 'run_9', space: { name: 'deletion' } });
    expect(d.writeFile).toHaveBeenCalledWith('/r/deletion', expect.stringMatching(/^sessions\/2026-10-23-vendor-list\/brief\.md$/), expect.stringContaining('## Goal\nPick the list. The 8.'));
    expect(d.runLocal).toHaveBeenCalledWith({ bindingId: 'b2', prompt: 'Work through sessions/2026-10-23-vendor-list/brief.md.' });
    expect(d.relay.linkSession).toHaveBeenCalledWith('run_9', 'sit_1', 'b2');
    expect(d.relay.act).toHaveBeenCalledWith(['sit_1'], 'follow', { reason: 'a session was started for it' }, 'person');
  });

  it('asks which space when a task could go in several, and finds one by name', async () => {
    const a = createActions(deps());
    const d2 = deps();
    const turn = d2.turns.issue('chat');
    const ask = await createActions(d2).start({ task: 'triage the Earn bugs', userTurnId: turn });
    expect(!ask.success && ask.error.message).toBe('Which space? On this Mac: #ops, #deletion.');
    const named = await createActions(d2).start({ task: 'triage', space: '#ops', userTurnId: turn });
    expect(named.success && named.data.space.name).toBe('ops');
    void a;
  });

  it('reads since as relative or absolute', () => {
    expect(sinceToIso('3h', NOW)).toBe('2026-10-23T09:00:00.000Z');
    expect(sinceToIso('nonsense', NOW)).toBeUndefined();
  });

  it('passes relay failures through', async () => {
    const a = createActions(deps({ relay: { ...deps().relay, query: async () => err({ message: 'offline' }) } }));
    expect(await a.query({ kind: 'feed' })).toEqual(err({ message: 'offline' }));
  });
});

describe('run_now on a slow source', () => {
  it('answers after a short wait and lets the run finish', async () => {
    const d = deps({ runWaitMs: 10 });
    d.sources.run = vi.fn(() => new Promise<never>(() => {}));
    const r = await createActions(d).act({ refs: ['src_linear'], action: 'run_now', actor: 'person' });
    expect(r.success && r.data[0]).toMatchObject({ ok: true, message: expect.stringMatching(/^Checking now/) });
  });
});
