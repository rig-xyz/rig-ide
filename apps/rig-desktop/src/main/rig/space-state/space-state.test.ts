import { describe, expect, it, vi } from 'vitest';
import {
  createSpaceStateStore,
  RUN_KEPT_AFTER_END_MS,
  RUN_SILENT_DROP_MS,
  RUNS_KEPT,
  runStep,
  type SeenView,
} from './space-state';

const HOUR = 3_600_000;
const B = 'bnd_1';

function setup() {
  const clock = { now: 10 * HOUR };
  const changes: string[] = [];
  const store = createSpaceStateStore({ now: () => clock.now, onChange: (b) => changes.push(b) });
  const start = (runId: string, over: Partial<Parameters<typeof store.runStarted>[0]> = {}) =>
    store.runStarted({ bindingId: B, runId, ownerUserId: 'usr_me', agent: 'claude', startedBy: 'message', view: null, ...over });
  const end = (runId: string, status: unknown = 'done') => store.runEvent(B, runId, { kind: 'turn_ended', payload: { status } });
  const seen = (over: Partial<SeenView> = {}): SeenView => ({
    name: 'drafts',
    everyMs: HOUR,
    runsAs: 'usr_me',
    dataModifiedMs: 9 * HOUR,
    lastStartedMs: null,
    ...over,
  });
  return { store, clock, changes, start, end, seen };
}

