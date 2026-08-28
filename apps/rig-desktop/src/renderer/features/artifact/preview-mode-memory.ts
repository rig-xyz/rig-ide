/**
 * Per-file Preview ⇄ Edit mode memory (`preview-mode-spec.md`'s open
 * question, resolved for v1): session-only, in-memory, keyed by absolute
 * path. A rig-doing-work power user who flips a file to Edit once stays
 * there for the rest of the session, but nothing survives an app restart —
 * deliberately not app-DB-backed, since view mode is a reading preference
 * for right now, not document state.
 *
 * A bare module-level `Map` rather than a class: `EditableArtifactPane`
 * remounts per open file (`key={path}` up the tree), so this has to outlive
 * the component to mean anything.
 */

export type PreviewMode = 'preview' | 'edit';

const modeByPath = new Map<string, PreviewMode>();

/** Preview is the default for a markdown file this session hasn't recorded a choice for yet. */
export function getPreviewMode(path: string): PreviewMode {
  return modeByPath.get(path) ?? 'preview';
}

export function setPreviewMode(path: string, mode: PreviewMode): void {
  modeByPath.set(path, mode);
}

/**
 * Test-only: the Map above is module state, so without this a test that
 * toggles a file to Edit silently changes which mode every LATER test's
 * cold open starts in — an order dependence that reads as flake.
 */
export function resetPreviewModeMemoryForTests(): void {
  modeByPath.clear();
}
