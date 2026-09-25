import { describe, expect, it } from 'vitest';
import { LocalRunStore } from './local-runs';

const event = (seq: number, kind = 'tool_call', payload: Record<string, unknown> = { seq }) => ({ seq, kind, payload });

describe('LocalRunStore (the owner overlay)', () => {
  it('keeps each run whole and in order, and tells subscribers about every event', () => {
    const store = new LocalRunStore();
    const heard: string[] = [];
    store.subscribe((bindingId, runId, e) => heard.push(`${bindingId}/${runId}/${e.seq}`));
    store.append('b1', 'run1', event(1));
    store.append('b1', 'run1', event(2));
    store.append('b1', 'run2', event(1));
    expect(store.events('run1')?.map((e) => e.seq)).toEqual([1, 2]);
    expect(store.events('nope')).toBeNull();
    expect(heard).toEqual(['b1/run1/1', 'b1/run1/2', 'b1/run2/1']);
  });

  it('forgets the oldest runs past its limit', () => {
    const store = new LocalRunStore({ maxRuns: 2 });
    for (const id of ['a', 'b', 'c']) store.append('b1', id, event(1));
    expect(store.events('a')).toBeNull();
    expect(store.events('c')).not.toBeNull();
  });

  it('drops a run that outgrows its budget for good, so the Room falls back to the relay copy', () => {
    const store = new LocalRunStore({ maxBytesPerRun: 100 });
    store.append('b1', 'big', event(1, 'tool_call', { text: 'x'.repeat(50) }));
    store.append('b1', 'big', event(2, 'tool_call', { text: 'x'.repeat(80) }));
    expect(store.events('big')).toBeNull();
    store.append('b1', 'big', event(3));
    expect(store.events('big')).toBeNull();
  });

  it('notes one more event after the last (Hide details)', () => {
    const store = new LocalRunStore();
    store.append('b1', 'run1', event(1));
    store.note('run1', 'details_hidden', { steps: 1 });
    store.note('unknown', 'details_hidden', { steps: 1 });
    expect(store.events('run1')?.at(-1)).toEqual({ seq: 2, kind: 'details_hidden', payload: { steps: 1 } });
    expect(store.events('unknown')).toBeNull();
  });
});