describe('space state: runs', () => {
  it('shows a started run as working, from its start', () => {
    const { store, start } = setup();
    start('r1', { startedBy: 'clock' });
    const [run] = store.get(B).runs;
    expect(run).toMatchObject({ runId: 'r1', state: 'working', step: 'Starting', stepKind: 'starting', startedBy: 'clock', endedAt: null });
  });

  it('says what a tool call is in plain words, never a raw command or path', () => {
    expect(runStep({ kind: 'read', locations: [{ path: '/Users/x/space/FACTORY.md' }] })).toEqual({ step: 'Reading FACTORY.md', stepKind: 'reading' });
    expect(runStep({ kind: 'edit', locations: [{ path: '/s/views/a/data.json' }] })).toEqual({ step: 'Writing data.json', stepKind: 'writing' });
    expect(runStep({ kind: 'read' }).step).toBe('Reading a file');
    const run = runStep({ kind: 'execute', title: 'rm -rf /secret', rawInput: { command: 'rm -rf /secret' } });
    expect(run).toEqual({ step: 'Running a command', stepKind: 'running' });
    expect(JSON.stringify(run)).not.toContain('secret');
    expect(runStep({ title: 'mcp__rig__rig_chat_read', kind: 'other' })).toEqual({ step: 'Checking the space', stepKind: 'tool' });
    expect(runStep({ title: 'mcp__claude_ai_Linear__list_issues' }).step).toBe('Using Linear');
    expect(runStep({ title: 'mcp.some-server.go' }).step).toBe('Using some server');
    expect(runStep({ kind: 'search' })).toEqual({ step: 'Searching', stepKind: 'searching' });
    expect(runStep({ kind: 'fetch' }).step).toBe('Reading a web page');
    expect(runStep({ kind: 'delete' }).step).toBe('Removing a file');
    expect(runStep({ kind: 'move' }).step).toBe('Moving a file');
    expect(runStep({ kind: 'mystery' })).toEqual({ step: 'Working', stepKind: 'thinking' });
  });

  it('follows tool calls, thoughts and the reply; ignores bare updates', () => {
    const { store, start } = setup();
    start('r1');
    store.runEvent(B, 'r1', { kind: 'tool_call', payload: { kind: 'read', locations: [{ path: '/a/b.md' }] } });
    expect(store.get(B).runs[0].step).toBe('Reading b.md');
    store.runEvent(B, 'r1', { kind: 'tool_call_update', payload: { status: 'completed' } });
    expect(store.get(B).runs[0].step).toBe('Reading b.md');
    store.runEvent(B, 'r1', { kind: 'agent_thought_chunk', payload: {} });
    expect(store.get(B).runs[0]).toMatchObject({ step: 'Thinking', stepKind: 'thinking' });
    store.runEvent(B, 'r1', { kind: 'agent_message_chunk', payload: {} });
    expect(store.get(B).runs[0]).toMatchObject({ step: 'Writing its reply', stepKind: 'replying' });
    store.runEvent(B, 'r1', { kind: 'run_retried', payload: {} });
    expect(store.get(B).runs[0]).toMatchObject({ step: 'Starting again', stepKind: 'starting' });
  });

  it('waits while any permission is open', () => {
    const { store, start } = setup();
    start('r1');
    store.runEvent(B, 'r1', { kind: 'permission_requested', payload: { requestId: 'p1' } });
    expect(store.get(B).runs[0].state).toBe('waiting');
    store.runEvent(B, 'r1', { kind: 'permission_decided', payload: { requestId: 'p1' } });
    expect(store.get(B).runs[0].state).toBe('working');
    store.runEvent(B, 'r1', { kind: 'permission_requested', payload: { requestId: 'p2' } });
    store.runEvent(B, 'r1', { kind: 'permission_requested', payload: { requestId: 'p3' } });
    store.runEvent(B, 'r1', { kind: 'permission_decided', payload: { requestId: 'p2' } });
    expect(store.get(B).runs[0].state).toBe('waiting');
  });

  it('ends a run by its status, an odd one as failed, and forgets ended runs after a while', () => {
    const { store, clock, start, end } = setup();
    for (const [id, status, want] of [['a', 'done', 'done'], ['b', 'failed', 'failed'], ['c', 'stopped', 'stopped'], ['d', 'weird', 'failed']] as const) {
      start(id);
      end(id, status);
      const run = store.get(B).runs.find((r) => r.runId === id)!;
      expect(run).toMatchObject({ state: want, step: '', endedAt: clock.now });
    }
    clock.now += RUN_KEPT_AFTER_END_MS + 1;
    expect(store.get(B).runs).toEqual([]);
  });

  it('keeps at most twenty runs, active first, newest first', () => {
    const { store, clock, start, end } = setup();
    start('old-active');
    for (let i = 0; i < 25; i++) {
      clock.now += 1000;
      start(`r${i}`);
      end(`r${i}`);
    }
    const runs = store.get(B).runs;
    expect(runs).toHaveLength(RUNS_KEPT);
    expect(runs[0].runId).toBe('old-active');
    expect(runs[1].runId).toBe('r24');
  });

  it('ignores events for a run it does not know, and drops an active run that went silent', () => {
    const { store, clock, changes, start } = setup();
    store.runEvent(B, 'nope', { kind: 'turn_ended', payload: { status: 'done' } });
    expect(store.get(B).runs).toEqual([]);
    expect(changes).toEqual([]);
    start('r1');
    clock.now += RUN_SILENT_DROP_MS + 1;
    expect(store.get(B).runs).toEqual([]);
  });

  it('tells onChange once for ten identical message chunks', () => {
    const { store, changes, start } = setup();
    start('r1');
    changes.length = 0;
    for (let i = 0; i < 10; i++) store.runEvent(B, 'r1', { kind: 'agent_message_chunk', payload: { text: 'x' } });
    expect(changes).toEqual([B]);
  });
});

