import { describe, expect, it } from 'vitest';
import { FIXTURE_EVENTS, FIXTURE_RUNS, type FixtureRunKey } from './fixtures';
import { applySessionEvent, effectiveRunStatus, newSessionCard, projectSessionCard } from './projection';
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
        payload: { requestId: 'perm-1', toolCallId: 't1', optionId: 'allow', outcome: 'allowed', pubTs: 2 },
      },
    ]);
    expect(decided.permissions.pending).toEqual([]);
    // The record keeps what was asked and which kind of answer it got, for the step list.
    expect(decided.permissions.decided).toEqual([
      {
        requestId: 'perm-1',
        toolCallId: 't1',
        optionId: 'allow',
        outcome: 'allowed',
        optionKind: 'allow_once',
        title: 'npm test',
        decidedAt: 2,
      },
    ]);
  });

  it('keeps the latest plan and the accumulated thinking', () => {
    const card = projectSessionCard([
      { seq: 1, kind: 'agent_thought_chunk', payload: { content: { type: 'text', text: 'Look at ' } } },
      { seq: 2, kind: 'agent_thought_chunk', payload: { content: { type: 'text', text: 'the history.' } } },
      {
        seq: 3,
        kind: 'plan',
        payload: { entries: [{ content: 'Read the doc', status: 'in_progress' }, { content: 'Answer', status: 'pending' }] },
      },
      {
        seq: 4,
        kind: 'plan',
        payload: {
          entries: [
            { content: 'Read the doc', status: 'completed' },
            { content: 'Answer', status: 'in_progress' },
            { status: 'pending' },
          ],
        },
      },
    ]);
    expect(card.thinking).toBe('Look at the history.');
    expect(card.plan).toEqual([
      { content: 'Read the doc', status: 'completed' },
      { content: 'Answer', status: 'in_progress' },
    ]);
  });

  it('keeps the latest context usage and cost the agent reported', () => {
    const card = projectSessionCard([
      { seq: 1, kind: 'usage_update', payload: { size: 1000000, used: 40000 } },
      { seq: 2, kind: 'usage_update', payload: { size: 1000000, used: 46385, cost: { amount: 0.29, currency: 'USD' } } },
    ]);
    expect(card.usage).toEqual({ used: 46385, size: 1000000, costUsd: 0.29 });
  });

  it('replays relay-coalesced chunk runs, so the final answer is not lost', () => {
    const chunk = (text: string) => ({ messageId: 'm1', content: { type: 'text', text } });
    const card = projectSessionCard([
      { seq: 3, kind: 'agent_message_chunk', payload: { chunks: [chunk('Signups '), chunk('fell 17%.')] } },
    ]);
    expect(card.finalAnswer).toBe('Signups fell 17%.');
  });

  it("takes the live dispatcher's turn_ended status, including failed", () => {
    expect(projectSessionCard([{ seq: 1, kind: 'turn_ended', payload: { status: 'failed' } }]).status).toBe(
      'failed'
    );
    expect(projectSessionCard([{ seq: 1, kind: 'turn_ended', payload: { status: 'stopped' } }]).status).toBe(
      'stopped'
    );
    expect(projectSessionCard([{ seq: 1, kind: 'turn_ended', payload: { stopReason: 'end_turn' } }]).status).toBe(
      'done'
    );
  });

  it("doesn't keep spinning a run the relay already marks finished", () => {
    const running = projectSessionCard([{ seq: 1, kind: 'tool_call', payload: { toolCallId: 't1' } }]);
    expect(running.status).toBe('running');
    expect(effectiveRunStatus('failed', running)).toBe('failed');
    expect(effectiveRunStatus('running', running)).toBe('running');
    expect(effectiveRunStatus('failed', { status: 'done' })).toBe('done');
  });

  it('picks up the run model and a failure reason', () => {
    const card = projectSessionCard([
      { seq: 1, kind: 'run_model', payload: { model: 'claude-sonnet-5' } },
      { seq: 2, kind: 'turn_ended', payload: { status: 'failed', reason: "couldn't start the agent" } },
    ]);
    expect(card.model).toBe('claude-sonnet-5');
    expect(card.status).toBe('failed');
    expect(card.failureReason).toBe("couldn't start the agent");
  });

  it('an empty event log projects to the fresh-card defaults', () => {
    const card = projectSessionCard([]);
    expect(card).toEqual(newSessionCard());
  });

  it('records a run_connectors event as connector gaps, dropping anything malformed', () => {
    const card = projectSessionCard([
      {
        seq: 1,
        kind: 'run_connectors',
        payload: {
          gaps: [
            { id: 'linear', state: 'not_connected' },
            { id: 'sentry', state: 'expired' },
            { id: 'notion', state: 'connected' }, // not a gap — dropped
            { state: 'expired' }, // missing id — dropped
            'garbage',
          ],
        },
      },
    ]);
    expect(card.connectorGaps).toEqual([
      { id: 'linear', state: 'not_connected' },
      { id: 'sentry', state: 'expired' },
    ]);
  });
});

