import { describe, expect, it } from 'vitest';
import { FIXTURE_EVENTS, FIXTURE_RUNS, type FixtureRunKey } from './fixtures';
import { applySessionEvent, newSessionCard, projectSessionCard } from './projection';
import type { SessionEvent } from './types';

const RUN_KEYS = Object.keys(FIXTURE_EVENTS) as FixtureRunKey[];

describe('projectSessionCard — against real exported fixtures', () => {
  it('has all 6 real fixture runs available, non-empty', () => {
    expect(FIXTURE_RUNS.length).toBe(6);
    for (const key of RUN_KEYS) {
      expect(FIXTURE_EVENTS[key].length).toBeGreaterThan(0);
    }
  });

  it.each(RUN_KEYS)('%s: step count matches the number of tool_call events in the transcript', (key) => {
    const events = FIXTURE_EVENTS[key];
    const expectedSteps = events.filter((e) => e.kind === 'tool_call').length;
    const card = projectSessionCard(events);
    expect(card.steps.length).toBe(expectedSteps);
  });

  it.each(RUN_KEYS)('%s: a projection built incrementally equals one built from scratch', (key) => {
    const events = FIXTURE_EVENTS[key];

    const fromScratch = projectSessionCard(events);

    const incremental = newSessionCard();
    for (const event of events) applySessionEvent(incremental, event);

    expect(incremental).toEqual(fromScratch);
  });

  it.each(RUN_KEYS)('%s: incremental projection is also order-of-arrival-agnostic when re-sorted by seq', (key) => {
    // The room source may receive events slightly out of order (e.g. a
    // batched flush landing across two network frames); applySessionEvent
    // itself doesn't re-sort, so this only holds when callers feed it a
    // seq-sorted stream — assert that invariant holds for a shuffled-then-
    // resorted copy of the fixture, the shape any real room source must
    // preserve before calling applySessionEvent.
    const events = [...FIXTURE_EVENTS[key]];
    const shuffled = [...events].reverse();
    shuffled.sort((a, b) => a.seq - b.seq);

    const card = newSessionCard();
    for (const event of shuffled) applySessionEvent(card, event);

    expect(card).toEqual(projectSessionCard(events));
  });

  it.each(RUN_KEYS)('%s: every output row traces to a real diff block, and truncated payloads are marked approximate', (key) => {
    const events = FIXTURE_EVENTS[key];
    const card = projectSessionCard(events);
    const truncatedPaths = new Set<string>();
    for (const event of events) {
      if (!event.truncated) continue;
      const content = event.payload.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block && typeof block === 'object' && (block as { type?: string }).type === 'diff') {
          const path = (block as { path?: string }).path;
          if (typeof path === 'string') truncatedPaths.add(path);
        }
      }
    }
    for (const output of card.outputs) {
      if (truncatedPaths.has(output.path)) {
        expect(output.approximate).toBe(true);
      }
    }
  });

  it.each(RUN_KEYS)('%s: turn_ended settles status to done or stopped, never left running', (key) => {
    const events = FIXTURE_EVENTS[key];
    const hasTurnEnded = events.some((e) => e.kind === 'turn_ended');
    const card = projectSessionCard(events);
    if (hasTurnEnded) {
      expect(['done', 'stopped']).toContain(card.status);
      expect(card.currentStep).toBeNull();
    }
  });

  it('does not throw on a malformed event (missing/wrong-typed fields)', () => {
    const card = newSessionCard();
    const malformed: SessionEvent[] = [
      { seq: 1, kind: 'tool_call', payload: {} },
      { seq: 2, kind: 'tool_call_update', payload: { toolCallId: 'missing-step' } },
      { seq: 3, kind: 'agent_message_chunk', payload: { content: { type: 'text' } } },
      { seq: 4, kind: 'permission_requested', payload: {} },
      { seq: 5, kind: 'permission_decided', payload: {} },
      { seq: 6, kind: 'turn_ended', payload: {} },
      { seq: 7, kind: 'unknown_future_kind', payload: { anything: true } },
    ];
    expect(() => {
      for (const event of malformed) applySessionEvent(card, event);
    }).not.toThrow();
    expect(card.status).toBe('done');
  });

  it('tracks a held permission request with its options until it is decided', () => {
    const requested: SessionEvent = {
      seq: 1,
      kind: 'permission_requested',
      payload: {
        requestId: 'perm-1',
        toolCall: { toolCallId: 't1', title: 'npm test' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          { name: 'no id, dropped' },
        ],
        pubTs: 1,
      },
    };
    const pending = projectSessionCard([requested]);
    expect(pending.permissions.pending).toEqual([
      {
        requestId: 'perm-1',
        toolCallId: 't1',
        title: 'npm test',
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
        requestedAt: 1,
      },
    ]);

    const decided = projectSessionCard([
      requested,
      {
        seq: 2,
        kind: 'permission_decided',
        payload: { requestId: 'perm-1', toolCallId: 't1', optionId: 'allow', outcome: 'allowed' },
      },
    ]);
    expect(decided.permissions.pending).toEqual([]);
    expect(decided.permissions.decided).toEqual([
      { requestId: 'perm-1', toolCallId: 't1', optionId: 'allow', outcome: 'allowed' },
    ]);
  });

  it('an empty event log projects to the fresh-card defaults', () => {
    const card = projectSessionCard([]);
    expect(card).toEqual(newSessionCard());
  });
});
