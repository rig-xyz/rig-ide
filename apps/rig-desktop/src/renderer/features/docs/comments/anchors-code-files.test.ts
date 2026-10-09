import { describe, expect, it } from 'vitest';
import { buildAnchorFromRange, reanchor } from './anchors';

/**
 * Comments and pins spike (rig docs/comments-pins-spike.md), surface 1:
 * a comment on a code file, then the file changes. Each test here fails
 * today and describes the behavior a reader would expect.
 *
 * Code repeats itself far more than prose (`return null;`, `}`), gets
 * reindented by formatters, and changes line endings between machines, so
 * these are the cases a code file meets first.
 */

const source = `import { load } from './load';

export function parse(input: string) {
  const value = load(input);
  if (!value) return null;
  return value.trim();
}

export function format(item: Item) {
  if (!item) return null;
  return item.name;
}
`;

/** The anchor the margin builds for a selection of the `nth` occurrence of `quote`. */
function selectionAnchor(text: string, quote: string, nth = 0) {
  let at = -1;
  for (let i = 0; i <= nth; i++) at = text.indexOf(quote, at + 1);
  if (at === -1) throw new Error(`no occurrence ${nth} of ${quote}`);
  return buildAnchorFromRange(text, at, at + quote.length);
}

describe('code file comments after the file changes', () => {
  it('a comment on a repeated line stays in its own function when the lines around it are edited', () => {
    // Comment on the second `return null;` (inside format).
    const anchor = selectionAnchor(source, 'return null;', 1);
    // Rename the parameter: both the prefix and the suffix around the
    // anchored text change, though the line itself does not.
    const renamed = source
      .replace('format(item: Item)', 'format(entry: Item)')
      .replace('if (!item) return null;', 'if (!entry) return null;')
      .replace('return item.name;', 'return entry.name;');
    const inFormat = renamed.indexOf('return null;', renamed.indexOf('function format'));

    const located = reanchor(renamed, anchor);

    // Today: index is the `return null;` inside parse, a different function,
    // with nothing telling the reader the thread moved.
    expect(located).toEqual({ status: 'anchored', index: inFormat });
  });

  it('a block reindented by a formatter keeps a position in the file', () => {
    const anchor = selectionAnchor(source, '  const value = load(input);\n  if (!value) return null;');
    const reindented = source.replace(/\n {2}/g, '\n    ');

    const located = reanchor(reindented, anchor);

    // Today: `{ status: 'anchored', normalized: true }` with no index, so the
    // pin goes to the top of the file and says its passage is gone.
    expect(located.status).toBe('anchored');
    expect(located.status === 'anchored' ? located.index : undefined).toBe(
      reindented.indexOf('    const value = load(input);')
    );
  });

  it('a multi-line comment survives the file switching to CRLF line endings', () => {
    const anchor = selectionAnchor(source, '  const value = load(input);\n  if (!value) return null;');
    const crlf = source.replace(/\n/g, '\r\n');

    const located = reanchor(crlf, anchor);

    // Today: normalized match without an index, the same top-of-file pin.
    expect(located.status === 'anchored' ? located.index : undefined).toBe(crlf.indexOf('  const value = load(input);'));
  });
});
