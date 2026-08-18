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
 */

export type ArtifactPanelState =
  | { view: 'browser'; revealPath: string | null }
  | { view: 'file'; path: string };

export const BROWSER_STATE: ArtifactPanelState = { view: 'browser', revealPath: null };

export function pushFile(path: string): ArtifactPanelState {
  return { view: 'file', path };
}

export function popToBrowser(revealPath: string | null = null): ArtifactPanelState {
  return { view: 'browser', revealPath };
}

export function isFileView(
  state: ArtifactPanelState
): state is Extract<ArtifactPanelState, { view: 'file' }> {
  return state.view === 'file';
}
