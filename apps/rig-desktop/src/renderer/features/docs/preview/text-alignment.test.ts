import { describe, expect, it } from 'vitest';
import { alignEscaped, contentSlice, parseFence, parseInlineCodeFence } from './text-alignment';

describe('alignEscaped', () => {
  it('a plain run with no divergence maps 1:1 for its whole length', () => {
    const { breakpoints, matchedLen } = alignEscaped('hello world', 'hello world', 100);
    expect(matchedLen).toBe(11);
    expect(breakpoints).toEqual([{ dom: 0, src: 100 }]);
  });

  it('a backslash-escaped tilde: rendered "~", source "\\~"', () => {
    const { breakpoints, matchedLen } = alignEscaped('a~b', 'a\\~b', 10);
    expect(matchedLen).toBe(3);
    // dom 1 (the "~") maps to src 11 ("\~" starts one after "a").
    expect(breakpoints).toEqual([
      { dom: 0, src: 10 },
      { dom: 2, src: 13 }, // after the escape, dom advances by 1 char, src by 2
    ]);
  });

  it('a backslash-escaped underscore and bracket, several in one leaf', () => {
    const { matchedLen } = alignEscaped('a_b[c', 'a\\_b\\[c', 0);
    expect(matchedLen).toBe(5); // "a_b[c" fully explained
  });

  it('an entity reference: &amp; -> &', () => {
    const { breakpoints, matchedLen } = alignEscaped('Q&A', 'Q&amp;A', 0);
    expect(matchedLen).toBe(3);
    expect(breakpoints).toEqual([
      { dom: 0, src: 0 },
      { dom: 2, src: 6 }, // "&amp;" is 5 chars, "&" is 1 — dom advances 1, src advances 5
    ]);
  });

  it('&lt; and &gt;', () => {
    expect(alignEscaped('a<b>c', 'a&lt;b&gt;c', 0).matchedLen).toBe(5);
  });

  it("a numeric entity: &#39; -> '", () => {
    expect(alignEscaped("it's", 'it&#39;s', 0).matchedLen).toBe(4);
  });

  it("a hex numeric entity: &#x27; -> '", () => {
    expect(alignEscaped("it's", 'it&#x27;s', 0).matchedLen).toBe(4);
  });

  it('an emoji (surrogate pair) with plain text around it, no special-casing needed', () => {
    const rendered = 'ship it 🚀 today';
    const { matchedLen } = alignEscaped(rendered, rendered, 0);
    expect(matchedLen).toBe(rendered.length);
    // Sanity: the emoji really is two UTF-16 code units.
    expect('🚀'.length).toBe(2);
  });

  it('an emoji immediately after an escape', () => {
    const { matchedLen } = alignEscaped('~🎉', '\\~🎉', 0);
    expect(matchedLen).toBe(3); // "~" + the 2-code-unit emoji
  });

  it('stops at an unexplained divergence rather than guessing, and reports how far it got', () => {
    const { breakpoints, matchedLen } = alignEscaped('abXd', 'abcd', 0);
    expect(matchedLen).toBe(2); // "ab" matched; "X" vs "c" is unexplained
    expect(breakpoints).toEqual([{ dom: 0, src: 0 }]);
  });

  it('an unrecognized named entity does not match — the alignment stops there', () => {
    // &zzzzz; is not in the small named-entity table this module supports.
    const { matchedLen } = alignEscaped('Qz', 'Q&zzzzz;', 0);
    expect(matchedLen).toBe(1); // only "Q" explained
  });
});

describe('parseFence', () => {
  it('a fenced block with a language tag', () => {
    const slice = '```js\nconsole.log(1)\n```';
    expect(parseFence(slice)).toEqual({
      innerStartRel: 6, // "```js\n"
      innerEndRel: slice.indexOf('\n```'),
    });
  });

  it('a fenced block with no language', () => {
    const slice = '```\nplain\n```';
    const result = parseFence(slice)!;
    expect(slice.slice(result.innerStartRel, result.innerEndRel)).toBe('plain');
  });

  it('tildes fence, and a longer closing fence than opening still matches (>= fenceLen)', () => {
    const slice = '~~~\ncode\n~~~~';
    const result = parseFence(slice)!;
    expect(slice.slice(result.innerStartRel, result.innerEndRel)).toBe('code');
  });

  it('multi-line content', () => {
    const slice = '```\nline one\nline two\n```';
    const result = parseFence(slice)!;
    expect(slice.slice(result.innerStartRel, result.innerEndRel)).toBe('line one\nline two');
  });

  it('an indented code block (no fence line at all) is not recognized', () => {
    expect(parseFence('    indented code\n    more')).toBeNull();
  });
});

