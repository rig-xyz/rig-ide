import type { RigLayout } from './layout-switcher';

export type NativeCloseTarget = 'settings' | 'artifact' | 'chat' | null;
export type FocusedRigPane = 'chat' | 'artifact';

/**
 * Cmd-W follows the visible/focused tab system. Settings takes precedence;
 * a split uses the last pane the user touched; single-pane layouts are
 * unambiguous. Fallbacks keep a stale focus marker from creating a dead key.
 */
export function deriveNativeCloseTarget({
  settingsOpen,
  hasRig,
  layout,
  focusedPane,
  hasArtifactTab,
  hasChatTab,
}: {
  settingsOpen: boolean;
  hasRig: boolean;
  layout: RigLayout;
  focusedPane: FocusedRigPane;
  hasArtifactTab: boolean;
  hasChatTab: boolean;
}): NativeCloseTarget {
  if (settingsOpen) return 'settings';
  if (!hasRig) return null;
  if (layout === 'chat') return hasChatTab ? 'chat' : null;
  if (layout === 'files') return hasArtifactTab ? 'artifact' : null;
  if (focusedPane === 'artifact' && hasArtifactTab) return 'artifact';
  if (focusedPane === 'chat' && hasChatTab) return 'chat';
  if (hasArtifactTab) return 'artifact';
  return hasChatTab ? 'chat' : null;
}
