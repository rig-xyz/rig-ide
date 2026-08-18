import { describe, expect, it } from 'vitest';
import { stripAnsi } from './ansi';

const ESC = '\x1B';

describe('stripAnsi', () => {
  it('leaves plain text with no escapes untouched', () => {
    expect(stripAnsi('Building 4 packages…')).toBe('Building 4 packages…');
  });

  it('strips the exact reported husk pattern: ESC(B charset reset', () => {
    // The bug report's own repro: "(B" left over once the invisible ESC
    // prefix of a charset-designation sequence disappears from view.
    expect(stripAnsi(`${ESC}(Bhello`)).toBe('hello');
  });

  it('strips the exact reported husk pattern: bare ESC[m SGR reset', () => {
    expect(stripAnsi(`hello${ESC}[m`)).toBe('hello');
  });

  it('strips a full charset-reset + SGR-reset pair back to back (the real captured tail)', () => {
    // A common real shell-prompt tail: reset the G0 charset, then reset SGR.
    expect(stripAnsi(`done${ESC}(B${ESC}[m`)).toBe('done');
  });

  it('strips SGR color codes with explicit params', () => {
    expect(stripAnsi(`${ESC}[31mERROR${ESC}[0m: build failed`)).toBe('ERROR: build failed');
  });

  it('strips multi-param SGR (bold + color)', () => {
    expect(stripAnsi(`${ESC}[1;32mok${ESC}[0m`)).toBe('ok');
  });

  it('strips CSI private-mode sequences (cursor show/hide)', () => {
    expect(stripAnsi(`${ESC}[?25lworking${ESC}[?25h`)).toBe('working');
  });

  it('strips CSI cursor-movement/erase sequences from a progress-bar line', () => {
    // A realistic pnpm/npm-style progress redraw: clear line, cursor to column 1.
    expect(stripAnsi(`${ESC}[2K${ESC}[1GInstalling 42/100`)).toBe('Installing 42/100');
  });

  it('strips OSC sequences terminated by BEL', () => {
    expect(stripAnsi(`${ESC}]0;My Terminal Title${String.fromCharCode(7)}rest of line`)).toBe(
      'rest of line'
    );
  });

  it('strips OSC sequences terminated by ST (ESC \\\\)', () => {
    expect(stripAnsi(`${ESC}]0;My Terminal Title${ESC}\\rest of line`)).toBe('rest of line');
  });

  it('strips a full reset (ESC c)', () => {
    expect(stripAnsi(`${ESC}cfresh start`)).toBe('fresh start');
  });

  it('strips save/restore cursor (ESC 7 / ESC 8)', () => {
    expect(stripAnsi(`${ESC}7moved${ESC}8`)).toBe('moved');
  });

  it('strips a realistic multi-sequence build-tool line end to end', () => {
    const raw =
      `${ESC}[2K${ESC}[1G${ESC}[32m✓${ESC}[0m ` +
      `Compiled successfully${ESC}(B${ESC}[m`;
    expect(stripAnsi(raw)).toBe('✓ Compiled successfully');
  });

  it('never strips plain parens/brackets that are not part of an escape sequence', () => {
    expect(stripAnsi('See item [1] in (parentheses)')).toBe('See item [1] in (parentheses)');
    expect(stripAnsi('(B) is not a charset designation without ESC')).toBe(
      '(B) is not a charset designation without ESC'
    );
  });

  it('handles an empty string', () => {
    expect(stripAnsi('')).toBe('');
  });

  it('strips sequences spread across an otherwise-multiline string, line breaks intact', () => {
    const raw = `line one${ESC}[0m\nline ${ESC}[31mtwo${ESC}[0m\nline three`;
    expect(stripAnsi(raw)).toBe('line one\nline two\nline three');
  });
});