describe('space state: views', () => {
  it('ties a clock run to its view and records how it ended', () => {
    const { store, clock, start, end } = setup();
    start('r1', { startedBy: 'clock', view: 'drafts' });
    let view = store.get(B).views[0];
    expect(view).toMatchObject({ view: 'drafts', refreshingRunId: 'r1', lastRefresh: { startedAt: clock.now, finishedAt: null, startedBy: 'clock', result: null } });
    clock.now += 5000;
    end('r1', 'failed');
    view = store.get(B).views[0];
    expect(view.refreshingRunId).toBeNull();
    expect(view.lastRefresh).toMatchObject({ finishedAt: clock.now, result: 'failed' });
  });

  it('says when a schedule waits for this Mac\'s person to accept it', () => {
    const { store, seen } = setup();
    store.viewsSeen(B, 'usr_me', [seen({ needsAccept: true }), seen({ name: 'mine' })]);
    const byName = Object.fromEntries(store.get(B).views.map((v) => [v.view, v]));
    expect(byName.drafts.needsAccept).toBe(true);
    expect(byName.mine.needsAccept).toBe(false);
  });

  it('computes when a view is next due, who runs it, and forgets views that are gone', () => {
    const { store, clock, seen } = setup();
    store.viewsSeen(B, 'usr_me', [seen(), seen({ name: 'theirs', runsAs: 'usr_other' }), seen({ name: 'plain', everyMs: null, runsAs: null })]);
    const byName = Object.fromEntries(store.get(B).views.map((v) => [v.view, v]));
    expect(byName.drafts).toMatchObject({ nextDueAt: 10 * HOUR, runsHere: true });
    expect(byName.theirs.runsHere).toBe(false);
    expect(byName.plain).toMatchObject({ nextDueAt: null, runsHere: null });
    expect(store.get(B).views.map((v) => v.view)).toEqual(['drafts', 'plain', 'theirs']);
    store.viewsSeen(B, null, [seen()]);
    expect(store.get(B).views.map((v) => v.view)).toEqual(['drafts']);
    expect(store.get(B).views[0].runsHere).toBe(true); // me is remembered
    void clock;
  });

  it('does not know whether it runs here until it knows who is signed in', () => {
    const { store, seen } = setup();
    store.viewsSeen(B, null, [seen()]);
    expect(store.get(B).views[0].runsHere).toBeNull();
  });

  it('keeps the last refresh across looks', () => {
    const { store, start, end, seen } = setup();
    store.viewsSeen(B, 'usr_me', [seen()]);
    start('r1', { startedBy: 'view', view: 'drafts' });
    store.refreshStarted(B, 'drafts', 'r1');
    end('r1');
    store.viewsSeen(B, 'usr_me', [seen()]);
    expect(store.get(B).views[0].lastRefresh).toMatchObject({ startedBy: 'view', result: 'ok' });
  });

  it('does not count a button pressed in the view as its refresh', () => {
    const { store, start, end, seen } = setup();
    store.viewsSeen(B, 'usr_me', [seen()]);
    start('r1', { startedBy: 'view', view: 'drafts' });
    end('r1');
    expect(store.get(B).views[0].lastRefresh).toBeNull();
  });

  it('keeps a skip while the view is due, clears it once it is not or a run starts', () => {
    const { store, clock, start, seen } = setup();
    store.viewsSeen(B, 'usr_me', [seen()]);
    store.refreshSkipped(B, 'drafts', 'busy');
    store.viewsSeen(B, 'usr_me', [seen()]);
    expect(store.get(B).views[0].skipped).toEqual({ reason: 'busy', at: clock.now });
    store.viewsSeen(B, 'usr_me', [seen({ lastStartedMs: clock.now })]);
    expect(store.get(B).views[0].skipped).toBeNull();
    store.refreshSkipped(B, 'drafts', 'queued');
    start('r1', { startedBy: 'clock', view: 'drafts' });
    expect(store.get(B).views[0].skipped).toBeNull();
    store.refreshSkipped(B, 'ghost', 'busy'); // unknown view: no-op
    expect(store.get(B).views.map((v) => v.view)).toEqual(['drafts']);
  });

  it('records a refresh that could not start', () => {
    const { store, clock, seen } = setup();
    store.viewsSeen(B, 'usr_me', [seen()]);
    store.refreshNotStarted(B, 'drafts');
    expect(store.get(B).views[0].lastRefresh).toEqual({ startedAt: clock.now, finishedAt: clock.now, startedBy: 'clock', result: 'not_started' });
  });
});

describe('space state: shape', () => {
  it('is plain JSON and hands out copies', () => {
    const { store, start, seen } = setup();
    store.viewsSeen(B, 'usr_me', [seen()]);
    start('r1', { startedBy: 'clock', view: 'drafts' });
    const state = store.get(B);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    state.runs[0].step = 'tampered';
    state.views[0].view = 'tampered';
    expect(store.get(B).runs[0].step).toBe('Starting');
    expect(store.get(B).views[0].view).toBe('drafts');
    expect(store.get('unknown')).toMatchObject({ views: [], runs: [] });
    void vi;
  });
});
