import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { rigRigs } from '@main/db/schema';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

const { rigSessionsController } = await import('./sessions');

let fixture: Awaited<ReturnType<typeof openFixture>>;

beforeEach(async () => {
  fixture = await openFixture('empty');
  mocks.db = fixture.db;
  await fixture.db.insert(rigRigs).values({
    id: 'r1',
    path: '/tmp/rig',
    bindingId: 'binding-1',
    firstOpenedAt: 1,
    lastOpenedAt: 1,
  });
});

afterEach(() => {
  fixture.close();
  mocks.db = undefined;
});

describe('ensureSession', () => {
  it('creates a row for a known binding', async () => {
    const result = await rigSessionsController.ensureSession({
      sessionId: 's1',
      bindingId: 'binding-1',
      providerId: 'claude',
      acpSessionId: null,
    });
    expect(result).toEqual({ ok: true });

    const session = await rigSessionsController.getSession({ sessionId: 's1' });
    expect(session).toMatchObject({
      id: 's1',
      rigId: 'r1',
      providerId: 'claude',
      status: 'active',
      title: null,
      acpSessionId: null,
    });
  });

  it('fails honestly for an unknown binding rather than crashing', async () => {
    const result = await rigSessionsController.ensureSession({
      sessionId: 's1',
      bindingId: 'binding-does-not-exist',
      providerId: 'claude',
      acpSessionId: null,
    });
    expect(result.ok).toBe(false);
  });

  it('brings a closed session back to active and refreshes acpSessionId on resume', async () => {
    await rigSessionsController.ensureSession({
      sessionId: 's1',
      bindingId: 'binding-1',
      providerId: 'claude',
      acpSessionId: null,
    });
    await rigSessionsController.closeSession({ sessionId: 's1' });
    expect((await rigSessionsController.getSession({ sessionId: 's1' }))?.status).toBe('closed');

    await rigSessionsController.ensureSession({
      sessionId: 's1',
      bindingId: 'binding-1',
      providerId: 'claude',
      acpSessionId: 'acp-real-id',
    });
    const session = await rigSessionsController.getSession({ sessionId: 's1' });
    expect(session?.status).toBe('active');
    expect(session?.acpSessionId).toBe('acp-real-id');
  });

  it('keeps the original createdAt across a repeat ensureSession call', async () => {
    await rigSessionsController.ensureSession({
      sessionId: 's1',
      bindingId: 'binding-1',
      providerId: 'claude',
      acpSessionId: null,
    });
    const first = await rigSessionsController.getSession({ sessionId: 's1' });
    await rigSessionsController.ensureSession({
      sessionId: 's1',
      bindingId: 'binding-1',
      providerId: 'claude',
      acpSessionId: null,
    });
    const second = await rigSessionsController.getSession({ sessionId: 's1' });
    expect(second?.createdAt).toBe(first?.createdAt);
  });
});

describe('setTitle', () => {
  it('updates the title', async () => {
    await rigSessionsController.ensureSession({
      sessionId: 's1',
      bindingId: 'binding-1',
      providerId: 'claude',
      acpSessionId: null,
    });
    await rigSessionsController.setTitle({ sessionId: 's1', title: 'Fix the bug' });
    expect((await rigSessionsController.getSession({ sessionId: 's1' }))?.title).toBe('Fix the bug');
  });

  it('a freshly ensured session starts titleSource auto', async () => {
    await rigSessionsController.ensureSession({
      sessionId: 's1',
      bindingId: 'binding-1',
      providerId: 'claude',
      acpSessionId: null,
    });
    expect((await rigSessionsController.getSession({ sessionId: 's1' }))?.titleSource).toBe('auto');
  });

  it('setTitle keeps titleSource auto', async () => {
    await rigSessionsController.ensureSession({
      sessionId: 's1',
      bindingId: 'binding-1',
      providerId: 'claude',
      acpSessionId: null,
    });
    await rigSessionsController.setTitle({ sessionId: 's1', title: 'Fix the bug' });
    expect((await rigSessionsController.getSession({ sessionId: 's1' }))?.titleSource).toBe('auto');
  });

  it('never overwrites a manually-set title — the server-side half of the never-clobber rule', async () => {
    await rigSessionsController.ensureSession({
      sessionId: 's1',
      bindingId: 'binding-1',
      providerId: 'claude',
      acpSessionId: null,
    });
    await rigSessionsController.rename({ sessionId: 's1', title: 'My renamed session' });
    await rigSessionsController.setTitle({ sessionId: 's1', title: 'Auto-derived from the prompt' });
    const session = await rigSessionsController.getSession({ sessionId: 's1' });
    expect(session?.title).toBe('My renamed session');
    expect(session?.titleSource).toBe('manual');
  });
});

