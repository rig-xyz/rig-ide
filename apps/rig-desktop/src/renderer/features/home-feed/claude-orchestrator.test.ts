import { describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/lib/ipc', () => ({ rpc: {} }));

const { answerBlocks, inlineRuns } = await import('./claude-orchestrator');

describe("Claude's answers in Home's chat", () => {
  it('keeps bold words bold', () => {
    expect(inlineRuns('Hid **the SOL card** until something new happens.')).toEqual([
      { kind: 'text', text: 'Hid ' },
      { kind: 'bold', text: 'the SOL card' },
      { kind: 'text', text: ' until something new happens.' },
    ]);
  });

  it('makes one block per paragraph and drops heading marks', () => {
    const blocks = answerBlocks('## Your Feed\n\n2 things need you.\n\n\nOne is up next.');
    expect(blocks.map((b) => (b.kind === 'text' ? b.runs.map((r) => ('text' in r ? r.text : '')).join('') : b.kind))).toEqual([
      'Your Feed',
      '2 things need you.',
      'One is up next.',
    ]);
  });
});
