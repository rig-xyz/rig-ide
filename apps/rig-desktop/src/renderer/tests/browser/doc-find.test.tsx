import { openSearchPanel, setSearchQuery, SearchQuery, findNext } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { docFind } from '@renderer/features/docs/doc-find';

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

function mount(doc: string): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  view = new EditorView({ state: EditorState.create({ doc, extensions: [docFind] }), parent });
  return view;
}

describe('find in a file', () => {
  it('opens a find bar at the top, worded like Rig', () => {
    const v = mount('pricing tiers and more pricing');
    openSearchPanel(v);
    const panel = v.dom.querySelector('.cm-panels-top .cm-search');
    expect(panel).not.toBeNull();
    const buttons = [...panel!.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toEqual(expect.arrayContaining(['Next', 'Previous', 'All', 'Replace', 'Replace all']));
    expect(panel!.textContent).toContain('Whole word');
  });

  it('steps to the next match', () => {
    const v = mount('pricing tiers and more pricing');
    v.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'pricing' })) });
    findNext(v);
    expect(v.state.selection.main.from).toBe(0);
    findNext(v);
    expect(v.state.selection.main.from).toBe(23);
  });
});
