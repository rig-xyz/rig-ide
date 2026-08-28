import { describe, expect, it } from 'vitest';
import { buildPositionIndex } from './position-index';
import { renderPreviewDom } from './render-preview';

/**
 * The read half, targeted: each case below builds the index for a small
 * markdown document and checks a specific mapping by hand — the exact
 * scenarios docs/preview-mode-spec.md calls out (escapes, entities, GFM
 * tables, task lists, nested lists, code, blockquotes, links, nested
 * em/strong/del, formatting-crossing selections). `position-index-property.test.ts`
 * covers the same ground with randomized ranges across whole documents;
 * this file is for pinning down specific, readable expectations.
 */

/** First occurrence of `needle` in any text node under `root`, as a boundary point. */
function locate(root: HTMLElement, needle: string): { node: Text; offset: number } {
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  let n = walker.nextNode();
  while (n) {
    const idx = (n as Text).data.indexOf(needle);
    if (idx !== -1) return { node: n as Text, offset: idx };
    n = walker.nextNode();
  }
  throw new Error(`locate: ${JSON.stringify(needle)} not found`);
}

function rangeOf(document: Document, root: HTMLElement, needle: string): Range {
  const start = locate(root, needle);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(start.node, start.offset + needle.length);
  return range;
}

describe('escapes', () => {
  it('a backslash-escaped tilde', () => {
    const source = 'literal \\~tilde\\~ here';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    const range = rangeOf(document, root, '~tilde~');
    const mapped = index.rangeToSource(range);
    expect(mapped && source.slice(mapped.start, mapped.end)).toBe('\\~tilde\\~');
  });

  it('a backslash-escaped underscore', () => {
    const source = 'a \\_b\\_ c';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    const range = rangeOf(document, root, '_b_');
    const mapped = index.rangeToSource(range);
    expect(mapped && source.slice(mapped.start, mapped.end)).toBe('\\_b\\_');
  });

  it('a backslash-escaped bracket, which would otherwise start a link', () => {
    const source = 'not \\[a link\\] here';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    expect(root.querySelector('a')).toBeNull(); // sanity: it really did not become a link
    const range = rangeOf(document, root, '[a link]');
    const mapped = index.rangeToSource(range);
    expect(mapped && source.slice(mapped.start, mapped.end)).toBe('\\[a link\\]');
  });
});

describe('entities', () => {
  it('&amp;', () => {
    const source = 'Q&amp;A session';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    const range = rangeOf(document, root, 'Q&A');
    const mapped = index.rangeToSource(range);
    expect(mapped && source.slice(mapped.start, mapped.end)).toBe('Q&amp;A');
  });

  it('&lt; and &gt;', () => {
    const source = 'a &lt;tag&gt; here';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    const range = rangeOf(document, root, '<tag>');
    const mapped = index.rangeToSource(range);
    expect(mapped && source.slice(mapped.start, mapped.end)).toBe('&lt;tag&gt;');
  });
});

describe('emoji / surrogate pairs', () => {
  it('an emoji mid-sentence maps correctly on both sides', () => {
    const source = 'ship it 🚀 today please';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    const range = rangeOf(document, root, '🚀 today');
    const mapped = index.rangeToSource(range);
    expect(mapped && source.slice(mapped.start, mapped.end)).toBe('🚀 today');
  });

  it('a selection landing exactly between the two UTF-16 units of an emoji round-trips through sourceToDom', () => {
    const source = 'a 🚀 b';
    const { root } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    const emojiStart = source.indexOf('🚀');
    const back = index.sourceToDom(emojiStart, emojiStart + 2); // 2 UTF-16 units
    expect(back?.map((r) => r.toString()).join('')).toBe('🚀');
  });
});

describe('GFM tables', () => {
  const source = '| Name | Role |\n| --- | --- |\n| Ada | Engineer |\n| Grace | Admiral |\n';

  it('a selection inside a single cell', () => {
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    const range = rangeOf(document, root, 'Engineer');
    const mapped = index.rangeToSource(range);
    expect(mapped && source.slice(mapped.start, mapped.end)).toBe('Engineer');
  });

  it('a selection spanning from one cell into the next (crossing the pipe)', () => {
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    const start = locate(root, 'Ada');
    const end = locate(root, 'Engineer');
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset + 'Engineer'.length);
    const mapped = index.rangeToSource(range);
    expect(mapped && source.slice(mapped.start, mapped.end)).toBe('Ada | Engineer');

    // And the reverse direction: sourceToDom for that span renders as TWO
    // ranges (one per cell) — the pipe between them has no DOM text of its
    // own to include, so a single contiguous Range can't represent it.
    const back = index.sourceToDom(mapped!.start, mapped!.end);
    expect(back?.length).toBe(2);
    expect(back?.map((r) => r.toString())).toEqual(['Ada', 'Engineer']);
  });

  it('header cells map too', () => {
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    const range = rangeOf(document, root, 'Role');
    const mapped = index.rangeToSource(range);
    expect(mapped && source.slice(mapped.start, mapped.end)).toBe('Role');
  });
});

