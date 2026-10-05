import { search, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

/**
 * Find and replace in a file: Cmd-F opens a bar at the top of the editor,
 * Enter and Shift-Enter step through matches, Cmd-G and Shift-Cmd-G too,
 * Esc closes it. CodeMirror's own search panel, worded and styled like the
 * rest of Rig.
 */

const findPhrases = EditorState.phrases.of({
  Find: 'Find',
  Replace: 'Replace',
  next: 'Next',
  previous: 'Previous',
  all: 'All',
  'match case': 'Match case',
  regexp: 'Regex',
  'by word': 'Whole word',
  replace: 'Replace',
  'replace all': 'Replace all',
  close: 'Close',
  'current match': 'current match',
  'on line': 'on line',
});

const findTheme = EditorView.theme({
  '.cm-panels': {
    backgroundColor: 'var(--bg-1)',
    color: 'var(--text-primary)',
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border-hairline)' },
  '.cm-search': {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '6px',
    padding: '8px 12px',
    fontFamily: 'inherit',
    fontSize: '12px',
  },
  '.cm-search br': { flexBasis: '100%', height: '0' },
  '.cm-search .cm-textfield': {
    height: '26px',
    minWidth: '200px',
    padding: '0 8px',
    margin: '0',
    borderRadius: '6px',
    border: '1px solid var(--border-hairline)',
    backgroundColor: 'var(--bg-0)',
    color: 'var(--text-primary)',
    fontSize: '12px',
    outline: 'none',
  },
  '.cm-search .cm-textfield:focus': { borderColor: 'var(--border-strong)' },
  '.cm-search .cm-button': {
    height: '26px',
    padding: '0 10px',
    margin: '0',
    borderRadius: '6px',
    border: '1px solid var(--border-hairline)',
    backgroundImage: 'none',
    backgroundColor: 'transparent',
    color: 'var(--text-secondary)',
    fontSize: '12px',
    cursor: 'pointer',
  },
  '.cm-search .cm-button:hover': { backgroundColor: 'var(--bg-2)', color: 'var(--text-primary)' },
  '.cm-search label': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    margin: '0 2px',
    color: 'var(--text-muted)',
    fontSize: '12px',
    cursor: 'pointer',
  },
  '.cm-search input[type=checkbox]': { margin: '0', accentColor: 'var(--accent)' },
  '.cm-search button[name=close]': {
    marginLeft: 'auto',
    border: 'none',
    background: 'transparent',
    color: 'var(--text-muted)',
    fontSize: '16px',
    cursor: 'pointer',
  },
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in oklab, var(--accent) 18%, transparent)',
    borderRadius: '2px',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in oklab, var(--accent) 40%, transparent)',
  },
});

export const docFind: Extension = [search({ top: true }), keymap.of(searchKeymap), findPhrases, findTheme];
