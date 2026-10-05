import { indentLess, indentMore } from '@codemirror/commands';
import type { ChangeSpec, EditorState, Line } from '@codemirror/state';
import type { EditorView, KeyBinding } from '@codemirror/view';

/**
 * Tab and Shift-Tab on Markdown list items: nest an item under the one above
 * it, or move it back out. A child item has to start where its parent's text
 * starts, so the indent follows the parent's marker: two spaces under "- ",
 * three under "1. ". Lines that aren't list items are left to the browser,
 * so Tab in a paragraph still moves focus out of the editor.
 */

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])(\s+)/;

type ListLine = { indent: number; contentStart: number };

function listLine(line: Line): ListLine | null {
  const m = LIST_ITEM.exec(line.text);
  if (!m) return null;
  return { indent: m[1]!.length, contentStart: m[0]!.length };
}

/** The nearest list item above `line` whose indent satisfies `accept`, stopping at a blank line. */
function itemAbove(state: EditorState, line: Line, accept: (item: ListLine) => boolean): ListLine | null {
  for (let n = line.number - 1; n >= 1; n--) {
    const above = state.doc.line(n);
    if (above.text.trim() === '') return null;
    const item = listLine(above);
    if (item && accept(item)) return item;
  }
  return null;
}

function selectedLines(state: EditorState): Line[] {
  const seen = new Set<number>();
  const lines: Line[] = [];
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      lines.push(state.doc.line(n));
    }
  }
  return lines;
}

/** The changes for Tab (`dir` 1) or Shift-Tab (`dir` -1), or null when no selected line is a list item. */
export function listIndentChanges(state: EditorState, dir: 1 | -1): ChangeSpec[] | null {
  const changes: ChangeSpec[] = [];
  let anyItem = false;
  for (const line of selectedLines(state)) {
    const item = listLine(line);
    if (!item) continue;
    anyItem = true;
    let target: number;
    if (dir === 1) {
      // Under the item above at this level or shallower: start where its text starts.
      // The first item of a list has nothing to nest under.
      const parent = itemAbove(state, line, (above) => above.indent <= item.indent);
      if (!parent || parent.contentStart <= item.indent) continue;
      target = parent.contentStart;
    } else {
      if (item.indent === 0) continue;
      // Back to the parent's own level.
      const parent = itemAbove(state, line, (above) => above.indent < item.indent);
      target = parent ? parent.indent : 0;
    }
    if (target === item.indent) continue;
    changes.push(
      target > item.indent
        ? { from: line.from, insert: ' '.repeat(target - item.indent) }
        : { from: line.from, to: line.from + (item.indent - target) }
    );
  }
  return anyItem ? changes : null;
}

function runListIndent(dir: 1 | -1) {
  return (view: EditorView) => {
    const changes = listIndentChanges(view.state, dir);
    if (changes === null) return false;
    if (changes.length > 0) {
      view.dispatch(view.state.update({ changes, scrollIntoView: true, userEvent: 'input.indent' }));
    }
    // A list line that can't move further still keeps Tab in the editor.
    return true;
  };
}

/** Markdown: Tab and Shift-Tab nest and un-nest list items. */
export const markdownListIndentKeymap: readonly KeyBinding[] = [
  { key: 'Tab', run: runListIndent(1), shift: runListIndent(-1) },
];

/** Code files: Tab and Shift-Tab indent and outdent the selected lines, as in any code editor. */
export const codeIndentKeymap: readonly KeyBinding[] = [{ key: 'Tab', run: indentMore, shift: indentLess }];