describe('task lists', () => {
  it('checked and unchecked item text', () => {
    const source = '- [x] shipped\n- [ ] pending\n';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    expect(root.querySelectorAll('input[type="checkbox"]').length).toBe(2);

    const shipped = rangeOf(document, root, 'shipped');
    expect(index.rangeToSource(shipped)).toEqual({
      start: source.indexOf('shipped'),
      end: source.indexOf('shipped') + 'shipped'.length,
    });

    const pending = rangeOf(document, root, 'pending');
    expect(index.rangeToSource(pending)).toEqual({
      start: source.indexOf('pending'),
      end: source.indexOf('pending') + 'pending'.length,
    });
  });

  it('a task item that also contains a nested (non-task) list', () => {
    const source = '- [ ] parent task\n  - child bullet\n';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    const parent = rangeOf(document, root, 'parent task');
    expect(index.rangeToSource(parent)).toEqual({
      start: source.indexOf('parent task'),
      end: source.indexOf('parent task') + 'parent task'.length,
    });
    const child = rangeOf(document, root, 'child bullet');
    expect(index.rangeToSource(child)).toEqual({
      start: source.indexOf('child bullet'),
      end: source.indexOf('child bullet') + 'child bullet'.length,
    });
  });
});

describe('nested lists', () => {
  it('a bullet inside a bullet inside a bullet', () => {
    const source = '- one\n  - two\n    - three\n';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    for (const word of ['one', 'two', 'three']) {
      const range = rangeOf(document, root, word);
      expect(index.rangeToSource(range)).toEqual({
        start: source.indexOf(word),
        end: source.indexOf(word) + word.length,
      });
    }
  });

  it('an ordered list nested inside a bullet list', () => {
    const source = '- outer\n  1. first\n  2. second\n';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    const range = rangeOf(document, root, 'second');
    expect(index.rangeToSource(range)).toEqual({
      start: source.indexOf('second'),
      end: source.indexOf('second') + 'second'.length,
    });
  });
});

describe('inline code', () => {
  it('a simple code span', () => {
    const source = 'call `doThing()` now';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    const range = rangeOf(document, root, 'doThing()');
    const mapped = index.rangeToSource(range);
    expect(mapped && source.slice(mapped.start, mapped.end)).toBe('doThing()');
  });

  it('a code span containing a literal backtick (double-backtick fence)', () => {
    const source = 'the char `` ` `` itself';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    expect(root.querySelector('code')?.textContent).toBe('`');
    const range = rangeOf(document, root, '`');
    const mapped = index.rangeToSource(range);
    expect(mapped && source.slice(mapped.start, mapped.end)).toBe('`');
  });
});

describe('code blocks', () => {
  it('fenced, with a language tag', () => {
    const source = '```ts\nconst x = 1;\nconst y = 2;\n```\n';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    expect(root.querySelector('code')?.className).toBe('language-ts');
    const range = rangeOf(document, root, 'const y = 2;');
    const mapped = index.rangeToSource(range);
    expect(mapped && source.slice(mapped.start, mapped.end)).toBe('const y = 2;');
  });

  it('fenced, no language', () => {
    const source = '```\nplain block\n```\n';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    const range = rangeOf(document, root, 'plain block');
    const mapped = index.rangeToSource(range);
    expect(mapped && source.slice(mapped.start, mapped.end)).toBe('plain block');
  });

  it('selecting through the synthetic trailing newline still resolves to the end of the real content', () => {
    const source = '```\nabc\n```\n';
    const { root } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    const code = root.querySelector('code')!;
    const textNode = code.firstChild!;
    expect(textNode.textContent).toBe('abc\n'); // the synthetic trailing "\n"
    expect(index.domToSource(textNode, 3)).toBe(source.indexOf('abc') + 3); // end of "abc" — right before the real "\n"
    // Past the synthetic "\n" (offset 4) lands one further: the mapping
    // treats it as coinciding with that SAME real "\n" in the source
    // (position 7), landing right at the start of the closing fence — a
    // reasonable resume point for a selection that continues past the block.
    expect(index.domToSource(textNode, 4)).toBe(source.indexOf('```', 1));
  });
});

