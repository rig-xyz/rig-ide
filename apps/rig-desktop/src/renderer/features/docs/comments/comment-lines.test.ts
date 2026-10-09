import { describe, expect, it } from 'vitest';
import { lineLabel, showsLineNumbers } from './comment-lines';

describe('comment line numbers', () => {
  it('shows lines on code and text files, not markdown', () => {
    expect(showsLineNumbers('/space/src/app.ts')).toBe(true);
    expect(showsLineNumbers('/space/notes.txt')).toBe(true);
    expect(showsLineNumbers('/space/plan.md')).toBe(false);
    expect(showsLineNumbers('/space/doc.MDX')).toBe(false);
  });

  it('names the line, or the lines a passage spans', () => {
    const text = 'one\ntwo\nthree\nfour\n';
    expect(lineLabel(text, text.indexOf('two'), 3)).toBe('Line 2');
    expect(lineLabel(text, text.indexOf('two'), 'two\nthree'.length)).toBe('Lines 2 to 3');
    expect(lineLabel(text, 0, 0)).toBe('Line 1');
  });
});
