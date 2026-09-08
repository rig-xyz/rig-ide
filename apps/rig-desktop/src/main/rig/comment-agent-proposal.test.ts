import { describe, expect, it } from 'vitest';
import {
  extractProposal,
  PAINTBRUSH_REPLACEMENT_END,
  PAINTBRUSH_REPLACEMENT_START,
} from './comment-agent-proposal';

describe('extractProposal', () => {
  it('returns the answer untouched when there is no marker', () => {
    expect(extractProposal('This passage already reads clearly to me.')).toEqual({
      body: 'This passage already reads clearly to me.',
      proposal: null,
    });
  });

  it('extracts a replacement wrapped in the sentinel markers', () => {
    const answer = [
      'Tightened it up.',
      '',
      PAINTBRUSH_REPLACEMENT_START,
      'The quick brown fox jumps.',
      PAINTBRUSH_REPLACEMENT_END,
    ].join('\n');

    expect(extractProposal(answer)).toEqual({
      body: 'Tightened it up.',
      proposal: { replacement: 'The quick brown fox jumps.' },
    });
  });

  it('strips exactly one leading and trailing newline off the replacement, not surrounding whitespace', () => {
    const answer = `Done.\n${PAINTBRUSH_REPLACEMENT_START}\n  indented line\n${PAINTBRUSH_REPLACEMENT_END}`;
    expect(extractProposal(answer).proposal).toEqual({ replacement: '  indented line' });
  });

  it('falls back to a placeholder body when the answer is only the block', () => {
    const answer = `${PAINTBRUSH_REPLACEMENT_START}\nreplacement text\n${PAINTBRUSH_REPLACEMENT_END}`;
    expect(extractProposal(answer)).toEqual({
      body: 'Proposed a change to the selected passage.',
      proposal: { replacement: 'replacement text' },
    });
  });

  it('treats a start marker with no matching end marker as no proposal at all', () => {
    const answer = `Here's the idea:\n${PAINTBRUSH_REPLACEMENT_START}\nunterminated`;
    expect(extractProposal(answer)).toEqual({ body: answer, proposal: null });
  });

  it('treats an empty block as a proposal to delete the passage', () => {
    const answer = `Removing it.\n${PAINTBRUSH_REPLACEMENT_START}\n${PAINTBRUSH_REPLACEMENT_END}`;
    expect(extractProposal(answer)).toEqual({
      body: 'Removing it.',
      proposal: { replacement: '' },
    });
    expect(extractProposal(`${PAINTBRUSH_REPLACEMENT_START}\n${PAINTBRUSH_REPLACEMENT_END}`)).toEqual({
      body: 'Proposed removing the selected passage.',
      proposal: { replacement: '' },
    });
  });
});