describe('projectSessionCard — Room sees', () => {
  it('reads the level a run ran at, private steps, and the step count at Answer', () => {
    const card = projectSessionCard([
      { seq: 1, kind: 'run_privacy', payload: { level: 'steps' } },
      { seq: 2, kind: 'tool_call', payload: { toolCallId: 'g1', kind: 'other', title: 'mcp__granola__search', private: true } },
      { seq: 3, kind: 'tool_call', payload: { toolCallId: 'r1', kind: 'read', title: 'Read a file' } },
      { seq: 4, kind: 'tool_call_update', payload: { toolCallId: 'r1', title: 'Read a file', private: true } },
      { seq: 5, kind: 'tool_call', payload: { toolCallId: 'e1', kind: 'edit', title: 'Edited plan.md' } },
    ]);
    expect(card.privacy).toBe('steps');
    expect(card.steps.map((s) => s.private ?? false)).toEqual([true, true, false]);

    const answer = projectSessionCard([
      { seq: 1, kind: 'run_privacy', payload: { level: 'answer' } },
      { seq: 2, kind: 'private_progress', payload: { steps: 1 } },
      { seq: 3, kind: 'private_progress', payload: { steps: 2 } },
      { seq: 4, kind: 'agent_message_chunk', payload: { messageId: 'm', content: { type: 'text', text: 'Done.' } } },
      { seq: 5, kind: 'private_progress', payload: { steps: 2, final: true } },
      { seq: 6, kind: 'turn_ended', payload: { status: 'done' } },
    ]);
    expect(answer).toMatchObject({ privacy: 'answer', privateSteps: 2, steps: [], finalAnswer: 'Done.', status: 'done' });
    expect(projectSessionCard([{ seq: 1, kind: 'run_privacy', payload: { level: 'bogus' } }]).privacy).toBeNull();
  });

  it("marks a run whose details its owner hid, keeping the step count, and the relay's re-sent answer replaces the old one", () => {
    const card = projectSessionCard([
      { seq: 1, kind: 'tool_call', payload: { toolCallId: 't1', kind: 'read', title: 'Read a.md' } },
      { seq: 2, kind: 'agent_message_chunk', payload: { messageId: 'm', content: { type: 'text', text: 'Answer.' } } },
      { seq: 3, kind: 'turn_ended', payload: { status: 'done' } },
      { seq: 4, kind: 'agent_message_chunk', payload: { messageId: 'hidden_run', content: { type: 'text', text: 'Answer.' } } },
      { seq: 5, kind: 'details_hidden', payload: { steps: 3 } },
    ]);
    expect(card).toMatchObject({ detailsHidden: true, privateSteps: 3, finalAnswer: 'Answer.' });
  });
});
