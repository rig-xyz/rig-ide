/**
 * Explicit two-level nav state for the artifact panel: the root file
 * navigator, or one open file pushed in front of it. No router dependency —
 * see `App.tsx`'s `WorkspaceScreen` for where this is driven from (the back
 * chevron, breadcrumb segments, and Esc all call `popToBrowser`).
 *
 * `revealPath` is one-shot targeting for the navigator — set when a folder
 * breadcrumb segment is clicked so `FileTree` can expand ancestors and
 * scroll that folder into view, cleared (implicitly, by every other
 * `popToBrowser` caller passing none) once consumed.
 *
 * File-navigator redesign (§3, card rail): a `'file'` state can ALSO carry
 * a `revealPath` now — set when a card rail click opens a file (`pushFile`'s
 * second argument), so it can do both halves of "open AND reveal-highlight
 * in the tree" even though those two views are mutually exclusive panels.
 * The reveal simply waits: `App.tsx`'s `backToBrowser`/Esc handler carries
 * a `'file'` state's own `revealPath` forward into the `popToBrowser` call
 * that follows it, so the tree reveals the instant the user actually lands
 * back on it. A plain tree-row or breadcrumb open (`pushFile(path)`, no
 * second argument) carries none, same as before.
 */

export type ArtifactPanelState =
  | { view: 'browser'; revealPath: string | null }
  | { view: 'file'; path: string; revealPath: string | null };

export const BROWSER_STATE: ArtifactPanelState = { view: 'browser', revealPath: null };

export function pushFile(path: string, revealPath: string | null = null): ArtifactPanelState {
  return { view: 'file', path, revealPath };
}

export function popToBrowser(revealPath: string | null = null): ArtifactPanelState {
  return { view: 'browser', revealPath };
}

export function isFileView(
  state: ArtifactPanelState
): state is Extract<ArtifactPanelState, { view: 'file' }> {
  return state.view === 'file';
}
