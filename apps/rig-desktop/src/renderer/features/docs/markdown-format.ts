import { EditorSelection, type EditorState, type SelectionRange, type TransactionSpec } from '@codemirror/state';
import type { EditorView, KeyBinding } from '@codemirror/view';

/**
 * The formatting shortcuts people expect in an editor, written as Markdown:
 * Cmd-B bold, Cmd-I italic, Cmd-E code, Cmd-Shift-X strikethrough, Cmd-K
 * link. Each wraps the selection, or the word under the cursor, and the same
 * shortcut on text that already has it takes it off.
 */

export type InlineMark = 'bold' | 'italic' | 'code' | 'strike';

const MARKER: Record<InlineMark, string> = { bold: '**', italic: '*', code: '`', strike: '~~' };

const WORD = /[\p{L}\p{N}_'’-]/u;

/** The word around an empty cursor, or the range itself. */
function targetOf(state: EditorState, range: SelectionRange): { from: number; to: number } {
  if (!range.empty) return { from: range.from, to: range.to };
  const line = state.doc.lineAt(range.head);
  let from = range.head - line.from;
  let to = from;
  while (from > 0 && WORD.test(line.text[from - 1]!)) from--;
  while (to < line.text.length && WORD.test(line.text[to]!)) to++;
  return { from: line.from + from, to: line.from + to };
}

/** How many of `ch` sit right before `pos` and right after `end`, on the same line. */
function runAround(state: EditorState, from: number, to: number, ch: string): { before: number; after: number } {
  const line = state.doc.lineAt(from);
  let before = 0;
  while (from - before - 1 >= line.from && state.doc.sliceString(from - before - 1, from - before) === ch) before++;
  const endLine = state.doc.lineAt(to);
  let after = 0;
  while (to + after < endLine.to && state.doc.sliceString(to + after, to + after + 1) === ch) after++;
  return { before, after };
}

/** True when the text between `from` and `to` is already wrapped in `mark`. */
function isWrapped(state: EditorState, from: number, to: number, mark: InlineMark): boolean {
  const marker = MARKER[mark];
  if (mark === 'bold' || mark === 'italic') {
    // `*` and `**` share a character: count the run. Italic is an odd run, bold is two or more.
    const { before, after } = runAround(state, from, to, '*');
    const run = Math.min(before, after);
    return mark === 'bold' ? run >= 2 : run % 2 === 1;
  }
  return (
    state.doc.sliceString(from - marker.length, from) === marker &&
    state.doc.sliceString(to, to + marker.length) === marker
  );
}

export function toggleInline(state: EditorState, mark: InlineMark): TransactionSpec {
  const marker = MARKER[mark];
  const m = marker.length;
  return state.changeByRange((range) => {
    const { from, to } = targetOf(state, range);
    if (isWrapped(state, from, to, mark)) {
      const unwrapped = range.empty
        ? EditorSelection.cursor(range.head - m)
        : EditorSelection.range(range.anchor - m, range.head - m);
      return {
        changes: [
          { from: from - m, to: from },
          { from: to, to: to + m },
        ],
        range: unwrapped,
      };
    }
    if (from === to) {
      // Nothing to wrap: open the marks and type between them.
      return { changes: { from, insert: marker + marker }, range: EditorSelection.cursor(from + m) };
    }
    const wrapped = range.empty
      ? EditorSelection.cursor(range.head + m)
      : EditorSelection.range(range.anchor + m, range.head + m);
    return {
      changes: [
        { from, insert: marker },
        { from: to, insert: marker },
      ],
      range: wrapped,
    };
  });
}

/** Cmd-K: the selection becomes the link text and the cursor waits in the address. A selected address becomes the address. */
export function insertLink(state: EditorState): TransactionSpec {
  return state.changeByRange((range) => {
    const text = state.doc.sliceString(range.from, range.to);
    if (/^https?:\/\/\S+$/.test(text)) {
      return {
        changes: { from: range.from, to: range.to, insert: `[](${text})` },
        range: EditorSelection.cursor(range.from + 1),
      };
    }
    const insert = `[${text}]()`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: text ? EditorSelection.cursor(range.from + insert.length - 1) : EditorSelection.cursor(range.from + 1),
    };
  });
}

function run(spec: (state: EditorState) => TransactionSpec) {
  return (view: EditorView) => {
    view.dispatch(view.state.update(spec(view.state), { scrollIntoView: true, userEvent: 'input.format' }));
    return true;
  };
}

export const markdownFormatKeymap: readonly KeyBinding[] = [
  { key: 'Mod-b', preventDefault: true, run: run((s) => toggleInline(s, 'bold')) },
  { key: 'Mod-i', preventDefault: true, run: run((s) => toggleInline(s, 'italic')) },
  { key: 'Mod-e', preventDefault: true, run: run((s) => toggleInline(s, 'code')) },
  { key: 'Mod-Shift-x', preventDefault: true, run: run((s) => toggleInline(s, 'strike')) },
  { key: 'Mod-k', preventDefault: true, run: run(insertLink) },
];
