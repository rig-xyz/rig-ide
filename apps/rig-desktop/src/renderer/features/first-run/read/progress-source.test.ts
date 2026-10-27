import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchProgressEvent } from '@shared/rig/orch-progress';

const ipc = vi.hoisted(() => ({
  listeners: new Set<(e: unknown) => void>(),
  answer: null as null | (() => unknown),
}));
vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: (_channel: unknown, l: (e: unknown) => void) => {
      ipc.listeners.add(l);
      return () => ipc.listeners.delete(l);
    },
  },
  rpc: { rig: { orch: { firstRun: async () => ipc.answer!() } } },
}));

const { liveFirstRun } = await import('./progress-source');

const run = 'run_1';
const ev = (seq: number, extra: Partial<OrchProgressEvent> = {}): OrchProgressEvent =>
  ({ run, kind: 'line', line: { id: `l${seq}`, connector: 'slack', label: `line ${seq}`, status: 'done', t: seq }, seq, ...extra }) as OrchProgressEvent;
const start: OrchProgressEvent = { run, kind: 'start', trigger: 'first', passes: 2, lookups: 52, lookbackDays: 3, t: 0, seq: 0 };
const emit = (e: OrchProgressEvent) => ipc.listeners.forEach((l) => l(e));

beforeEach(() => ipc.listeners.clear());

describe('liveFirstRun', () => {
  it('joins a first run already going: its events so far, then the live ones, each once and in order', async () => {
    let answer!: (v: unknown) => void;
    ipc.answer = () => new Promise((r) => (answer = r));
    const got: (number | undefined)[] = [];
    liveFirstRun.start((e) => got.push(e.seq));
    // Live events arrive before the answer, some already in it.
    emit(ev(2));
    emit(ev(3));
    answer({ success: true, data: { started: true, joined: true, events: [start, ev(1), ev(2)] } });
    await vi.waitFor(() => expect(got).toEqual([0, 1, 2, 3]));
    emit(ev(3));
    emit(ev(4));
    // Another run's events never come through.
    emit({ ...ev(5), run: 'run_scheduled' } as OrchProgressEvent);
    expect(got).toEqual([0, 1, 2, 3, 4]);
  });

  it('is safe to start twice, as a remount does: the stopped one hears nothing more', async () => {
    ipc.answer = async () => ({ success: true, data: { started: true, joined: false, events: [] } });
    const first: number[] = [];
    const second: number[] = [];
    const stop = liveFirstRun.start((e) => first.push(e.seq ?? -1));
    stop();
    liveFirstRun.start((e) => second.push(e.seq ?? -1));
    await new Promise((r) => setTimeout(r, 0));
    emit(start);
    emit(ev(1));
    expect(first).toEqual([]);
    expect(second).toEqual([0, 1]);
  });
});
