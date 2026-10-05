import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { listIndentChanges } from './markdown-list-indent';

function apply(doc: string, cursorLine: number, dir: 1 | -1, toLine?: number): string | null {
  let state = EditorState.create({ doc, extensions: [EditorState.allowMultipleSelections.of(true)] });
  const from = state.doc.line(cursorLine).from + 2;
  const to = toLine ? state.doc.line(toLine).from + 2 : from;
  state = state.update({ selection: EditorSelection.single(from, to) }).state;
  const changes = listIndentChanges(state, dir);
  if (changes === null) return null;
  return state.update({ changes }).state.doc.toString();
}

describe('listIndentChanges', () => {
  it('nests a bullet under the item above, at its text', () => {
    expect(apply('- a\n- b', 2, 1)).toBe('- a\n  - b');
  });

  it('nests under a numbered item at three spaces', () => {
    expect(apply('1. a\n2. b', 2, 1)).toBe('1. a\n   2. b');
  });

  it('nests one level deeper under a sibling that is already nested', () => {
    expect(apply('- a\n  - b\n  - c', 3, 1)).toBe('- a\n  - b\n    - c');
  });

  it('leaves the first item, and an item already as deep as it can go', () => {
    expect(apply('- a\n- b', 1, 1)).toBe('- a\n- b');
    expect(apply('- a\n  - b', 2, 1)).toBe('- a\n  - b');
  });

  it('Shift-Tab moves an item back to its parent level', () => {
    expect(apply('- a\n  - b\n    - c', 3, -1)).toBe('- a\n  - b\n  - c');
    expect(apply('- a\n  - b', 2, -1)).toBe('- a\n- b');
  });

  it('indents every selected item', () => {
    expect(apply('- a\n- b\n- c', 2, 1, 3)).toBe('- a\n  - b\n  - c');
  });

  it('is not for lines that are not list items, so Tab keeps its usual meaning there', () => {
    expect(apply('Greet the user by name', 1, 1)).toBeNull();
  });

  it('does not reach past a blank line for a parent', () => {
    expect(apply('- a\n\n- b', 3, 1)).toBe('- a\n\n- b');
  });
});
