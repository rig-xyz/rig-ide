import { describe, expect, it } from 'vitest';
import {
  type OrchestratorContext,
  scriptedOrchestrator,
  sessionNameFromGoal,
} from './orchestrator';

const ctx: OrchestratorContext = {
  firstName: 'Dylan',
  needsYou: 2,
  upNext: 4,
  defaultSpaceId: 'ulys-backlog',
  spaceIds: ['ulys-backlog', 'rig-ops', 'rig-marketing'],
};

describe('scriptedOrchestrator', () => {
  it('greets with the live counts and a link to the finished session', () => {
    const [block] = scriptedOrchestrator.greeting(ctx);
    expect(block?.kind).toBe('text');
    if (block?.kind !== 'text') return;
    expect(block.runs[0]).toEqual({
      kind: 'text',
      text: expect.stringContaining('2 things need you and 4 are up next'),
    });
    expect(block.runs.some((r) => r.kind === 'session' && r.sessionId === 's-stale')).toBe(true);
  });

  it('answers a status question with the live status block', async () => {
    const blocks = await scriptedOrchestrator.respond('Status update', ctx);
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'status']);
  });

  it('drafts a brief in the space the goal is about', async () => {
    const blocks = await scriptedOrchestrator.respond(
      'Start a session to chart usage by domain',
      ctx
    );
    const brief = blocks.find((b) => b.kind === 'brief');
    expect(brief).toMatchObject({ start: { spaceId: 'rig-ops', name: 'Chart usage by domain' } });
  });

  it('offers a routine for a recurring ask', async () => {
    const blocks = await scriptedOrchestrator.respond(
      'Every Monday, clear stale Earn tickets',
      ctx
    );
    expect(blocks.find((b) => b.kind === 'routine')).toMatchObject({
      name: 'Clear stale Earn tickets',
    });
  });

  it('says what it understands otherwise', async () => {
    const [block] = await scriptedOrchestrator.respond('hello', ctx);
    expect(block?.kind === 'text' && block.runs.filter((r) => r.kind === 'bold')).toHaveLength(4);
  });
});

describe('sessionNameFromGoal', () => {
  it('keeps names rail-sized', () => {
    expect(sessionNameFromGoal('')).toBe('New session');
    expect(
      sessionNameFromGoal(
        'look into the sign-in loop on the website after the last release went out'
      )
    ).toBe('Look into the sign-in loop on the…');
  });
});
