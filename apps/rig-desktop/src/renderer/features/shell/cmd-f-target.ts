import { createContext } from 'react';
import type { RigLayout } from './layout-switcher';
import type { FocusedRigPane } from './native-close-target';

/**
 * Cmd-F goes to the pane you're in: a space's chat searches its chat, a doc
 * finds in the doc (CodeMirror's panel while editing, the reading view's own
 * find bar while reading). Both handlers ask `cmdFTarget` the same question
 * and act only on their own answer, so one key press never opens both.
 */

export type CmdFTarget = 'chat-search' | 'doc-editor' | 'doc-reading' | null;

/** Where the key press landed: inside a pane, on the page itself (nothing focused), or somewhere else (a sheet, a dialog). */
export type CmdFFocus = FocusedRigPane | 'page' | 'other';

export function cmdFTarget({
  layout,
  lastPane,
  focus,
  editorFocused,
  previewOpen,
}: {
  layout: RigLayout;
  /** The pane the person last clicked or focused in. */
  lastPane: FocusedRigPane;
  focus: CmdFFocus;
  /** Focus is in a doc's CodeMirror editor: its own keymap answers. */
  editorFocused: boolean;
  /** The doc shows its rendered reading view, not the editor. */
  previewOpen: boolean;
}): CmdFTarget {
  // A settings sheet or a dialog: neither pane's find belongs there.
  if (focus === 'other') return null;
  if (editorFocused) return 'doc-editor';
  const pane: FocusedRigPane =
    layout === 'chat'
      ? 'chat'
      : layout === 'files'
        ? 'artifact'
        : focus === 'page'
          ? lastPane
          : focus;
  if (pane === 'chat') return 'chat-search';
  return previewOpen ? 'doc-reading' : 'doc-editor';
}

/** Marks App's two panes (`data-rig-pane="chat"` and `"artifact"`), so a key press can say which one it landed in. */
export const RIG_PANE_ATTR = 'data-rig-pane';

/** Which pane `target` sits in. `own` is the asking handler's own pane, counted even outside App. */
export function focusOf(
  target: EventTarget | null,
  own: { root: Element | null; pane: FocusedRigPane }
): CmdFFocus {
  if (
    !(target instanceof Element) ||
    target === document.body ||
    target === document.documentElement
  )
    return 'page';
  if (own.root?.contains(target)) return own.pane;
  const pane = target.closest(`[${RIG_PANE_ATTR}]`)?.getAttribute(RIG_PANE_ATTR);
  return pane === 'chat' || pane === 'artifact' ? pane : 'other';
}

/** Cmd-F (Ctrl-F), nothing else held. */
export function isCmdF(event: KeyboardEvent): boolean {
  return (
    !event.altKey &&
    !event.shiftKey &&
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === 'f'
  );
}

/** The layout and the last pane touched, read at key-press time. Null outside App (a pane on its own). */
export type CmdFRoute = { layout: RigLayout; lastPane: FocusedRigPane };
export const CmdFRouteContext = createContext<(() => CmdFRoute) | null>(null);