describe('blockquotes', () => {
  it('a single-line blockquote', () => {
    const source = '> a quoted line\n';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    const range = rangeOf(document, root, 'quoted');
    const mapped = index.rangeToSource(range);
    expect(mapped && source.slice(mapped.start, mapped.end)).toBe('quoted');
  });

  it('a multi-line blockquote — the continuation line still has its own "> " in the raw source', () => {
    const source = '> first line\n> second line\n';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    const range = rangeOf(document, root, 'second');
    const mapped = index.rangeToSource(range);
    expect(mapped && source.slice(mapped.start, mapped.end)).toBe('second');
  });
});

describe('links', () => {
  it('inline link — rendered text excludes the hidden URL', () => {
    const source = 'go to [the docs](https://example.com/docs "Docs") now';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    const range = rangeOf(document, root, 'the docs');
    const mapped = index.rangeToSource(range);
    expect(mapped && source.slice(mapped.start, mapped.end)).toBe('the docs');
  });

  it('reference-style link', () => {
    const source = 'see [the guide][guide] please\n\n[guide]: https://example.com/guide\n';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    const range = rangeOf(document, root, 'the guide');
    const mapped = index.rangeToSource(range);
    expect(mapped && source.slice(mapped.start, mapped.end)).toBe('the guide');
  });

  it('autolink — the visible text IS the URL', () => {
    const source = 'contact <https://example.com/contact> us';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    const range = rangeOf(document, root, 'https://example.com/contact');
    const mapped = index.rangeToSource(range);
    expect(mapped && source.slice(mapped.start, mapped.end)).toBe('https://example.com/contact');
  });
});

describe('em / strong / del, including nested', () => {
  it('strong nested inside em', () => {
    const source = 'plain *em **strong** end* done';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    const range = rangeOf(document, root, 'strong');
    const mapped = index.rangeToSource(range);
    expect(mapped && source.slice(mapped.start, mapped.end)).toBe('strong');
  });

  it('em nested inside strong', () => {
    const source = 'plain **strong *em* end** done';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    const range = rangeOf(document, root, 'em');
    const mapped = index.rangeToSource(range);
    expect(mapped && source.slice(mapped.start, mapped.end)).toBe('em');
  });

  it('del containing strong', () => {
    const source = 'was ~~totally **broken**~~ now fixed';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    const range = rangeOf(document, root, 'broken');
    const mapped = index.rangeToSource(range);
    expect(mapped && source.slice(mapped.start, mapped.end)).toBe('broken');
  });

  it('a selection spanning the ENTIRE em-nested-in-strong construct, markers included', () => {
    const source = 'plain **strong *em* end** done';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    const start = locate(root, 'strong');
    const endText = locate(root, 'end');
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(endText.node, endText.offset + 'end'.length);
    const mapped = index.rangeToSource(range);
    expect(mapped && source.slice(mapped.start, mapped.end)).toBe('strong *em* end');
  });
});

describe('selections crossing formatting boundaries', () => {
  it('plain text into bold and back out to plain text — the classic orphan case this whole mechanism exists to fix', () => {
    const source = 'Please see **the attached document** for details.';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    const p = root.querySelector('p')!;
    const before = p.firstChild as Text; // "Please see "
    const after = p.lastChild as Text; // " for details."
    const range = document.createRange();
    range.setStart(before, before.data.indexOf('see'));
    range.setEnd(after, after.data.indexOf('for') + 3);
    const mapped = index.rangeToSource(range);
    // Exact by construction — the anchor's quote is real source text,
    // including the "**" markers the DOM never showed at all.
    expect(mapped && source.slice(mapped.start, mapped.end)).toBe(
      'see **the attached document** for'
    );
  });

  it('a selection starting mid-word inside bold and ending mid-word in plain text after it', () => {
    const source = 'a **bold** word';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    const bold = locate(root, 'bold');
    const word = locate(root, 'word');
    const range = document.createRange();
    range.setStart(bold.node, bold.offset + 2); // "ld" of "bold"
    range.setEnd(word.node, word.offset + 2); // "wo" of "word"
    const mapped = index.rangeToSource(range);
    expect(mapped && source.slice(mapped.start, mapped.end)).toBe('ld** wo');
  });

  it('a selection starting in plain text and ending mid-word inside italics', () => {
    const source = 'start *italic text* end';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    const p = root.querySelector('p')!;
    const before = p.firstChild as Text; // "start "
    const italic = locate(root, 'italic');
    const range = document.createRange();
    range.setStart(before, 0);
    range.setEnd(italic.node, italic.offset + 3); // "ita"
    const mapped = index.rangeToSource(range);
    expect(mapped && source.slice(mapped.start, mapped.end)).toBe('start *ita');
  });
});