describe('rename', () => {
  it('sets the title and marks titleSource manual', async () => {
    await rigSessionsController.ensureSession({
      sessionId: 's1',
      bindingId: 'binding-1',
      providerId: 'claude',
      acpSessionId: null,
    });
    await rigSessionsController.rename({ sessionId: 's1', title: 'My renamed session' });
    const session = await rigSessionsController.getSession({ sessionId: 's1' });
    expect(session?.title).toBe('My renamed session');
    expect(session?.titleSource).toBe('manual');
  });

  it('a rename can overwrite an earlier manual rename too — always writes', async () => {
    await rigSessionsController.ensureSession({
      sessionId: 's1',
      bindingId: 'binding-1',
      providerId: 'claude',
      acpSessionId: null,
    });
    await rigSessionsController.rename({ sessionId: 's1', title: 'First rename' });
    await rigSessionsController.rename({ sessionId: 's1', title: 'Second rename' });
    expect((await rigSessionsController.getSession({ sessionId: 's1' }))?.title).toBe('Second rename');
  });
});

describe('appendEvents / getEvents', () => {
  beforeEach(async () => {
    await rigSessionsController.ensureSession({
      sessionId: 's1',
      bindingId: 'binding-1',
      providerId: 'claude',
      acpSessionId: null,
    });
  });

  it('stamps every event in one batch with the same at', async () => {
    const { at } = await rigSessionsController.appendEvents({
      sessionId: 's1',
      events: [
        { seq: 0, turn: { id: 't0', seq: 0 } },
        { seq: 1, turn: { id: 't1', seq: 1 } },
      ],
    });
    const events = await rigSessionsController.getEvents({ sessionId: 's1' });
    expect(events).toHaveLength(2);
    expect(events[0].at).toBe(at);
    expect(events[1].at).toBe(at);
  });

  it('preserves seq ordering on read regardless of insert order', async () => {
    await rigSessionsController.appendEvents({
      sessionId: 's1',
      events: [{ seq: 2, turn: { seq: 2 } }],
    });
    await rigSessionsController.appendEvents({
      sessionId: 's1',
      events: [{ seq: 0, turn: { seq: 0 } }, { seq: 1, turn: { seq: 1 } }],
    });
    const events = await rigSessionsController.getEvents({ sessionId: 's1' });
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('a duplicate seq in a resent batch is a no-op, not a re-stamp', async () => {
    const first = await rigSessionsController.appendEvents({
      sessionId: 's1',
      events: [{ seq: 0, turn: { seq: 0 } }],
    });
    await new Promise((r) => setTimeout(r, 2));
    await rigSessionsController.appendEvents({
      sessionId: 's1',
      events: [{ seq: 0, turn: { seq: 0, resent: true } }],
    });
    const events = await rigSessionsController.getEvents({ sessionId: 's1' });
    expect(events).toHaveLength(1);
    expect(events[0].at).toBe(first.at);
    expect(events[0].turn).toEqual({ seq: 0 });
  });

  it('touches updatedAt and keeps status active', async () => {
    await rigSessionsController.closeSession({ sessionId: 's1' });
    const { at } = await rigSessionsController.appendEvents({
      sessionId: 's1',
      events: [{ seq: 0, turn: { seq: 0 } }],
    });
    const session = await rigSessionsController.getSession({ sessionId: 's1' });
    expect(session?.status).toBe('active');
    expect(session?.updatedAt).toBe(at);
  });

  it('an empty batch is a no-op that still returns a stamp', async () => {
    const before = await rigSessionsController.getEvents({ sessionId: 's1' });
    const { at } = await rigSessionsController.appendEvents({ sessionId: 's1', events: [] });
    expect(typeof at).toBe('number');
    expect(await rigSessionsController.getEvents({ sessionId: 's1' })).toEqual(before);
  });
});

describe('listRecentAcrossRigs', () => {
  it('joins in the owning rig, newest-touched first, across bindings', async () => {
    await fixture.db.insert(rigRigs).values({
      id: 'r2',
      path: '/tmp/rig-two',
      bindingId: 'binding-2',
      name: 'Second rig',
      firstOpenedAt: 1,
      lastOpenedAt: 1,
    });
    await rigSessionsController.ensureSession({
      sessionId: 's1',
      bindingId: 'binding-1',
      providerId: 'claude',
      acpSessionId: null,
    });
    await new Promise((r) => setTimeout(r, 2));
    await rigSessionsController.ensureSession({
      sessionId: 's2',
      bindingId: 'binding-2',
      providerId: 'codex',
      acpSessionId: null,
    });

    const list = await rigSessionsController.listRecentAcrossRigs();
    expect(list).toEqual([
      expect.objectContaining({ id: 's2', rigBindingId: 'binding-2', rigName: 'Second rig', rigPath: '/tmp/rig-two' }),
      expect.objectContaining({ id: 's1', rigBindingId: 'binding-1', rigName: null, rigPath: '/tmp/rig' }),
    ]);
  });

  it('respects the limit', async () => {
    await rigSessionsController.ensureSession({
      sessionId: 's1',
      bindingId: 'binding-1',
      providerId: 'claude',
      acpSessionId: null,
    });
    await new Promise((r) => setTimeout(r, 2));
    await rigSessionsController.ensureSession({
      sessionId: 's2',
      bindingId: 'binding-1',
      providerId: 'claude',
      acpSessionId: null,
    });

    const list = await rigSessionsController.listRecentAcrossRigs({ limit: 1 });
    expect(list.map((s) => s.id)).toEqual(['s2']);
  });

  it('is empty with no sessions anywhere', async () => {
    expect(await rigSessionsController.listRecentAcrossRigs()).toEqual([]);
  });
});

describe('closeSession', () => {
  it('marks the session closed', async () => {
    await rigSessionsController.ensureSession({
      sessionId: 's1',
      bindingId: 'binding-1',
      providerId: 'claude',
      acpSessionId: null,
    });
    await rigSessionsController.closeSession({ sessionId: 's1' });
    expect((await rigSessionsController.getSession({ sessionId: 's1' }))?.status).toBe('closed');
  });
});

describe('listSessions', () => {
  it('lists newest-touched first, scoped to the binding', async () => {
    await rigSessionsController.ensureSession({
      sessionId: 's1',
      bindingId: 'binding-1',
      providerId: 'claude',
      acpSessionId: null,
    });
    await new Promise((r) => setTimeout(r, 2));
    await rigSessionsController.ensureSession({
      sessionId: 's2',
      bindingId: 'binding-1',
      providerId: 'codex',
      acpSessionId: null,
    });

    const list = await rigSessionsController.listSessions({ bindingId: 'binding-1' });
    expect(list.map((s) => s.id)).toEqual(['s2', 's1']);
  });

  it('returns an empty list for an unknown binding', async () => {
    expect(await rigSessionsController.listSessions({ bindingId: 'nope' })).toEqual([]);
  });
});