describe('parseInlineCodeFence', () => {
  it('single backtick', () => {
    const result = parseInlineCodeFence('`code`')!;
    expect('`code`'.slice(result.innerStartRel, result.innerEndRel)).toBe('code');
  });

  it('double backtick, so a single literal backtick can appear inside', () => {
    const slice = '``a`b``';
    const result = parseInlineCodeFence(slice)!;
    expect(slice.slice(result.innerStartRel, result.innerEndRel)).toBe('a`b');
  });

  it('strips exactly one padding space per side when both ends have one', () => {
    const slice = '` `` `'; // content is "`` " wrapped in single spaces
    const result = parseInlineCodeFence(slice)!;
    expect(slice.slice(result.innerStartRel, result.innerEndRel)).toBe('``');
  });

  it('does not strip padding when the content is only spaces', () => {
    const slice = '`  `'; // two spaces, both ends "have a space" but it's all spaces
    const result = parseInlineCodeFence(slice)!;
    expect(slice.slice(result.innerStartRel, result.innerEndRel)).toBe('  ');
  });

  it('not a code span at all', () => {
    expect(parseInlineCodeFence('plain text')).toBeNull();
  });
});

describe('contentSlice', () => {
  // `innerEndRel` is always `slice.length` (see the contentSlice doc: trailing
  // markers are left as unused slack for alignEscaped, never stripped here),
  // so every case below only needs to check that content STARTS at
  // innerStartRel — not that it ends there too.

  it('strong: skips ** at the start', () => {
    const slice = '**bold** rest';
    const r = contentSlice('STRONG', slice);
    expect(r.innerEndRel).toBe(slice.length);
    expect(slice.slice(r.innerStartRel).startsWith('bold')).toBe(true);
  });

  it('strong with underscores', () => {
    const slice = '__bold__ rest';
    const r = contentSlice('STRONG', slice);
    expect(slice.slice(r.innerStartRel).startsWith('bold')).toBe(true);
  });

  it('em: skips a single marker at the start', () => {
    const slice = '*italic* rest';
    const r = contentSlice('EM', slice);
    expect(slice.slice(r.innerStartRel).startsWith('italic')).toBe(true);
  });

  it('del: skips ~~ at the start', () => {
    const slice = '~~gone~~ rest';
    const r = contentSlice('DEL', slice);
    expect(slice.slice(r.innerStartRel).startsWith('gone')).toBe(true);
  });

  it('a: inline link, skips the opening [', () => {
    const slice = '[click here](https://example.com) rest';
    const r = contentSlice('A', slice);
    expect(slice.slice(r.innerStartRel).startsWith('click here')).toBe(true);
  });

  it('a: reference link, shortcut link, and autolink all skip exactly one opening char', () => {
    expect(contentSlice('A', '[click here][ref]').innerStartRel).toBe(1);
    expect(contentSlice('A', '[click here]').innerStartRel).toBe(1);
    expect(contentSlice('A', '<https://example.com>').innerStartRel).toBe(1);
  });

  it('a: autolink content starts right after the <', () => {
    const slice = '<https://example.com/quick>';
    const r = contentSlice('A', slice);
    expect(slice.slice(r.innerStartRel).startsWith('https://example.com/quick')).toBe(true);
  });

  it('li: bullet marker', () => {
    const slice = '- an item';
    const r = contentSlice('LI', slice);
    expect(slice.slice(r.innerStartRel)).toBe('an item');
  });

  it('li: ordered marker', () => {
    const slice = '12. an item';
    const r = contentSlice('LI', slice);
    expect(slice.slice(r.innerStartRel)).toBe('an item');
  });

  it('li: task-list checkbox after the bullet', () => {
    const slice = '- [x] done thing';
    const r = contentSlice('LI', slice);
    expect(slice.slice(r.innerStartRel)).toBe('done thing');
  });

  it('li: unchecked task-list checkbox', () => {
    const slice = '* [ ] todo thing';
    const r = contentSlice('LI', slice);
    expect(slice.slice(r.innerStartRel)).toBe('todo thing');
  });

  it('td/th: a GFM table cell position includes its own leading pipe and padding', () => {
    expect(contentSlice('TD', '| Done ').innerStartRel).toBe(2);
    expect(contentSlice('TH', '| Feature ').innerStartRel).toBe(2);
    expect(contentSlice('TD', '|Done').innerStartRel).toBe(1); // no padding space still skips just the pipe
  });

  it('h1..h6: ATX marker of the right width', () => {
    expect(contentSlice('H1', '# One').innerStartRel).toBe(2);
    expect(contentSlice('H3', '### Three').innerStartRel).toBe(4);
  });

  it('heading: setext (underline, no leading marker to skip)', () => {
    const slice = 'Title\n=====';
    const r = contentSlice('H1', slice);
    expect(r.innerStartRel).toBe(0);
    expect(slice.slice(r.innerStartRel).startsWith('Title')).toBe(true);
  });

  it('tags with no marker syntax of their own pass through unchanged', () => {
    for (const tag of ['P', 'TABLE', 'TR', 'UL', 'OL', 'BLOCKQUOTE']) {
      const slice = 'plain content';
      expect(contentSlice(tag, slice)).toEqual({ innerStartRel: 0, innerEndRel: slice.length });
    }
  });
});
