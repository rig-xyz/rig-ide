import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { insertLink, toggleInline, type InlineMark } from './markdown-format';

/** `|` marks the cursor, `[` `]` a selection. Returns the result in the same notation. */
function run(input: string, fn: (s: EditorState) => ReturnType<typeof insertLink>): string {
  const anchor = input.includes('[') ? input.indexOf('[') : input.indexOf('|');
  const doc = input.replace(/[[\]|]/g, '');
  const head = input.includes(']') ? input.indexOf(']') - 1 : anchor;
  let state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head) });
  state = state.update(fn(state)).state;
  const sel = state.selection.main;
  const text = state.doc.toString();
  if (sel.empty) return text.slice(0, sel.head) + '|' + text.slice(sel.head);
  return text.slice(0, sel.from) + '[' + text.slice(sel.from, sel.to) + ']' + text.slice(sel.to);
}

const toggle = (mark: InlineMark) => (s: EditorState) => toggleInline(s, mark);

describe('toggleInline', () => {
  it('wraps a selection and keeps it selected', () => {
    expect(run('say [hello] there', toggle('bold'))).toBe('say **[hello]** there');
    expect(run('say [hello] there', toggle('italic'))).toBe('say *[hello]* there');
    expect(run('run [npm test] now', toggle('code'))).toBe('run `[npm test]` now');
    expect(run('[old]', toggle('strike'))).toBe('~~[old]~~');
  });

  it('takes the mark off when it is already there', () => {
    expect(run('say **[hello]** there', toggle('bold'))).toBe('say [hello] there');
    expect(run('say *[hello]* there', toggle('italic'))).toBe('say [hello] there');
  });

  it('tells italic from bold although both use stars', () => {
    expect(run('**[hello]**', toggle('italic'))).toBe('***[hello]***');
    expect(run('***[hello]***', toggle('italic'))).toBe('**[hello]**');
    expect(run('***[hello]***', toggle('bold'))).toBe('*[hello]*');
  });

  it('formats the word under the cursor', () => {
    expect(run('say hel|lo there', toggle('bold'))).toBe('say **hel|lo** there');
    expect(run('say **hel|lo** there', toggle('bold'))).toBe('say hel|lo there');
  });

  it('opens the marks to type between them where there is no word', () => {
    expect(run('say | there', toggle('bold'))).toBe('say **|** there');
  });
});

describe('insertLink', () => {
  it('makes the selection the link text and waits in the address', () => {
    expect(run('see [the docs] here', insertLink)).toBe('see [the docs](|) here');
  });

  it('makes a selected address the address and waits in the text', () => {
    expect(run('[https://userig.xyz]', insertLink)).toBe('[|](https://userig.xyz)');
  });

  it('with nothing selected, waits in the text', () => {
    expect(run('go |', insertLink)).toBe('go [|]()');
  });
});
